import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { checkDelegation, isAgentAllowed, isDepthAllowed, isRecursionAllowed } from "./policy.js";
import type { PolicyConfig } from "./config.js";

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...defaultConfig().policy, ...overrides };
}

describe("isAgentAllowed", () => {
  it("refuse un agent listé dans denied", () => {
    const decision = isAgentAllowed(policy({ denied: ["copilot"] }), "copilot");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("copilot");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("allowed vide : tout agent non refusé passe", () => {
    expect(isAgentAllowed(policy(), "codex")).toEqual({ allowed: true });
  });

  it("allowed non vide : seuls les agents listés passent", () => {
    const p = policy({ allowed: ["codex", "opencode"] });
    expect(isAgentAllowed(p, "codex")).toEqual({ allowed: true });
    const decision = isAgentAllowed(p, "antigravity");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("antigravity");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("denied l'emporte toujours sur allowed : un agent dans les deux listes est refusé", () => {
    const p = policy({ allowed: ["codex"], denied: ["codex"] });
    const decision = isAgentAllowed(p, "codex");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("codex");
      expect(decision.reason).toMatch(/denied|refusé/i);
    }
  });
});

describe("isDepthAllowed", () => {
  it("depth < max_depth : autorisé", () => {
    expect(isDepthAllowed(policy({ max_depth: 2 }), 1)).toEqual({ allowed: true });
  });

  it("depth >= max_depth : refusé", () => {
    const decision = isDepthAllowed(policy({ max_depth: 2 }), 2);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason).toContain("2");
    }
  });

  it("depth strictement supérieure à max_depth : refusé", () => {
    expect(isDepthAllowed(policy({ max_depth: 2 }), 5).allowed).toBe(false);
  });
});

describe("isRecursionAllowed", () => {
  it("allow_recursion faux : l'agent claude est refusé", () => {
    const decision = isRecursionAllowed(policy({ allow_recursion: false }), "claude");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("claude");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("allow_recursion vrai : l'agent claude est autorisé (par cette règle)", () => {
    expect(isRecursionAllowed(policy({ allow_recursion: true }), "claude")).toEqual({ allowed: true });
  });

  it("un agent autre que claude n'est jamais concerné par cette règle", () => {
    expect(isRecursionAllowed(policy({ allow_recursion: false }), "codex")).toEqual({ allowed: true });
  });
});

describe("checkDelegation", () => {
  it("autorise un agent installé, licite, à faible profondeur", () => {
    expect(checkDelegation(policy(), { agentId: "codex", depth: 0 })).toEqual({ allowed: true });
  });

  it("règle 1 : denied l'emporte sur allowed", () => {
    const p = policy({ allowed: ["codex"], denied: ["codex"] });
    const decision = checkDelegation(p, { agentId: "codex", depth: 0 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("codex");
  });

  it("règle 2 : agent hors de allowed refusé", () => {
    const decision = checkDelegation(policy({ allowed: ["codex"] }), { agentId: "opencode", depth: 0 });
    expect(decision.allowed).toBe(false);
  });

  it("règle 3 : profondeur refusée", () => {
    const decision = checkDelegation(policy({ max_depth: 1 }), { agentId: "codex", depth: 1 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("règle 4 : claude refusé quand allow_recursion est faux", () => {
    const decision = checkDelegation(policy({ allow_recursion: false }), { agentId: "claude", depth: 0 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("claude");
  });

  it("claude autorisé quand allow_recursion est vrai", () => {
    expect(checkDelegation(policy({ allow_recursion: true }), { agentId: "claude", depth: 0 })).toEqual({ allowed: true });
  });

  it("chaque refus porte un motif non vide", () => {
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
