import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { checkDelegation, describeAgentPolicy, isAgentAllowed, isDepthAllowed, isRecursionAllowed } from "./policy.js";
import type { PolicyConfig } from "./config.js";

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...defaultConfig().policy, ...overrides };
}

describe("isAgentAllowed", () => {
  it("refuses an agent listed in denied", () => {
    const decision = isAgentAllowed(policy({ denied: ["copilot"] }), "copilot");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("copilot");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("empty allowed: any agent not denied passes", () => {
    expect(isAgentAllowed(policy(), "codex")).toEqual({ allowed: true });
  });

  it("non-empty allowed: only the listed agents pass", () => {
    const p = policy({ allowed: ["codex", "opencode"] });
    expect(isAgentAllowed(p, "codex")).toEqual({ allowed: true });
    const decision = isAgentAllowed(p, "antigravity");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("antigravity");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("denied always wins over allowed: an agent in both lists is refused", () => {
    const p = policy({ allowed: ["codex"], denied: ["codex"] });
    const decision = isAgentAllowed(p, "codex");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("codex");
      expect(decision.reason).toMatch(/denied|refused/i);
    }
  });
});

describe("isDepthAllowed", () => {
  it("depth < max_depth: allowed", () => {
    expect(isDepthAllowed(policy({ max_depth: 2 }), 1)).toEqual({ allowed: true });
  });

  it("depth >= max_depth: refused", () => {
    const decision = isDepthAllowed(policy({ max_depth: 2 }), 2);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason).toContain("2");
    }
  });

  it("depth strictly greater than max_depth: refused", () => {
    expect(isDepthAllowed(policy({ max_depth: 2 }), 5).allowed).toBe(false);
  });
});

describe("isRecursionAllowed", () => {
  it("allow_recursion false: the claude agent is refused", () => {
    const decision = isRecursionAllowed(policy({ allow_recursion: false }), "claude");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("claude");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("allow_recursion true: the claude agent is allowed (by this rule)", () => {
    expect(isRecursionAllowed(policy({ allow_recursion: true }), "claude")).toEqual({ allowed: true });
  });

  it("an agent other than claude is never concerned by this rule", () => {
    expect(isRecursionAllowed(policy({ allow_recursion: false }), "codex")).toEqual({ allowed: true });
  });
});

describe("checkDelegation", () => {
  it("allows an installed, lawful agent at low depth", () => {
    expect(checkDelegation(policy(), { agentId: "codex", depth: 0 })).toEqual({ allowed: true });
  });

  it("rule 1: denied wins over allowed", () => {
    const p = policy({ allowed: ["codex"], denied: ["codex"] });
    const decision = checkDelegation(p, { agentId: "codex", depth: 0 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("codex");
  });

  it("rule 2: agent outside allowed refused", () => {
    const decision = checkDelegation(policy({ allowed: ["codex"] }), { agentId: "opencode", depth: 0 });
    expect(decision.allowed).toBe(false);
  });

  it("rule 3: depth refused", () => {
    const decision = checkDelegation(policy({ max_depth: 1 }), { agentId: "codex", depth: 1 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("rule 4: claude refused when allow_recursion is false", () => {
    const decision = checkDelegation(policy({ allow_recursion: false }), { agentId: "claude", depth: 0 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("claude");
  });

  it("claude allowed when allow_recursion is true", () => {
    expect(checkDelegation(policy({ allow_recursion: true }), { agentId: "claude", depth: 0 })).toEqual({ allowed: true });
  });

  it("every refusal carries a non-empty reason", () => {
    const cases: Array<{ policy: PolicyConfig; agentId: string; depth: number }> = [
      { policy: policy({ denied: ["codex"] }), agentId: "codex", depth: 0 },
      { policy: policy({ allowed: ["opencode"] }), agentId: "codex", depth: 0 },
      { policy: policy({ max_depth: 0 }), agentId: "codex", depth: 0 },
      { policy: policy({ allow_recursion: false }), agentId: "claude", depth: 0 },
    ];
    for (const c of cases) {
      const decision = checkDelegation(c.policy, { agentId: c.agentId, depth: c.depth });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * Moved from `packages/cli/src/commands/agents.ts` (task 8, correction
 * report) — see its docstring for the reasoning. `packages/cli`
 * (`agents.ts`, `doctor.ts`) now calls it from here; its tests
 * keep passing without modification (see `packages/cli/src/commands/
 * agents.test.ts`, exercised indirectly via `runAgentsList`).
 */
describe("describeAgentPolicy", () => {
  it("allowed: neither denied, nor outside allowed, nor recursion refused", () => {
    expect(describeAgentPolicy(policy(), "codex")).toEqual({ allowed: true });
  });

  it("reflects isAgentAllowed (denied wins)", () => {
    const decision = describeAgentPolicy(policy({ denied: ["codex"] }), "codex");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("denied");
  });

  it("reflects isRecursionAllowed, even without appearing in denied/allowed", () => {
    const decision = describeAgentPolicy(policy({ allow_recursion: false }), "claude");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("recursion");
  });

  it("never takes depth into account: max_depth does not come into play", () => {
    // `checkDelegation` would refuse here on the depth rule;
    // `describeAgentPolicy` has no depth to evaluate, by construction.
    expect(describeAgentPolicy(policy({ max_depth: 0 }), "codex")).toEqual({ allowed: true });
  });
});
