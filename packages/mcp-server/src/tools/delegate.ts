/**
 * `caesar_delegate`: starts a task on a subagent and returns its `taskId`
 * immediately, without waiting for the run to finish — see the task 7
 * brief.
 *
 * The assembly (loading the configuration, resolving the role then the
 * agent, checking the policy, computing mode/isolation/timeout/context) is
 * delegated to `resolveDelegation` (`@caesar/core`), the assembly point
 * shared with `caesar run` (`packages/cli/src/commands/run.ts`) — see its
 * header and the task 7 fix report: until then the two facades applied the
 * same rule in two distinct places.
 *
 * The returned `isolation` field is the one `resolveDelegation` resolved
 * from the configuration layers (explicit input > role > project policy) —
 * not the final "auto" → "inplace"/"worktree" resolution that `runTask`
 * performs internally: the latter depends on the state of the git repository
 * and on isolation preparation that may not be instantaneous (creating a
 * worktree), which `caesar_delegate` cannot wait for without reopening the
 * non-blocking promise this tool carries. `caesar_status`/`caesar_await`,
 * once the task is known to the store, return the isolation actually
 * retained.
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

  // Depth inherited from `$CAESAR_DEPTH` (+1): see C4 of the final review. An
  // MCP server can itself run as a subagent (`caesar mcp install` registers
  // it globally with several clients — see I4/the "aggravating" finding of
  // C4): without re-reading this variable, `max_depth` and the
  // anti-recursion guardrail only applied at the first level.
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
    // Reason returned verbatim by @caesar/core — see the brief.
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

  // The root mismatch, stated at the moment it matters. `caesar mcp install`
  // freezes `--root` once and for all: if the main agent has since moved
  // into a worktree, the subagents work in a tree nobody is looking at
  // anymore. A warning rather than a refusal — the server's current
  // directory is no proof of the caller's intent, and failing the delegation
  // on that basis would cost more than it earns.
  const workspaceWarning = await describeWorkspaceMismatch(session.root, process.cwd());

  return jsonResult({
    task_id: taskId,
    agent: resolved.agentId,
    mode: resolved.mode,
    isolation: resolved.isolation,
    // Returned explicitly: without it, nothing in the response says *where*
    // the subagent is working, and the mismatch below would be unverifiable.
    workspace: session.root,
    ...(workspaceWarning !== null ? { workspace_warning: workspaceWarning } : {}),
    // Returned at launch time, not only in the final report: the
    // orchestrator can thus rephrase the objective or switch agents before
    // the subagent has spent its budget.
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
