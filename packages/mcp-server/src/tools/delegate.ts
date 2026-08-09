/**
 * `orch_delegate` : lance une tâche chez un sous-agent et rend son `taskId`
 * immédiatement, sans attendre la fin de l'exécution — voir le brief de la
 * tâche 7.
 *
 * L'assemblage (charger la configuration, résoudre le rôle puis l'agent,
 * vérifier la politique, calculer mode/isolation/timeout/contexte) est
 * délégué à `resolveDelegation` (`@orch/core`), le point d'assemblage partagé
 * avec `orch run` (`packages/cli/src/commands/run.ts`) — voir son en-tête
 * et le rapport de correction de la tâche 7 : les deux façades appliquaient
 * jusqu'ici la même règle en deux endroits distincts.
 *
 * Le champ `isolation` rendu est celui que `resolveDelegation` a résolu à
 * partir des couches de configuration (entrée explicite > rôle > politique
 * projet) — pas la résolution finale "auto" → "inplace"/"worktree" que
 * `runTask` effectue en interne : cette dernière dépend de l'état du dépôt
 * git et d'une préparation d'isolation potentiellement non instantanée
 * (création d'un worktree), qu'`orch_delegate` ne peut pas attendre sans
 * rouvrir la promesse de non-blocage que ce tool porte. `orch_status`/
 * `orch_await`, une fois la tâche connue du store, rendent l'isolation
 * réellement retenue.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunTaskInput } from "@orch/core";
import { generateTaskId, loadConfig, resolveDelegation } from "@orch/core";
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
  const { config } = await loadConfig(session.root);

  const resolved = await resolveDelegation(config, session.root, {
    role: input.role,
    agent: input.agent,
    mode: input.mode,
    isolation: input.isolation,
    context: input.context,
    timeout: input.timeout,
  });
  if ("error" in resolved) {
    // Motif rendu tel quel par @orch/core — voir le brief.
    return errorResult(resolved.error);
  }

  const taskId = generateTaskId();
  const controller = new AbortController();

  const runInput: RunTaskInput & { taskId: string } = {
    agentId: resolved.agentId,
    objective: input.objective,
    ...(resolved.context !== undefined ? { context: resolved.context } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
    ...(input.acceptance_criteria ? { acceptance_criteria: input.acceptance_criteria } : {}),
    mode: resolved.mode,
    isolation: resolved.isolation,
    workspace: session.root,
    ...(resolved.role ? { role: resolved.role } : {}),
    ...(input.model ? { model: input.model } : {}),
    timeoutMs: resolved.timeoutMs,
    taskId,
    signal: controller.signal,
  };
  launchTask(session, runInput, controller);

  return jsonResult({ task_id: taskId, agent: resolved.agentId, mode: resolved.mode, isolation: resolved.isolation, status: "running" });
}

export function registerOrchDelegate(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_DELEGATE, { description: orchDelegateDescription, inputSchema: orchDelegateInputShape }, (args) =>
    orchDelegate(session, args),
  );
}
