import { describe, expect, it } from "vitest";
import type { NetworkControl, NetworkRequest } from "./network.js";
import { decideNetwork, describeNetworkControl } from "./network.js";
import type { TaskMode } from "@caesar/protocol";

const CONTROLS: NetworkControl[] = ["open", "toggle", "write-only", "unknown"];
const REQUESTS: NetworkRequest[] = ["auto", "on", "off"];
const MODES: TaskMode[] = ["read-only", "write"];

function decide(requested: NetworkRequest, control: NetworkControl, mode: TaskMode = "write") {
  return decideNetwork({ agentId: "codex", requested, mode, control });
}

describe("decideNetwork — demande explicite « on »", () => {
  it("accorde le réseau quand l'agent l'a déjà ouvert", () => {
    expect(decide("on", "open")).toEqual({ refused: false, available: true });
  });

  it("accorde le réseau quand l'orchestrateur sait l'ouvrir", () => {
    expect(decide("on", "toggle", "read-only")).toEqual({ refused: false, available: true });
  });

  it("accorde le réseau à un agent « écriture seule » en mode écriture", () => {
    expect(decide("on", "write-only", "write")).toEqual({ refused: false, available: true });
  });

  it("refuse — avec motif et remède — un agent « écriture seule » en lecture seule", () => {
    // Le cas qui a motivé tout le module : codex en `-s read-only` coupe le
    // réseau sans recours, et rien ne le disait.
    const decision = decide("on", "write-only", "read-only");
    expect(decision.refused).toBe(true);
    if (!decision.refused) throw new Error("attendu refusé");
    expect(decision.reason).toContain("codex");
    expect(decision.reason).toContain("écriture");
    expect(decision.remedy).toContain("--mode write");
  });

  it("laisse passer un agent au réseau inconnu, mais dit que ce n'est pas une garantie", () => {
    const decision = decide("on", "unknown");
    expect(decision).toMatchObject({ refused: false, available: true });
    if (decision.refused) throw new Error("attendu accordé");
    expect(decision.warning).toContain("network_args");
  });
});

describe("decideNetwork — défaut « auto »", () => {
  it("ne refuse jamais, quelle que soit la combinaison", () => {
    // La propriété qui protège les rôles livrés : `reviewer` et
    // `investigator` sont en lecture seule sur codex ; un `auto` qui refuserait
    // les mettrait tous les deux hors service.
    for (const control of CONTROLS) {
      for (const mode of MODES) {
        expect(decide("auto", control, mode).refused).toBe(false);
      }
    }
  });

  it("avertit — au lieu de refuser — quand codex ne peut pas ouvrir en lecture seule", () => {
    const decision = decide("auto", "write-only", "read-only");
    expect(decision).toMatchObject({ refused: false, available: false });
    if (decision.refused) throw new Error("attendu accordé");
    expect(decision.warning).toContain("Réseau indisponible");
  });

  it("reste silencieux sur un agent au réseau inconnu — rien n'a été demandé, rien n'est à corriger", () => {
    const decision = decide("auto", "unknown");
    expect(decision).toEqual({ refused: false, available: true });
  });

  it("ouvre le réseau partout où c'est possible", () => {
    expect(decide("auto", "open")).toEqual({ refused: false, available: true });
    expect(decide("auto", "toggle", "read-only")).toEqual({ refused: false, available: true });
    expect(decide("auto", "write-only", "write")).toEqual({ refused: false, available: true });
  });
});

describe("decideNetwork — fermeture demandée « off »", () => {
  it("ferme sans un mot quand l'orchestrateur sait le faire", () => {
    expect(decide("off", "toggle")).toEqual({ refused: false, available: false });
    expect(decide("off", "write-only")).toEqual({ refused: false, available: false });
  });

  it("avoue son impuissance plutôt que d'annoncer une fermeture qui n'a pas eu lieu", () => {
    // Le point d'honnêteté du module : `available` reste vrai, sans quoi le
    // brief interdirait à l'agent un réseau dont il dispose en réalité.
    for (const control of ["open", "unknown"] as const) {
      const decision = decide("off", control);
      expect(decision).toMatchObject({ refused: false, available: true });
      if (decision.refused) throw new Error("attendu accordé");
      expect(decision.warning).toContain("ne sait pas le refermer");
    }
  });
});

describe("decideNetwork — invariants", () => {
  it("n'omet aucune combinaison : chaque cas rend une décision exploitable", () => {
    for (const requested of REQUESTS) {
      for (const control of CONTROLS) {
        for (const mode of MODES) {
          const decision = decideNetwork({ agentId: "x", requested, mode, control });
          if (decision.refused) {
            expect(decision.reason.length).toBeGreaterThan(0);
            expect(decision.remedy.length).toBeGreaterThan(0);
          } else {
            expect(typeof decision.available).toBe("boolean");
          }
        }
      }
    }
  });

  it("ne refuse que sur une demande explicite", () => {
    for (const control of CONTROLS) {
      for (const mode of MODES) {
        expect(decide("auto", control, mode).refused).toBe(false);
        expect(decide("off", control, mode).refused).toBe(false);
      }
    }
  });
});

describe("describeNetworkControl", () => {
  it("nomme chaque capacité en un fragment court", () => {
    for (const control of CONTROLS) {
      expect(describeNetworkControl(control)).toMatch(/^réseau /);
    }
  });
});
