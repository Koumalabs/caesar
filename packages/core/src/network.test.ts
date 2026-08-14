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

describe('decideNetwork — explicit "on" request', () => {
  it("grants the network when the agent already has it open", () => {
    expect(decide("on", "open")).toEqual({ refused: false, available: true });
  });

  it("grants the network when the orchestrator knows how to open it", () => {
    expect(decide("on", "toggle", "read-only")).toEqual({ refused: false, available: true });
  });

  it('grants the network to a "write-only" agent in write mode', () => {
    expect(decide("on", "write-only", "write")).toEqual({ refused: false, available: true });
  });

  it('refuses — with reason and remedy — a "write-only" agent in read-only mode', () => {
    // The case that motivated the whole module: codex under `-s read-only`
    // cuts the network off with no recourse, and nothing said so.
    const decision = decide("on", "write-only", "read-only");
    expect(decision.refused).toBe(true);
    if (!decision.refused) throw new Error("expected refused");
    expect(decision.reason).toContain("codex");
    expect(decision.reason).toContain("write");
    expect(decision.remedy).toContain("--mode write");
  });

  it("lets an agent with an unknown network through, but says it is not a guarantee", () => {
    const decision = decide("on", "unknown");
    expect(decision).toMatchObject({ refused: false, available: true });
    if (decision.refused) throw new Error("expected granted");
    expect(decision.warning).toContain("network_args");
  });
});

describe('decideNetwork — "auto" default', () => {
  it("never refuses, whatever the combination", () => {
    // The property that protects the shipped roles: `reviewer` and
    // `investigator` are read-only on codex; an `auto` that refused
    // would put them both out of service.
    for (const control of CONTROLS) {
      for (const mode of MODES) {
        expect(decide("auto", control, mode).refused).toBe(false);
      }
    }
  });

  it("warns — instead of refusing — when codex cannot open in read-only mode", () => {
    const decision = decide("auto", "write-only", "read-only");
    expect(decision).toMatchObject({ refused: false, available: false });
    if (decision.refused) throw new Error("expected granted");
    expect(decision.warning).toContain("Network unavailable");
  });

  it("stays silent on an agent with an unknown network — nothing was requested, nothing is to fix", () => {
    const decision = decide("auto", "unknown");
    expect(decision).toEqual({ refused: false, available: true });
  });

  it("opens the network wherever possible", () => {
    expect(decide("auto", "open")).toEqual({ refused: false, available: true });
    expect(decide("auto", "toggle", "read-only")).toEqual({ refused: false, available: true });
    expect(decide("auto", "write-only", "write")).toEqual({ refused: false, available: true });
  });
});

describe('decideNetwork — requested closure "off"', () => {
  it("closes without a word when the orchestrator knows how", () => {
    expect(decide("off", "toggle")).toEqual({ refused: false, available: false });
    expect(decide("off", "write-only")).toEqual({ refused: false, available: false });
  });

  it("admits its powerlessness rather than announcing a closure that did not happen", () => {
    // The module's honesty point: `available` stays true, otherwise the
    // brief would deny the agent a network it actually has.
    for (const control of ["open", "unknown"] as const) {
      const decision = decide("off", control);
      expect(decision).toMatchObject({ refused: false, available: true });
      if (decision.refused) throw new Error("expected granted");
      expect(decision.warning).toContain("does not know how to close it");
    }
  });
});

describe("decideNetwork — invariants", () => {
  it("omits no combination: every case returns a usable decision", () => {
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

  it("only refuses on an explicit request", () => {
    for (const control of CONTROLS) {
      for (const mode of MODES) {
        expect(decide("auto", control, mode).refused).toBe(false);
        expect(decide("off", control, mode).refused).toBe(false);
      }
    }
  });
});

describe("describeNetworkControl", () => {
  it("names each capability in a short fragment", () => {
    for (const control of CONTROLS) {
      expect(describeNetworkControl(control)).toMatch(/^network /);
    }
  });
});
