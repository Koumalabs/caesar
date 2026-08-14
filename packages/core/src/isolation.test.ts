import { describe, expect, it } from "vitest";
import type { Isolation, TaskMode } from "@caesar/protocol";
import type { IsolationSource } from "./isolation.js";
import { decideInplaceWrite } from "./isolation.js";

const REQUESTS: (Isolation | "auto")[] = ["inplace", "worktree", "auto"];
const MODES: TaskMode[] = ["read-only", "write"];
const SOURCES: IsolationSource[] = ["explicit", "role", "policy"];

function decide(
  requested: Isolation | "auto",
  mode: TaskMode,
  repoUsable: boolean,
  allowed: boolean,
  extra: { source?: IsolationSource; repo?: string; roleName?: string } = {},
) {
  return decideInplaceWrite({ requested, mode, repoUsable, allowed, ...extra });
}

describe("decideInplaceWrite — the only refused combination", () => {
  it('refuses "inplace" in write mode in a usable repository without opt-in', () => {
    // The case observed in production: three `implementer` tasks delegated with
    // `isolation: "inplace"` wrote onto the user's working branch,
    // silently.
    const decision = decide("inplace", "write", true, false, { source: "explicit", repo: "/w/support" });
    expect(decision.refused).toBe(true);
    if (!decision.refused) throw new Error("expected refused");
    expect(decision.reason).toContain("explicitly requested");
    expect(decision.reason).toContain("/w/support");
    expect(decision.remedy).toContain("worktree");
    expect(decision.remedy).toContain("allow_inplace_write");
  });

  it("accepts no other combination as grounds for refusal", () => {
    // The exhaustive table: 3 × 2 × 2 × 2 = 24 cases, a single refused cell.
    let refusals = 0;
    for (const requested of REQUESTS) {
      for (const mode of MODES) {
        for (const repoUsable of [true, false]) {
          for (const allowed of [true, false]) {
            const decision = decide(requested, mode, repoUsable, allowed);
            const expected = requested === "inplace" && mode === "write" && repoUsable && !allowed;
            expect(decision.refused, `${requested}/${mode}/repo=${repoUsable}/allowed=${allowed}`).toBe(expected);
            if (decision.refused) refusals += 1;
          }
        }
      }
    }
    expect(refusals).toBe(1);
  });
});

describe("decideInplaceWrite — the guards, one by one", () => {
  it('lets "auto" through: the decision belongs to prepareIsolation, which already chooses the worktree', () => {
    expect(decide("auto", "write", true, false)).toEqual({ refused: false });
  });

  it("lets read-only mode through: mustForceWorktree governs it", () => {
    expect(decide("inplace", "read-only", true, false)).toEqual({ refused: false });
  });

  it("lets through outside a usable repository: refusing would make caesar unusable on an unversioned project", () => {
    // Without a repository (or without a single commit), no worktree is
    // creatable: a refusal would offer no way out.
    expect(decide("inplace", "write", false, false)).toEqual({ refused: false });
  });

  it("lets through under an assumed opt-in", () => {
    expect(decide("inplace", "write", true, true)).toEqual({ refused: false });
  });
});

describe("decideInplaceWrite — the reason sends you to fix the right file", () => {
  it("names the role when the value comes from it", () => {
    const decision = decide("inplace", "write", true, false, { source: "role", roleName: "implementer" });
    if (!decision.refused) throw new Error("expected refused");
    expect(decision.reason).toContain('role "implementer"');
  });

  it("names the policy when the value comes from it", () => {
    const decision = decide("inplace", "write", true, false, { source: "policy" });
    if (!decision.refused) throw new Error("expected refused");
    expect(decision.reason).toContain("default_isolation");
  });

  it("stays readable without provenance or repository — a direct call to runTask provides neither", () => {
    const decision = decide("inplace", "write", true, false);
    if (!decision.refused) throw new Error("expected refused");
    expect(decision.reason).toContain("refused");
    expect(decision.reason).not.toContain("undefined");
    expect(decision.remedy).not.toContain("undefined");
  });

  it("always returns a non-empty reason and remedy, whatever the provenance", () => {
    for (const source of SOURCES) {
      const decision = decide("inplace", "write", true, false, { source });
      if (!decision.refused) throw new Error("expected refused");
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.remedy.length).toBeGreaterThan(0);
      // The remedy must always name the practicable way out before the opt-in.
      expect(decision.remedy).toContain("[worktree]");
    }
  });
});
