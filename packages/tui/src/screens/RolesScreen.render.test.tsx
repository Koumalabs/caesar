import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { RolesScreen } from "./RolesScreen";

describe("RolesScreen", () => {
  it("se monte sans lever et affiche les rôles par défaut", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(
        <RolesScreen state={state} installed={null} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />,
        { width: 100, height: 30 },
      ),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("reviewer");
    expect(frame).toContain("implementer");
    expect(frame).toContain("Agents (ordre de repli)");
    setup.renderer.destroy();
  });

  it("signale qu'un rôle redéfini globalement est hérité, pas déclaré par la couche active (tâche 15)", async () => {
    const state = makeState(); // "reviewer" sélectionné par défaut (premier de la liste), redéfini en global ci-dessous
    state.layers[0] = {
      ...state.layers[0]!,
      override: {
        roles: [{ name: "reviewer", purpose: "Redéfini globalement.", agents: ["codex"], mode: "read-only", isolation: "inplace", timeout_ms: 600_000 }],
      },
    };
    const setup = await act(async () =>
      testRender(
        <RolesScreen state={state} installed={null} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />,
        { width: 100, height: 30 },
      ),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Redéfini globalement.");
    expect(frame).toContain("Hérité ← global");
    setup.renderer.destroy();
  });
});
