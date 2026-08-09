/**
 * `orch_delegate` : lance une tâche chez un sous-agent et rend son `taskId`
 * immédiatement, sans attendre la fin de l'exécution — voir le brief de la
 * tâche 7.
 *
 * L'assemblage (charger la configuration, résoudre le rôle puis l'agent,
 * vérifier la politique, calculer mode/isolation/timeout/contexte) reproduit
 * fidèlement celui de `orch run` (`packages/cli/src/commands/run.ts`), pour
 * les mêmes règles de repli (`--agent` l'emporte sur `--role`, mais un rôle
 * fourni reste résolu pour ses valeurs par défaut même quand `agent` est
 * explicite). Cette duplication est délibérément signalée dans le rapport de
 * la tâche 7 plutôt que résolue en silence : les deux façades (CLI, MCP)
 * gagneraient sans doute à partager un seul point d'assemblage dans
 * `@orch/core`, mais ce n'est pas une décision qui relève de cette tâche.
 *
 * Le champ `isolation` rendu est celui effectivement transmis à `runTask`
 * après résolution des couches de configuration (entrée explicite > rôle >
 * politique projet) — pas la résolution finale "auto" → "inplace"/"worktree"
 * que `runTask` effectue en interne : cette dernière dépend de l'état du
 * dépôt git et d'une préparation d'isolation potentiellement non instantanée
 * (création d'un worktree), qu'`orch_delegate` ne peut pas attendre sans
 * rouvrir la promesse de non-blocage que ce tool porte. `orch_status`/
 * `orch_await`, une fois la tâche connue du store, rendent l'isolation
 * réellement retenue.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedRole, RunTaskInput } from "@orch/core";
import {
  checkDelegation,
  findAgentDefinition,
  findBinaryInPath,
  generateTaskId,
  loadConfig,
  parseDuration,
  pickAgentForRole,
  resolveRole,
} from "@orch/core";
import type { Isolation, TaskMode } from "@orch/protocol";
import { launchTask } from "../session.js";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const ORCH_DELEGATE = "orch_delegate";

export const orchDelegateDescription =
  "Delegate an objective to a sub-agent (codex, antigravity, opencode, copilot, or claude) running as a " +
  "separate CLI process, in read-only or write mode, optionally isolated on a disposable git worktree. " +
  "This call returns immediately — as soon as the agent is resolved and the delegation is approved by policy " +
  "— with a task_id; it does NOT wait for the sub-agent to finish, which can take from seconds to the " +
  "configured timeout (minutes). The task is still running when this returns: you MUST call orch_await with " +
  "the returned task_id to get the actual result. To run several providers on the same objective in parallel, " +
  "call orch_delegate repeatedly back to back, then a single orch_await with every task_id — that is the whole " +
  "point of this call not blocking. A policy refusal or an unknown role/agent is reported as an error result " +
  "instead of a task_id.";

export const orchDelegateInputShape = {
  objective: z
    .string()
    .min(1)
    .describe("The task for the sub-agent, as a clear, self-contained instruction — it has no access to this conversation."),
  role: z
    .string()
    .optional()
    .describe(
      "Name of a configured role (see orch_list_roles) used to pick an agent automatically along its fallback " +
        "chain, and to fill in defaults for mode/isolation/timeout/system prompt. Ignored for the agent choice " +
        "when `agent` is also given, but its defaults still apply.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "Explicit provider id (see orch_list_agents), e.g. \"codex\", \"antigravity\", \"opencode\", \"copilot\", " +
        "\"claude\". Takes precedence over the agent that `role` would have picked. One of `role` or `agent` is required.",
    ),
  mode: z
    .enum(["read-only", "write"])
    .optional()
    .describe(
      "\"read-only\" forbids the agent from changing files (for review/investigation); \"write\" allows edits. " +
        "Defaults to the role's mode, then the project policy's default.",
    ),
  isolation: z
    .enum(["inplace", "worktree", "auto"])
    .optional()
    .describe(
      "\"worktree\" runs the agent on a disposable git branch so its changes can be inspected with orch_diff and " +
        "landed with orch_apply instead of touching the workspace directly; \"inplace\" runs directly in the " +
        "workspace; \"auto\" (default) picks based on mode and git availability.",
    ),
  context: z
    .string()
    .optional()
    .describe("Freeform background the sub-agent needs — relevant code, prior findings, links. Inline the content, not a file path."),
  constraints: z.array(z.string()).optional().describe("Explicit dos and don'ts the sub-agent must respect."),
  acceptance_criteria: z.array(z.string()).optional().describe("How to judge the task successful; included in the sub-agent's brief."),
  model: z.string().optional().describe("Model to request from the provider, if it supports choosing one."),
  timeout: z
    .string()
    .optional()
    .describe("Maximum time budget before the task is aborted, e.g. \"10m\", \"90s\", \"1h\". Defaults to the role's or policy's timeout."),
};

const OrchDelegateInputSchema = z.object(orchDelegateInputShape);
export type OrchDelegateInput = z.infer<typeof OrchDelegateInputSchema>;

export async function orchDelegate(session: McpSession, input: OrchDelegateInput): Promise<CallToolResult> {
  if (!input.agent && !input.role) {
    return errorResult('Préciser "agent" ou "role".');
  }

  const { config } = await loadConfig(session.root);

  let role: ResolvedRole | null = null;
  if (input.role) {
    role = await resolveRole(config, session.root, input.role);
    if (!role) return errorResult(`Rôle inconnu : "${input.role}".`);
  }

  let agentId: string;
  if (input.agent) {
    agentId = input.agent;
  } else if (role) {
    const installed = new Map<string, boolean>();
    await Promise.all(
      role.agents.map(async (id) => {
        const def = findAgentDefinition(id);
        installed.set(id, def ? (await findBinaryInPath(def.bin)) !== null : false);
      }),
    );
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    if ("error" in pick) return errorResult(pick.error);
    agentId = pick.agentId;
  } else {
    // Inatteignable : la garde en tête de fonction exige déjà l'un des deux.
    return errorResult('Préciser "agent" ou "role".');
  }

  if (!findAgentDefinition(agentId)) {
    return errorResult(`Agent inconnu : "${agentId}".`);
  }

  const decision = checkDelegation(config.policy, { agentId, depth: 0 });
  if (!decision.allowed) {
    // Motif rendu tel quel par @orch/core — voir le brief.
    return errorResult(decision.reason);
  }

  const mode: TaskMode = input.mode ?? role?.mode ?? config.policy.default_mode;
  const isolation: Isolation | "auto" = input.isolation ?? role?.isolation ?? config.policy.default_isolation;

  let timeoutMs: number;
  try {
    timeoutMs = input.timeout ? parseDuration(input.timeout) : (role?.timeout_ms ?? config.policy.default_timeout_ms);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  let context = input.context;
  if (role?.systemPrompt) {
    context = [role.systemPrompt, context].filter((part) => part && part.trim() !== "").join("\n\n---\n\n");
  }

  const taskId = generateTaskId();
  const controller = new AbortController();

  const runInput: RunTaskInput & { taskId: string } = {
    agentId,
    objective: input.objective,
    ...(context !== undefined ? { context } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
    ...(input.acceptance_criteria ? { acceptance_criteria: input.acceptance_criteria } : {}),
    mode,
    isolation,
    workspace: session.root,
    ...(input.role ? { role: input.role } : {}),
    ...(input.model ? { model: input.model } : {}),
    timeoutMs,
    taskId,
    signal: controller.signal,
  };
  launchTask(session, runInput, controller);

  return jsonResult({ task_id: taskId, agent: agentId, mode, isolation, status: "running" });
}

export function registerOrchDelegate(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_DELEGATE, { description: orchDelegateDescription, inputSchema: orchDelegateInputShape }, (args) =>
    orchDelegate(session, args),
  );
}
