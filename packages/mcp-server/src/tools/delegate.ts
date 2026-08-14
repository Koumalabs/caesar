/**
 * `caesar_delegate` : lance une tâche chez un sous-agent et rend son `taskId`
 * immédiatement, sans attendre la fin de l'exécution — voir le brief de la
 * tâche 7.
 *
 * L'assemblage (charger la configuration, résoudre le rôle puis l'agent,
 * vérifier la politique, calculer mode/isolation/timeout/contexte) est
 * délégué à `resolveDelegation` (`@caesar/core`), le point d'assemblage partagé
 * avec `caesar run` (`packages/cli/src/commands/run.ts`) — voir son en-tête
 * et le rapport de correction de la tâche 7 : les deux façades appliquaient
 * jusqu'ici la même règle en deux endroits distincts.
 *
 * Le champ `isolation` rendu est celui que `resolveDelegation` a résolu à
 * partir des couches de configuration (entrée explicite > rôle > politique
 * projet) — pas la résolution finale "auto" → "inplace"/"worktree" que
 * `runTask` effectue en interne : cette dernière dépend de l'état du dépôt
 * git et d'une préparation d'isolation potentiellement non instantanée
 * (création d'un worktree), que `caesar_delegate` ne peut pas attendre sans
 * rouvrir la promesse de non-blocage que ce tool porte. `caesar_status`/
 * `caesar_await`, une fois la tâche connue du store, rendent l'isolation
 * réellement retenue.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunTaskInput } from "@caesar/core";
import { describeWorkspaceMismatch, generateTaskId, loadConfig, nextDelegationDepth, resolveDelegation } from "@caesar/core";
import { launchTask } from "../session.js";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_DELEGATE = "caesar_delegate";

export const caesarDelegateDescription =
  "Delegate an objective to a sub-agent (codex, antigravity, opencode, copilot, or claude) running as a " +
  "separate CLI process, in read-only or write mode, optionally isolated on a disposable git worktree. " +
  "This call returns immediately — as soon as the agent is resolved and the delegation is approved by policy " +
  "— with a task_id; it does NOT wait for the sub-agent to finish, which can take from seconds to the " +
  "configured timeout (minutes). The task is still running when this returns: you MUST call caesar_await with " +
  "the returned task_id to get the actual result. To run several providers on the same objective in parallel, " +
  "call caesar_delegate repeatedly back to back, then a single caesar_await with every task_id — that is the whole " +
  "point of this call not blocking. A policy refusal or an unknown role/agent is reported as an error result " +
  "instead of a task_id. Pass channel: true to let the sub-agent ask you questions mid-run instead of guessing " +
  "(see the channel parameter for how to answer them).";

export const caesarDelegateInputShape = {
  objective: z
    .string()
    .min(1)
    .describe("The task for the sub-agent, as a clear, self-contained instruction — it has no access to this conversation."),
  role: z
    .string()
    .optional()
    .describe(
      "Name of a configured role (see caesar_list_roles) used to pick an agent automatically along its fallback " +
        "chain, and to fill in defaults for mode/isolation/timeout/system prompt. Ignored for the agent choice " +
        "when `agent` is also given, but its defaults still apply.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "Explicit provider id (see caesar_list_agents), e.g. \"codex\", \"antigravity\", \"opencode\", \"copilot\", " +
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
      "\"worktree\" runs the agent in its own workshop — a disposable git branch, complete with the untracked files " +
        "the project declares under [worktree] (dependencies, .env) and its setup commands already run, so the agent " +
        "can install, run and test there. Its work is inspected with caesar_diff and landed with caesar_apply instead of " +
        "touching the workspace directly. \"auto\" (default) picks based on mode and git availability, and already " +
        "chooses worktree for write tasks in a git repository — prefer it. \"inplace\" runs directly in the user's " +
        "working tree and is REFUSED for write tasks in a usable git repository unless the project opted in with " +
        "policy.allow_inplace_write; if the worktree seems incomplete, the fix is to declare the missing paths under " +
        "[worktree] in .caesar/config.toml, never to fall back to \"inplace\".",
    ),
  network: z
    .enum(["auto", "on", "off"])
    .optional()
    .describe(
      "Whether the sub-agent needs network access — installing packages, cloning a repository, fetching a URL. " +
        "\"auto\" (default) opens it wherever the chosen agent allows it and reports a warning where it cannot; " +
        "\"on\" demands it, and **fails the delegation outright** when the agent cannot provide it, with the reason " +
        "and the remedy — notably codex, whose sandbox cuts the network in read-only mode and can only open it " +
        "under `--mode write`; \"off\" closes it where caesar knows how. Prefer \"on\" when the objective is " +
        "impossible without network: a clear refusal beats a sub-agent burning its whole budget on a failing install.",
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
  channel: z
    .boolean()
    .optional()
    .describe(
      "Enable the MCP back-channel for this task, if the chosen agent supports loading an MCP server. With it, " +
        "the sub-agent can call ask_orchestrator to ask you a question mid-run instead of guessing or giving up " +
        "in status \"blocked\" — discover pending questions via caesar_status/caesar_await (pending_questions) and " +
        "answer them with caesar_answer while the task keeps running. Off by default: it adds a process and a " +
        "configuration injection to every delegation, so it is opt-in rather than automatic.",
    ),
};

const CaesarDelegateInputSchema = z.object(caesarDelegateInputShape);
export type CaesarDelegateInput = z.infer<typeof CaesarDelegateInputSchema>;

export async function caesarDelegate(session: McpSession, input: CaesarDelegateInput): Promise<CallToolResult> {
  const { config } = await loadConfig(session.root);

  // Profondeur héritée de `$CAESAR_DEPTH` (+1) : voir C4 de la revue finale. Un
  // serveur MCP peut lui-même tourner comme sous-agent (`caesar mcp install`
  // l'enregistre globalement chez plusieurs clients — voir I4/le constat
  // "aggravant" de C4) : sans relire cette variable, `max_depth` et le
  // garde-fou anti-récursion ne s'appliquaient qu'au premier niveau.
  const depth = nextDelegationDepth();

  const resolved = await resolveDelegation(config, session.root, {
    role: input.role,
    agent: input.agent,
    mode: input.mode,
    isolation: input.isolation,
    network: input.network,
    context: input.context,
    timeout: input.timeout,
    depth,
  });
  if ("error" in resolved) {
    // Motif rendu tel quel par @caesar/core — voir le brief.
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
    allowInplaceWrite: resolved.allowInplaceWrite,
    network: resolved.network,
    ...(resolved.networkWarning !== undefined ? { networkWarning: resolved.networkWarning } : {}),
    workspace: session.root,
    ...(resolved.role ? { role: resolved.role } : {}),
    ...(input.model ? { model: input.model } : {}),
    timeoutMs: resolved.timeoutMs,
    depth,
    extraAgents: config.agents,
    worktreeSetup: config.worktree,
    taskId,
    signal: controller.signal,
    ...(input.channel ? { channel: true } : {}),
  };
  launchTask(session, runInput, controller);

  // Le décalage de racine, dit au moment où il compte. `caesar mcp install` fige
  // `--root` une fois pour toutes : si l'agent principal est passé dans un
  // worktree depuis, les sous-agents travaillent dans un arbre que plus
  // personne ne regarde. Un avertissement plutôt qu'un refus — le répertoire
  // courant du serveur n'est pas une preuve de l'intention de l'appelant, et
  // faire échouer la délégation sur cette base coûterait plus qu'elle ne
  // rapporte.
  const workspaceWarning = await describeWorkspaceMismatch(session.root, process.cwd());

  return jsonResult({
    task_id: taskId,
    agent: resolved.agentId,
    mode: resolved.mode,
    isolation: resolved.isolation,
    // Rendu explicitement : sans lui, rien dans la réponse ne dit *où* le
    // sous-agent travaille, et le décalage ci-dessous serait invérifiable.
    workspace: session.root,
    ...(workspaceWarning !== null ? { workspace_warning: workspaceWarning } : {}),
    // Rendu dès le lancement, et non seulement dans le rapport final :
    // l'orchestrateur peut ainsi reformuler l'objectif ou changer d'agent
    // avant que le sous-agent n'ait dépensé son budget.
    network: resolved.network,
    ...(resolved.networkWarning !== undefined ? { network_warning: resolved.networkWarning } : {}),
    status: "running",
  });
}

export function registerCaesarDelegate(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_DELEGATE, { description: caesarDelegateDescription, inputSchema: caesarDelegateInputShape }, (args) =>
    caesarDelegate(session, args),
  );
}
