/**
 * Ctrl+C avec des modifications en attente ne doit jamais terminer le
 * processus sans confirmation — voir le rapport de correction de la tâche 8
 * (constat critique de revue). `main.tsx` désactive la sortie automatique
 * d'OpenTUI sur Ctrl+C (`exitOnCtrlC: false`) précisément pour que `App`
 * puisse intercepter la touche lui-même et la faire passer par le même
 * chemin que "q" (`isDirty` puis confirmation). Ce test monte `App` avec la
 * même configuration de renderer que `main.tsx` (`createTestRenderer` +
 * `createRoot`, exactement le duo que `main.tsx` utilise avec
 * `createCliRenderer`) et vérifie le comportement réel, pas seulement la
 * lecture du code.
 *
 * `HOME` et `PATH` sont neutralisés (répertoires temporaires, `PATH` sans
 * aucun binaire réel) : `loadConfigState`/`saveConfigState` ne touchent
 * jamais la configuration réelle de l'utilisateur, et `detectAgentInstallation`
 * — appelée au montage par `App` — ne trouve aucun binaire à sonder, donc
 * n'invoque jamais un vrai CLI d'agent (`findBinaryInPath` échoue avant tout
 * `--version`).
 *
 * `process.exit` est neutralisé pendant ces deux tests : si le
 * comportement régressait, le vrai `process.exit` couperait le runner de
 * tests lui-même plutôt que de faire échouer proprement l'assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { App } from "./App";

let home: string;
let root: string;
let emptyPath: string;
let previousHome: string | undefined;
let previousPath: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "orch-tui-ctrlc-home-"));
  root = await mkdtemp(join(tmpdir(), "orch-tui-ctrlc-root-"));
  emptyPath = await mkdtemp(join(tmpdir(), "orch-tui-ctrlc-path-"));
  previousHome = process.env["HOME"];
  previousPath = process.env["PATH"];
  process.env["HOME"] = home;
  process.env["PATH"] = emptyPath; // Aucun binaire réel : aucun agent "installé" à détecter, aucun sous-processus lancé.
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (previousPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = previousPath;
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(emptyPath, { recursive: true, force: true });
});

/** Monte `<App>` exactement comme `main.tsx` : renderer créé d'abord, passé à `createRoot` et en prop à `App`. */
async function mountApp(): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  await act(async () => {
    createRoot(setup.renderer).render(<App root={root} renderer={setup.renderer} />);
  });
  await act(async () => setup.renderOnce());
  return setup;
}

/** Attend que `state` soit chargé (voir `App` : affiche "Chargement…" tant qu'il ne l'est pas). */
async function waitForLoaded(setup: TestRendererSetup): Promise<void> {
  await setup.waitForFrame((frame) => frame.includes("modifications non enregistrées") || frame.includes("tout est enregistré"));
}

describe("Ctrl+C", () => {
  it("avec des modifications en attente : affiche la confirmation, ne quitte pas", async () => {
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
      throw new Error("process.exit appelé alors qu'une confirmation était attendue");
    }) as typeof process.exit;

    try {
      const setup = await mountApp();
      await waitForLoaded(setup);

      // Espace sur la première ligne (Agents, onglet par défaut) bascule
      // l'autorisation du premier agent du catalogue : une vraie
      // modification en attente, la même que celle testée au niveau
      // `config-state.ts` (`toggleAgentDenied`). `pressKey` prend le
      // caractère brut à injecter, pas un nom de touche : " " (espace),
      // pas la chaîne "space" (qui taperait cinq lettres, dont "s" —
      // piège trouvé en écrivant ce test, voir le rapport de correction).
      await act(async () => setup.mockInput.pressKey(" "));
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("modifications non enregistrées");

      await act(async () => setup.mockInput.pressCtrlC());
      await act(async () => setup.renderOnce());

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Modifications non enregistrées");
      expect(frame).toContain("Quitter quand même");
      expect(exitCalled).toBe(false);

      setup.renderer.destroy();
    } finally {
      process.exit = originalExit;
    }
  });

  it("sans modification en attente : quitte directement (même chemin que \"q\")", async () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      const setup = await mountApp();
      await waitForLoaded(setup);
      expect(setup.captureCharFrame()).toContain("tout est enregistré");

      await act(async () => setup.mockInput.pressCtrlC());
      await act(async () => setup.renderOnce());

      expect(exitCode).toBe(0);
    } finally {
      process.exit = originalExit;
    }
  });
});
