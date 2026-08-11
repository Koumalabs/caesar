import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { RolesScreen } from "./RolesScreen";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orch-tui-roles-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const callbacks = { onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

async function mount(state = makeState(), size = { width: 120, height: 34 }) {
  const setup = await act(async () =>
    testRender(<RolesScreen root={root} state={state} installed={null} {...callbacks} />, size),
  );
  await act(async () => setup.renderOnce());
  return setup;
}

/** Laisse l'aperçu du prompt (lecture de fichier, asynchrone) arriver avant de capturer. */
async function settle(setup: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await setup.renderOnce();
  });
}

describe("RolesScreen", () => {
  it("affiche les rôles et les champs du rôle sélectionné", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("reviewer");
    expect(frame).toContain("implementer");
    expect(frame).toContain("Intention");
    expect(frame).toContain("Agents");
    // Le nom du rôle est désormais un champ à part entière : un rôle se renomme
    // sans passer par le fichier TOML.
    expect(frame).toContain("Nom");
    setup.renderer.destroy();
  });

  it("signale qu'un rôle redéfini globalement est hérité, pas déclaré par la couche active", async () => {
    const state = makeState();
    state.layers[0] = {
      ...state.layers[0]!,
      override: {
        roles: [
          { name: "reviewer", purpose: "Redéfini globalement.", agents: ["codex"], mode: "read-only", isolation: "inplace", timeout_ms: 600_000 },
        ],
      },
    };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Redéfini globalement.");
    expect(frame).toContain("Hérité ← global");
    setup.renderer.destroy();
  });

  it("montre le prompt système : son chemin, sa taille et ses premières lignes", async () => {
    // Le défaut central que cet écran corrige : le prompt n'existait à
    // l'écran que sous forme de chemin, alors que ce fichier *est* ce que
    // l'agent reçoit en tête de contexte.
    await mkdir(join(root, ".orch", "roles"), { recursive: true });
    await writeFile(join(root, ".orch", "roles", "reviewer.md"), "Tu es un relecteur strict.\nNe corrige rien toi-même.\n", "utf8");

    const setup = await mount();
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("roles/reviewer.md");
    expect(frame).toContain("Tu es un relecteur strict.");
    expect(frame).toContain("caractères");
    setup.renderer.destroy();
  });

  it("dit qu'un prompt déclaré mais absent du disque reste à créer", async () => {
    const setup = await mount();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("à créer");
    setup.renderer.destroy();
  });

  it("l'aide de touches suit le niveau de focus", async () => {
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("nouveau");

    // Entrer dans les champs : les touches proposées changent.
    await act(async () => setup.mockInput.pressEnter());
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("revenir aux rôles");
    // …et le champ sélectionné s'explique.
    expect(frame).toContain("orch run --role");
    setup.renderer.destroy();
  });

  it("propose d'ouvrir l'éditeur quand on atteint le champ du prompt", async () => {
    const setup = await mount();
    await act(async () => setup.mockInput.pressEnter());
    // name, purpose, agents, mode, isolation, timeout, prompt : six crans.
    for (let i = 0; i < 6; i++) await act(async () => setup.mockInput.pressKey("j"));
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("éditer le prompt");
    expect(frame).toContain("changer le fichier");
    setup.renderer.destroy();
  });

  it("aucune ligne ne déborde de la largeur du terminal", async () => {
    for (const width of [80, 120, 200]) {
      const setup = await mount(makeState(), { width, height: 34 });
      await settle(setup);
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      }
      setup.renderer.destroy();
    }
  });
});
