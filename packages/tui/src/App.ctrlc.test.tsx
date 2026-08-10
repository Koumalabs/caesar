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
 * Même thème, même garde-fou (tâche 15) : changer de portée d'édition ("p")
 * avec des modifications en attente ne doit pas non plus les abandonner en
 * silence — reprend le même harnais (`mountApp`/`waitForLoaded` ci-dessous)
 * pour le vérifier.
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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { configPathFor } from "@orch/core";
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

// Les deux tests ci-dessous fixent eux-mêmes `exitOnCtrlC: false` sur le
// renderer de test (`mountApp`) : ils prouvent qu'`App` gère bien Ctrl+C
// dans cette configuration, mais ne font jamais tourner `main.tsx` — une
// régression qui y retirerait l'option ne serait donc détectée par aucun des
// deux (tâche 10, C). Un test qui exécuterait vraiment `main.tsx` toucherait
// `process.argv`/un vrai `CliRenderer` pour un bénéfice marginal ; vérifier
// que le fichier source passe bien l'option à `createCliRenderer` suffit.
describe("main.tsx (câblage minimal, sans monter le TUI)", () => {
  it("désactive exitOnCtrlC sur le renderer qu'il crée", async () => {
    const source = await readFile(new URL("./main.tsx", import.meta.url), "utf8");
    const call = source.match(/createCliRenderer\(([^)]*)\)/);
    expect(call, "main.tsx doit appeler createCliRenderer(...)").not.toBeNull();
    expect(call![1]).toMatch(/exitOnCtrlC:\s*false/);
  });
});

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

describe("portée d'édition", () => {
  it("la barre d'état affiche la portée active en permanence, \"project\" au démarrage", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("PORTÉE : PROJET");
    setup.renderer.destroy();
  });

  it("\"p\" sans modification en attente change de portée directement, sans confirmation", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);
    expect(setup.captureCharFrame()).toContain("PORTÉE : PROJET");

    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());

    const frame = setup.captureCharFrame();
    expect(frame).toContain("PORTÉE : LOCAL"); // project → local, le cran suivant du cycle
    expect(frame).not.toContain("Modifications non enregistrées");
    setup.renderer.destroy();
  });

  it("\"p\" avec des modifications en attente demande confirmation, ne change rien tant qu'elle n'est pas donnée", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);

    // Une vraie modification en attente sur la couche "project" (voir le test Ctrl+C ci-dessus, même geste).
    await act(async () => setup.mockInput.pressKey(" "));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("modifications non enregistrées");

    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Modifications non enregistrées");
    expect(frame).toContain("PORTÉE : PROJET"); // toujours "project" : rien n'a changé tant que ce n'est pas confirmé

    // "n" annule : la portée et la modification en attente survivent toutes les deux.
    await act(async () => setup.mockInput.pressKey("n"));
    await act(async () => setup.renderOnce());
    frame = setup.captureCharFrame();
    expect(frame).toContain("PORTÉE : PROJET");
    expect(frame).toContain("modifications non enregistrées");

    // "p" à nouveau puis "o" confirme : la portée change, et la modification en attente est abandonnée
    // (jamais en silence : il a fallu la confirmation explicite ci-dessus).
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    await act(async () => setup.mockInput.pressKey("o"));
    await act(async () => setup.renderOnce());
    frame = setup.captureCharFrame();
    expect(frame).toContain("PORTÉE : LOCAL");
    expect(frame).toContain("tout est enregistré"); // la nouvelle couche ("local") n'a, elle, rien en attente

    setup.renderer.destroy();
  });

  it("le scénario qui compte, à travers l'interface réelle : \"p\" jusqu'à \"global\", puis \"s\" n'écrit que le fichier global", async () => {
    const setup = await mountApp();
    await waitForLoaded(setup);

    // project → local → global : deux "p", aucune modification en attente entre les deux donc aucune confirmation.
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    await act(async () => setup.mockInput.pressKey("p"));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("PORTÉE : GLOBAL");

    // Espace sur la première ligne (onglet Agents, par défaut) : une vraie modification, en attente sur "global".
    await act(async () => setup.mockInput.pressKey(" "));
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("modifications non enregistrées");

    await act(async () => setup.mockInput.pressKey("s"));
    // `saveConfigState` est asynchrone (écriture disque, hors du planificateur de rendu d'OpenTUI) :
    // `waitForFrame` s'arrête dès qu'il croit le planificateur inactif, avant que l'écriture disque
    // n'ait eu le temps de se résoudre — un sondage à intervalles réels (comme `IntegrationsScreen.
    // render.test.tsx`, même motif) est plus fiable ici qu'une seule attente courte.
    let frame = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      await act(async () => {
        await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));
        await setup.renderOnce();
      });
      frame = setup.captureCharFrame();
      if (frame.includes("Enregistré dans") || !frame.includes("Enregistrement…")) break;
    }
    // Le message de confirmation nomme le fichier écrit et la couche — sur cette largeur de terminal (100
    // colonnes), la ligne de statut au complet (portée + indicateur + message) déborde sur deux lignes de la
    // grille capturée : chercher "Enregistré dans"/"couche globale" séparément évite de dépendre de cet
    // enchaînement visuel, non garanti par `captureCharFrame` (un simple artefact de largeur, pas un défaut).
    expect(frame).toContain("Enregistré dans");
    expect(frame).toContain("couche globale");

    const globalContent = await readFile(configPathFor("global", root), "utf8");
    expect(globalContent).toContain("denied");

    // Le fichier projet, lui, n'a jamais été créé : aucune écriture n'a touché cette couche.
    await expect(readFile(configPathFor("project", root), "utf8")).rejects.toThrow();

    setup.renderer.destroy();
  });
});
