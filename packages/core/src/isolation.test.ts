import { describe, expect, it } from "vitest";
import type { Isolation, TaskMode } from "@orch/protocol";
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

describe("decideInplaceWrite — la seule combinaison refusée", () => {
  it("refuse « inplace » en écriture dans un dépôt utilisable sans opt-in", () => {
    // Le cas constaté en production : trois tâches `implementer` déléguées avec
    // `isolation: "inplace"` ont écrit sur la branche de travail de
    // l'utilisateur, en silence.
    const decision = decide("inplace", "write", true, false, { source: "explicit", repo: "/w/support" });
    expect(decision.refused).toBe(true);
    if (!decision.refused) throw new Error("attendu refusé");
    expect(decision.reason).toContain("demandée explicitement");
    expect(decision.reason).toContain("/w/support");
    expect(decision.remedy).toContain("worktree");
    expect(decision.remedy).toContain("allow_inplace_write");
  });

  it("n'accepte aucune autre combinaison comme motif de refus", () => {
    // La table exhaustive : 3 × 2 × 2 × 2 = 24 cas, une seule case refusée.
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

describe("decideInplaceWrite — les gardes, une par une", () => {
  it("laisse passer « auto » : la décision revient à prepareIsolation, qui choisit déjà le worktree", () => {
    expect(decide("auto", "write", true, false)).toEqual({ refused: false });
  });

  it("laisse passer la lecture seule : c'est mustForceWorktree qui la gouverne", () => {
    expect(decide("inplace", "read-only", true, false)).toEqual({ refused: false });
  });

  it("laisse passer hors dépôt utilisable : refuser rendrait orch inutilisable sur un projet non versionné", () => {
    // Sans dépôt (ou sans le moindre commit), aucun worktree n'est créable :
    // un refus n'offrirait aucune issue.
    expect(decide("inplace", "write", false, false)).toEqual({ refused: false });
  });

  it("laisse passer sous opt-in assumé", () => {
    expect(decide("inplace", "write", true, true)).toEqual({ refused: false });
  });
});

describe("decideInplaceWrite — le motif envoie corriger le bon fichier", () => {
  it("nomme le rôle quand la valeur en vient", () => {
    const decision = decide("inplace", "write", true, false, { source: "role", roleName: "implementer" });
    if (!decision.refused) throw new Error("attendu refusé");
    expect(decision.reason).toContain('rôle "implementer"');
  });

  it("nomme la politique quand la valeur en vient", () => {
    const decision = decide("inplace", "write", true, false, { source: "policy" });
    if (!decision.refused) throw new Error("attendu refusé");
    expect(decision.reason).toContain("default_isolation");
  });

  it("reste lisible sans provenance ni dépôt — un appel direct à runTask n'en fournit pas", () => {
    const decision = decide("inplace", "write", true, false);
    if (!decision.refused) throw new Error("attendu refusé");
    expect(decision.reason).toContain("refusée");
    expect(decision.reason).not.toContain("undefined");
    expect(decision.remedy).not.toContain("undefined");
  });

  it("rend toujours un motif et un remède non vides, quelle que soit la provenance", () => {
    for (const source of SOURCES) {
      const decision = decide("inplace", "write", true, false, { source });
      if (!decision.refused) throw new Error("attendu refusé");
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.remedy.length).toBeGreaterThan(0);
      // Le remède doit toujours désigner l'issue praticable avant l'opt-in.
      expect(decision.remedy).toContain("[worktree]");
    }
  });
});
