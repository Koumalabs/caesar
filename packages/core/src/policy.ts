/**
 * Authorization decisions: which agents the project's policy allows
 * delegating to, and at what depth.
 *
 * Every refusal carries a `reason` written for a human, naming the agent
 * and the rule applied: these messages travel as-is up to the main agent
 * via MCP (upcoming task), and a refusal without a reason is unusable there.
 */
import type { PolicyConfig, ProvenanceSource } from "./config.js";

/**
 * Which rule produced a refusal — see CONTROLLER-1 of the final review:
 * `Decision` carried until now only a sentence, which produced a generic
 * remedy in `caesar doctor` ("Allow it with 'caesar agents enable X'
 * or 'caesar policy allow X'"), wrong for two of the three refusal
 * reasons — neither of the two touches `allow_recursion`, the sole reason
 * `claude` is refused by default. `denied`/`allowlist`/`depth`/`recursion`
 * let a caller (CLI, TUI, MCP tools) pick the right remedy without
 * reinterpreting the text of `reason`.
 */
export type PolicyRule = "denied" | "allowlist" | "depth" | "recursion";

export type Decision = { allowed: true } | { allowed: false; reason: string; rule: PolicyRule };

/**
 * Rule of the `allowed`/`denied` lists:
 * 1. `denied` always wins over `allowed` — an agent present in both
 *    lists is refused.
 * 2. If `allowed` is empty, any agent not denied passes. Otherwise, only
 *    the listed agents pass.
 */
export function isAgentAllowed(policy: PolicyConfig, agentId: string): Decision {
  if (policy.denied.includes(agentId)) {
    return {
      allowed: false,
      rule: "denied",
      reason: `Agent "${agentId}" refused: present in the policy's "denied" list.`,
    };
  }
  if (policy.allowed.length > 0 && !policy.allowed.includes(agentId)) {
    return {
      allowed: false,
      rule: "allowlist",
      reason: `Agent "${agentId}" refused: the policy restricts delegation to the agents listed in "allowed" (${policy.allowed.join(", ")}).`,
    };
  }
  return { allowed: true };
}

/** `depth >= max_depth` is refused. */
export function isDepthAllowed(policy: PolicyConfig, depth: number): Decision {
  if (depth >= policy.max_depth) {
    return {
      allowed: false,
      rule: "depth",
      reason: `Delegation depth ${depth} refused: the policy caps it at max_depth = ${policy.max_depth}.`,
    };
  }
  return { allowed: true };
}

/**
 * If `allow_recursion` is false, the `claude` agent is refused: delegating
 * to Claude from Claude Code is the recursion this setting protects
 * against. It is the only policy rule targeting an agent by name — see the
 * brief of task 5.
 *
 * Exported separately (in addition to `checkDelegation`) because
 * `pickAgentForRole` (roles.ts) must apply this same rule without having a
 * task depth available: it reuses this function rather than duplicating
 * the logic.
 */
export function isRecursionAllowed(policy: PolicyConfig, agentId: string): Decision {
  if (!policy.allow_recursion && agentId === "claude") {
    return {
      allowed: false,
      rule: "recursion",
      reason: `Agent "claude" refused: allow_recursion is disabled (delegating to Claude from Claude Code would be recursion).`,
    };
  }
  return { allowed: true };
}

/**
 * Composes the four policy rules, in the order the brief states them:
 * allowed/denied lists, then depth, then recursion. The first refusal
 * encountered is the one returned.
 */
export function checkDelegation(policy: PolicyConfig, input: { agentId: string; depth: number }): Decision {
  const agentDecision = isAgentAllowed(policy, input.agentId);
  if (!agentDecision.allowed) return agentDecision;

  const depthDecision = isDepthAllowed(policy, input.depth);
  if (!depthDecision.allowed) return depthDecision;

  return isRecursionAllowed(policy, input.agentId);
}

/**
 * Status of an agent with respect to the policy, delegation depth excluded
 * (which only makes sense for an in-flight task — see `pickAgentForRole`,
 * `roles.ts`, which applies the same `isAgentAllowed`/`isRecursionAllowed`
 * pair without a depth either).
 *
 * Moved from `packages/cli/src/commands/agents.ts` (task 8, correction
 * report): `packages/tui` needed it for its Agents screen, and duplicating
 * it in the TUI or making `packages/tui` depend on `packages/cli`
 * for two pure functions was worse than bringing it back here, next to
 * the rules it composes — same reasoning as `resolveDelegation`
 * (`delegation.ts`) in the previous task. `packages/cli`
 * (`commands/agents.ts`, `commands/doctor.ts`) now imports it from here.
 */
export function describeAgentPolicy(policy: PolicyConfig, agentId: string): Decision {
  const allowedDecision = isAgentAllowed(policy, agentId);
  if (!allowedDecision.allowed) return allowedDecision;
  return isRecursionAllowed(policy, agentId);
}

/**
 * The remedy that actually applies for `rule` — see CONTROLLER-1 of the
 * final review. Centralized here rather than rewritten by each facade
 * (`caesar doctor`, the TUI's Agents screen, a future MCP diagnostic tool):
 * it is the same rule → remedy mapping logic everywhere.
 *
 * - `"denied"`: only `caesar agents enable` removes the agent from `denied` —
 *   `caesar policy allow` would not let it through anyway (`denied`
 *   always wins) and would have the side effect described under `"allowlist"`.
 * - `"allowlist"`: `caesar policy allow` is the right remedy, but with
 *   the warning from CONTROLLER-2 — if `allowed` was empty, this
 *   command from now on restricts all other agents not explicitly
 *   listed.
 * - `"recursion"`: no dedicated CLI subcommand today; only editing
 *   `allow_recursion` (TUI, Policy tab, or the TOML directly) lifts this
 *   refusal.
 * - `"depth"`: cannot be fixed per agent — it is the depth of the
 *   in-flight delegation that exceeds `max_depth`, not a property of the
 *   agent itself; not applicable to a static per-agent diagnostic
 *   (`caesar doctor`), which never reaches this case (it does not call
 *   `isDepthAllowed`).
 */
export function remedyFor(agentId: string, rule: PolicyRule, scope: ProvenanceSource = "project"): string {
  // Without an option, the write commands target the project layer. Suggesting
  // "caesar agents enable X" to lift a refusal declared by the global layer
  // lifts nothing: it writes to the project, where the list was not declared,
  // and materializes it with the effective value — refusal included. The
  // remedy must therefore target the layer that carries the rule.
  const layerFlag = scope === "global" ? " --global" : scope === "local" ? " --local" : "";
  switch (rule) {
    case "denied":
      return `Allow it with "caesar agents enable ${agentId}${layerFlag}".`;
    case "allowlist":
      return (
        `Add it with "caesar policy allow ${agentId}${layerFlag}" — careful: if the "allowed" list is empty today, ` +
        `this command switches it from "any agent not denied" to "only ${agentId}", refusing in the same stroke ` +
        `every other agent (see "caesar policy show").`
      );
    case "recursion":
      return `Enable "allow_recursion" (Policy tab of the "caesar config" TUI, or edit .caesar/config.toml — no dedicated subcommand today).`;
    case "depth":
      return `Not applicable per agent: it is the depth of the in-flight delegation that exceeds "max_depth", not a property of the agent.`;
  }
}
