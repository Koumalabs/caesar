/**
 * Resolves a delegation request — role and/or explicit agent, mode,
 * isolation, network, timeout, context — into what is needed to call
 * `runTask`, or into a refusal carrying a ready-to-display reason.
 *
 * Assembly point shared by `caesar run` (`packages/cli/src/commands/run.ts`)
 * and `caesar_delegate` (`packages/mcp-server/src/tools/delegate.ts`), which
 * until now applied this same rule in two places, with the same risk that
 * only one of the two copies drifts over the course of a future
 * modification — see the correction report of task 7. Resolution order:
 * role (if there is one) → agent (the explicit input wins over the choice
 * derived from the role, but not over its defaults for
 * mode/isolation/network/timeout/system prompt) → catalog → policy →
 * network (which comes last because it depends on the mode and agent
 * selected).
 *
 * Depends on no facade-specific context (no CLI `Io`, no MCP session):
 * only the types of `@caesar/core`/`@caesar/protocol`, in order to remain
 * reusable as-is by the TUI (upcoming task).
 *
 * What this function deliberately does not do: it does not validate the
 * *shape* of `mode`/`isolation` (arbitrary string on the CLI side,
 * enumeration already typed by the zod schema on the MCP side) — that
 * validation belongs to each facade's transport, which does it before calling
 * `resolveDelegation` with already-typed values. Nor does it read any file
 * for `context` (the CLI's `@file` is resolved by its caller): it only
 * merges the already-resolved context with the role's system prompt.
 */
import { ENV } from "@caesar/protocol";
import type { Isolation, TaskMode } from "@caesar/protocol";
import type { CaesarConfig } from "./config.js";
import { parseDuration } from "./config.js";
import { checkDelegation } from "./policy.js";
import { decideNetwork } from "./network.js";
import type { NetworkRequest } from "./network.js";
import { decideInplaceWrite } from "./isolation.js";
import type { IsolationSource } from "./isolation.js";
import { usableRepoRoot } from "./engine/worktree.js";
import { pickAgentForRole, resolveInstalledMap, resolveRole } from "./roles.js";
import { findAgentDefinition } from "./registry/index.js";

export interface DelegationParams {
  role?: string;
  agent?: string;
  mode?: TaskMode;
  isolation?: Isolation | "auto";
  network?: NetworkRequest;
  /** Already-resolved context (any `@file` on the CLI side is read before the call); merged here with the role's system prompt, if there is one. */
  context?: string;
  /** Raw duration ("10m", "90s"…); the reason from `parseDuration` is rendered as-is on failure. */
  timeout?: string;
  /**
   * Delegation depth, passed on to `checkDelegation`. Required — see C4 of
   * the final review: a parameter with a default value
   * (`params.depth ?? 0`) is what left `max_depth` unenforced without
   * any test or the compilation noticing. 0 for a top-level call (CLI,
   * MCP server, without an inherited `$CAESAR_DEPTH`); see
   * `nextDelegationDepth` for the computation expected on the facade side.
   */
  depth: number;
}

/**
 * Depth to assign to the *next* delegation, computed from the `$CAESAR_DEPTH`
 * inherited by the current process — see C4 of the final review: this
 * variable was indeed exported to subprocesses (`taskEnv`,
 * `@caesar/protocol`) but never read back by anyone, which made `max_depth`
 * unenforceable as soon as a delegating agent was itself running as a
 * sub-agent of a previous delegation. An invalid or absent
 * `Number(process.env[...])` falls back to 0 rather than `NaN` — a
 * `NaN >= max_depth` would always be false and would silently disarm the
 * safeguard.
 */
export function nextDelegationDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.depth];
  const inherited = raw === undefined ? 0 : Number(raw);
  return (Number.isFinite(inherited) ? inherited : 0) + 1;
}

export interface ResolvedDelegation {
  agentId: string;
  /** Name of the role, if `params.role` carried one — to be passed as-is to `RunTaskInput.role`. */
  role?: string;
  mode: TaskMode;
  isolation: Isolation | "auto";
  /**
   * The `policy.allow_inplace_write` opt-in, to be passed as-is to
   * `RunTaskInput.allowInplaceWrite`.
   *
   * Rendered here rather than re-read from `config.policy` by each facade:
   * the engine refuses by default, so the routing of this permission must
   * be unique and obvious. Three independent reads of the same key are
   * three occasions to forget one — the very defect `resolveDelegation`
   * exists to close.
   */
  allowInplaceWrite: boolean;
  /**
   * Will the network be available? Already checked against what the selected
   * agent allows — the tri-state request, for its part, stops here.
   */
  network: boolean;
  /**
   * What to say when the request and the possible did not coincide
   * without justifying a refusal for all that: network cut off for lack of
   * better, or a requested shutdown we do not know how to obtain. Poured
   * into the report by the engine, next to the degraded-isolation warning.
   */
  networkWarning?: string;
  timeoutMs: number;
  context?: string;
}

