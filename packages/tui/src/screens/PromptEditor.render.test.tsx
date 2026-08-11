/**
 * L'éditeur de prompt est le seul écran du TUI qui écrit un fichier sans
 * passer par "s" : ces tests portent donc autant sur ce qu'il **écrit** que
 * sur ce qu'il affiche.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PromptEditor } from "./PromptEditor";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orch-prompt-editor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  setup: Awaited<ReturnType<typeof testRender>>;
  closes: boolean[];
  messages: Array<{ text: string; isError: boolean }>;
}

async function mount(file = "roles/reviewer.md"): Promise<Harness> {
  const closes: boolean[] = [];
  const messages: Array<{ text: string; isError: boolean }> = [];
  const setup = await act(async () =>
    testRender(
      <PromptEditor
        root={root}
        roleName="reviewer"
        systemPromptFile={file}
        onClose={(saved) => closes.push(saved)}
        notify={(text, isError = false) => messages.push({ text, isError })}
      />,
      { width: 100, height: 24 },
    ),
  );
  // La lecture du fichier est asynchrone : le champ n'est monté qu'ensuite.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.renderOnce();
  });
  return { setup, closes, messages };
}

/**
 * Une touche Échap isolée reste en attente dans le décodeur du clavier —
 * `\x1b` est aussi le premier octet de toutes les séquences d'échappement,
 * qu'il faut donc laisser arriver avant de trancher. Un vrai terminal purge
 * cette attente au bout de quelques millisecondes ; le harnais de test, lui,
 * n'avance pas seul : sans cette pause, Échap n'atteint jamais l'écran.
 */
async function pressEscape(setup: Harness["setup"]): Promise<void> {
  await act(async () => {
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  // Second `act` : le premier ne rend que ce que React avait déjà validé
  // avant la frappe. Peindre dans le même bloc capturerait l'écran d'avant.
  await act(async () => setup.renderOnce());
}

describe("PromptEditor", () => {
  it("montre le chemin absolu réellement lu par le moteur", async () => {
    // Sans lui, on édite à l'aveugle : un rôle venu de la couche globale
    // résout son prompt dans le projet courant, ce que seul le chemin montre.
    await mkdir(join(root, ".orch", "roles"), { recursive: true });
    await writeFile(join(root, ".orch", "roles", "reviewer.md"), "Tu es strict.", "utf8");

    const { setup } = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain(join(root, ".orch", "roles", "reviewer.md"));
    expect(frame).toContain("Tu es strict.");
    setup.renderer.destroy();
  });

  it("annonce un fichier qui n'existe pas encore plutôt que d'afficher un vide ambigu", async () => {
    const { setup } = await mount();
    expect(setup.captureCharFrame()).toContain("Nouveau fichier");
    setup.renderer.destroy();
  });

  it("Ctrl+S écrit le fichier, le dit, et rend la main", async () => {
    const { setup, closes, messages } = await mount();

    await act(async () => {
      await setup.mockInput.typeText("Ne corrige rien toi-même.");
      await setup.renderOnce();
    });
    await act(async () => setup.mockInput.pressKey("s", { ctrl: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
    });

    const written = await readFile(join(root, ".orch", "roles", "reviewer.md"), "utf8");
    expect(written).toBe("Ne corrige rien toi-même.");
    expect(closes).toEqual([true]);
    expect(messages[0]?.text).toContain("enregistré");
    setup.renderer.destroy();
  });

  it("Échap sur un texte modifié prévient d'abord, n'abandonne qu'à la seconde frappe", async () => {
    const { setup, closes } = await mount();

    await act(async () => {
      await setup.mockInput.typeText("un ajout");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await setup.renderOnce();
    });

    await pressEscape(setup);
    expect(closes).toEqual([]); // rien n'est abandonné sur la première frappe
    expect(setup.captureCharFrame()).toContain("Modifications non enregistrées");

    await pressEscape(setup);
    expect(closes).toEqual([false]);
    setup.renderer.destroy();
  });

  it("Échap sur un texte inchangé rend la main tout de suite", async () => {
    const { setup, closes } = await mount();
    await pressEscape(setup);
    expect(closes).toEqual([false]);
    setup.renderer.destroy();
  });

  it("dit que l'écriture est indépendante du \"s\" global", async () => {
    const { setup } = await mount();
    expect(setup.captureCharFrame()).toContain("enregistrer le fichier");
    setup.renderer.destroy();
  });
});
