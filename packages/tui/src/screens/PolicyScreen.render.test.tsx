import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { PolicyScreen } from "./PolicyScreen";

const callbacks = { onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

async function mount(state = makeState(), size = { width: 100, height: 30 }) {
  const setup = await act(async () => testRender(<PolicyScreen state={state} {...callbacks} />, size));
  await act(async () => setup.renderOnce());
  return setup;
}

describe("PolicyScreen", () => {
  it("nomme chaque réglage en français plutôt que par sa clé TOML", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    // Le défaut que cet écran corrige : « max_parallel », « allow_recursion »
    // et « max_depth » s'affichaient tels quels, sans qu'un mot dise ce qu'ils
    // font. Un réglage qu'on ne comprend pas ne se règle pas.
    expect(frame).toContain("Tâches en parallèle");
    expect(frame).toContain("Délégation récursive");
    expect(frame).toContain("Agents refusés");
    expect(frame).toContain("l'emporte toujours sur");
    setup.renderer.destroy();
  });

  it("explique le réglage sélectionné, et la clé TOML correspondante", async () => {
    const setup = await mount();
    // Sélection initiale : le premier réglage de la liste.
    expect(setup.captureCharFrame()).toContain("Ce qu'une tâche fait à défaut");
    expect(setup.captureCharFrame()).toContain("default_mode");

    // Descendre change l'explication — elle suit la sélection.
    for (let i = 0; i < 5; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("allow_recursion");
    // Fragment court : l'explication est repliée sur deux lignes, une phrase
    // entière tomberait à cheval sur la coupure.
    expect(frame).toContain("déléguer à Claude");
    setup.renderer.destroy();
  });

  it("l'explication ne décale pas les réglages qui la suivent", async () => {
    // Rendue en ligne, elle poussait vers le bas tous les champs suivants dès
    // qu'elle apparaissait : descendre d'un cran faisait sauter la liste
    // entière. Sa place est réservée en pied de panneau, donc les libellés
    // restent aux mêmes lignes quelle que soit la sélection.
    const setup = await mount();
    const lineOf = (frame: string, label: string): number => frame.split("\n").findIndex((line) => line.includes(label));

    const before = lineOf(setup.captureCharFrame(), "Agents refusés");
    await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    expect(lineOf(setup.captureCharFrame(), "Agents refusés")).toBe(before);
    setup.renderer.destroy();
  });

  it('marque "← global" un champ hérité, jamais un champ que la couche active déclare elle-même', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("← global");
    // max_depth n'est déclaré nulle part : hérité du défaut, une marque différente.
    expect(frame).toContain("← défaut");
    setup.renderer.destroy();
  });

  it('aucune marque quand la couche active ("project") déclare elle-même le champ', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { max_parallel: 9 } } };
    state.draft = { policy: { max_parallel: 3 } };
    const setup = await mount(state);
    expect(setup.captureCharFrame()).not.toContain("← global");
    setup.renderer.destroy();
  });

  it("aucune ligne ne déborde de la largeur du terminal, si étroit soit-il", async () => {
    for (const width of [70, 100, 180]) {
      const setup = await mount(makeState(), { width, height: 30 });
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      }
      setup.renderer.destroy();
    }
  });
});