export type DelegationResult = ResolvedDelegation | { error: string };

export async function resolveDelegation(config: CaesarConfig, root: string, params: DelegationParams): Promise<DelegationResult> {
  // Generic reason, deliberately without any flag or field name: this
  // function does not know which facade it is called from. The CLI
  // (`caesar run`) checks this same condition upstream, before calling
  // `resolveDelegation`, to render its own message naming the exact flags
  // (`--agent`/`--role`) — see `run.ts` and the correction report of
  // task 7. For the MCP server, whose parameters are named precisely
  // "agent"/"role", this generic reason fits as-is.
  if (!params.agent && !params.role) {
    return { error: "An agent or a role is required." };
  }

  const role = params.role ? await resolveRole(config, root, params.role) : null;
  if (params.role && !role) {
    return { error: `Unknown role: "${params.role}".` };
  }

  let agentId: string;
  if (params.agent) {
    agentId = params.agent;
  } else if (role) {
    const installed = await resolveInstalledMap(role.agents, config.agents);
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    if ("error" in pick) return { error: pick.error };
    agentId = pick.agentId;
  } else {
    // Unreachable: the guard at the top of the function already requires one of the two.
    return { error: "An agent or a role is required." };
  }

  const agentDef = findAgentDefinition(agentId, config.agents);
  if (!agentDef) {
    return { error: `Unknown agent: "${agentId}".` };
  }

  const decision = checkDelegation(config.policy, { agentId, depth: params.depth });
  if (!decision.allowed) {
    return { error: decision.reason };
  }

  const mode: TaskMode = params.mode ?? role?.mode ?? config.policy.default_mode;
  const isolation: Isolation | "auto" = params.isolation ?? role?.isolation ?? config.policy.default_isolation;

  // Before everything else, and before anything is written to disk: a
  // write task has no right to run in the user's working tree without a
  // deliberate opt-in. `prepareIsolation` renders the same verdict —
  // `decideInplaceWrite` is pure, the two cannot diverge — but later, once
  // the task directory has been created; here the refusal leaves nothing
  // behind it, and its reason names the layer to fix.
  //
  // Git state is only queried where it can change the answer: the two
  // commands of `usableRepoRoot` are not free, and every delegation would
  // pay for them for a verdict known in advance. When the guard is
  // inactive, `repoUsable: false` leads `decideInplaceWrite` to the same
  // "not refused" that the other guards would have rendered anyway.
  const inplaceUnderReview = isolation === "inplace" && mode === "write" && !config.policy.allow_inplace_write;
  const repo = inplaceUnderReview ? await usableRepoRoot(root) : null;
  const isolationSource: IsolationSource =
    params.isolation !== undefined ? "explicit" : role !== null ? "role" : "policy";
  const inplaceWrite = decideInplaceWrite({
    requested: isolation,
    mode,
    repoUsable: repo !== null,
    allowed: config.policy.allow_inplace_write,
    source: isolationSource,
    ...(repo !== null ? { repo } : {}),
    ...(role ? { roleName: role.name } : {}),
  });
  if (inplaceWrite.refused) {
    return { error: `${inplaceWrite.reason} ${inplaceWrite.remedy}` };
  }

  // After the mode, on which the decision depends: an agent that only knows
  // how to open the network in write mode can only be judged once the mode
  // is known. And before anything is written to disk — a refusal leaves no
  // task directory behind it.
  const netDecision = decideNetwork({
    agentId,
    requested: params.network ?? role?.network ?? config.policy.default_network,
    mode,
    control: agentDef.capabilities.network,
  });
  if (netDecision.refused) {
    return { error: `${netDecision.reason} ${netDecision.remedy}` };
  }

  let timeoutMs: number;
  try {
    timeoutMs = params.timeout ? parseDuration(params.timeout) : (role?.timeout_ms ?? config.policy.default_timeout_ms);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  let context = params.context;
  if (role?.systemPrompt) {
    context = [role.systemPrompt, context].filter((part) => part && part.trim() !== "").join("\n\n---\n\n");
  }

  const result: ResolvedDelegation = {
    agentId,
    mode,
    isolation,
    allowInplaceWrite: config.policy.allow_inplace_write,
    network: netDecision.available,
    timeoutMs,
  };
  if (netDecision.warning !== undefined) result.networkWarning = netDecision.warning;
  if (params.role) result.role = params.role;
  if (context !== undefined) result.context = context;
  return result;
}
