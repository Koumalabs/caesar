import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { PolicyScreen } from "./PolicyScreen";

describe("PolicyScreen", () => {
  it("se monte sans lever, affiche les champs de la politique et le rappel denied/allowed", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(<PolicyScreen state={state} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />, {
        width: 100,
        height: 30,
      }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("max_parallel");
    expect(frame).toContain("denied");
    expect(frame).toContain("l'emporte toujours sur");
    setup.renderer.destroy();
  });

  it("marque \"← global\" un champ hérité, jamais un champ que la couche active déclare elle-même (tâche 15)", async () => {
    // "global" déclare max_parallel ; la couche active ("project") ne l'a pas encore surchargé.
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    const setup = await act(async () =>
      testRender(<PolicyScreen state={state} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />, {
        width: 100,
        height: 30,
      }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("← global");
    // max_depth n'est déclaré nulle part : hérité du défaut, une marque différente ("← défaut").
    expect(frame).toContain("← défaut");
    setup.renderer.destroy();
  });

  it("aucune marque quand la couche active (\"project\") déclare elle-même le champ", async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    state.draft = { policy: { max_parallel: 3 } }; // "project" surcharge désormais max_parallel lui-même
    const setup = await act(async () =>
      testRender(<PolicyScreen state={state} onChange={() => {}} onEditingChange={() => {}} notify={() => {}} />, {
        width: 100,
        height: 30,
      }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("← global");
    setup.renderer.destroy();
  });
});
