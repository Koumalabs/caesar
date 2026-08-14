/**
 * Ce que ces tests protègent, et pourquoi : chaque assertion correspond à un
 * défaut constaté à l'usage sur l'ancien écran — colonnes qui se touchent,
 * capacités remplacées par leur décompte, motif de refus parti hors de
 * l'écran. Vérifié via `captureCharFrame()`, la grille interne d'OpenTUI :
 * une capture pty réelle du binaire s'est révélée illisible (réécritures
 * successives entrelacées dans le flux), artefact de capture et non défaut du
 * TUI — voir le rapport de la tâche 15.
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { AgentInstallStatus } from "@caesar/core";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { AgentsScreen } from "./AgentsScreen";

/** Les rappels que l'écran ne déclenche que sur frappe : inertes dans un test de rendu. */
const callbacks = { onToggleDenied: () => {}, onChange: () => {}, onEditingChange: () => {}, notify: () => {} };

/** Cinq agents natifs séparent la sélection initiale (codex) d'une déclaration ajoutée en fin de catalogue. */
const NATIVE_COUNT = 5;

async function mount(
  state = makeState(),
  installed: Map<string, AgentInstallStatus> | null = null,
  size = { width: 100, height: 40 },
) {
  const setup = await act(async () => testRender(<AgentsScreen state={state} installed={installed} {...callbacks} />, size));
  await act(async () => setup.renderOnce());
  return setup;
}

async function pressDown(setup: Awaited<ReturnType<typeof mount>>, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => setup.mockInput.pressKey("j"));
  await act(async () => setup.renderOnce());
}

describe("AgentsScreen — le tableau", () => {
  it("affiche le catalogue, ses capacités nommées, et l'état de détection", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex");
    expect(frame).toContain("antigravity");
    // Le défaut corrigé : la colonne annonçait « 7 notable(s) » — un décompte
    // à la place de l'information.
    expect(frame).not.toContain("notable(s)");
    expect(frame).toContain("reprise");
    expect(frame).toContain("Détection de l'installation en cours");
    setup.renderer.destroy();
  });

  it("ne colle jamais deux colonnes l'une à l'autre, ni ne déborde de la largeur", async () => {
    // Le défaut d'origine, exactement : une valeur tronquée venait toucher la
    // colonne suivante ("…codex-cli 0.1…7 notable(s)"), et les deux se
    // lisaient comme un seul mot.
    for (const width of [60, 100, 200]) {
      const setup = await mount(makeState(), null, { width, height: 40 });
      for (const line of setup.captureCharFrame().split("\n")) {
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
        expect(line).not.toMatch(/…\S/);
      }
      setup.renderer.destroy();
    }
  });
});

describe("AgentsScreen — le détail de l'agent sélectionné", () => {
  it("montre le chemin du binaire, les capacités en toutes lettres et les rôles qui l'emploient", async () => {
    const installed = new Map<string, AgentInstallStatus>([
      ["codex", { id: "codex", bin: "codex", installed: true, path: "/opt/toolchain/bin/codex", version: "1.2.3" }],
    ]);
    const setup = await mount(makeState(), installed);
    const frame = setup.captureCharFrame();
    // Le chemin a quitté le tableau — même leçon que `caesar doctor` — pour le
    // détail, où il ne dispute plus sa place aux colonnes utiles au survol.
    expect(frame).toContain("/opt/toolchain/bin/codex");
    expect(frame).toContain("lecture-seule native");
    expect(frame).toContain("Employé par");
    expect(frame).toContain("implementer");
    setup.renderer.destroy();
  });

  it("replie le motif d'un refus au lieu de le laisser partir hors de l'écran", async () => {
    const state = makeState();
    state.draft = { policy: { denied: ["codex"] } };
    const setup = await mount(state, new Map());
    const frame = setup.captureCharFrame();
    // Le motif complet fait plus de 80 caractères : il tenait sur une seule
    // ligne dans l'ancien tableau, donc au-delà du bord de l'écran.
    expect(frame).toContain('Agent "codex" refusé');
    expect(frame).toContain('liste "denied"');
    setup.renderer.destroy();
  });

  it("dit clairement qu'un agent natif ne s'édite pas", async () => {
    const setup = await mount();
    expect(setup.captureCharFrame()).toContain("catalogue natif");
    setup.renderer.destroy();
  });
});

describe("AgentsScreen — déclarer un agent hors catalogue", () => {
  it("liste un agent déclaré à la suite du catalogue natif, et le marque", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["--message", "{{prompt}}"], cwdMode: "process" }] };
    const setup = await mount(state, new Map());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex"); // le natif reste
    expect(frame).toContain("aider *"); // l'astérisque distingue une déclaration d'un agent câblé
    expect(frame).toContain("* déclaré en configuration");
    setup.renderer.destroy();
  });

  it("montre la ligne de commande et les champs éditables de l'agent déclaré sélectionné", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["--message", "{{prompt}}"], cwdMode: "process" }] };
    const setup = await mount(state, new Map());

    // Le panneau ne concerne que la ligne sélectionnée : les champs éditables
    // n'apparaissent pas sur "codex" (sélection initiale, agent natif).
    expect(setup.captureCharFrame()).not.toContain("Arguments");

    await pressDown(setup, NATIVE_COUNT);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("aider --message {{prompt}}");
    expect(frame).toContain("Déclaré par la couche active");
    expect(frame).toContain("Binaire");
    expect(frame).toContain("Arguments");
    setup.renderer.destroy();
  });

  it("explique le champ sélectionné une fois entré dans l'édition", async () => {
    const state = makeState();
    state.draft = { agents: [{ id: "aider", bin: "aider", args: ["{{prompt}}"] }] };
    const setup = await mount(state, new Map());
    await pressDown(setup, NATIVE_COUNT);

    // Tant qu'on est dans la liste, aucune explication de champ.
    expect(setup.captureCharFrame()).not.toContain("À défaut, son identifiant");

    await act(async () => setup.mockInput.pressEnter());
    await act(async () => setup.renderOnce());
    expect(setup.captureCharFrame()).toContain("À défaut, son identifiant");
    setup.renderer.destroy();
  });

  it("signale qu'une déclaration héritée sera redéfinie sur la couche active si on l'édite", async () => {
    const state = makeState(); // portée "project" active, "global" seule déclare l'agent
    state.layers[0] = {
      ...state.layers[0]!,
      override: { agents: [{ id: "aider", bin: "aider", args: ["{{prompt}}"] }] },
    };
    const setup = await mount(state, new Map());
    await pressDown(setup, NATIVE_COUNT);
    expect(setup.captureCharFrame()).toContain("Déclaré ← global");
    setup.renderer.destroy();
  });

  it("nomme le réseau de chaque agent du catalogue — l'information qui manquait", async () => {
    const setup = await mount();
    const frame = setup.captureCharFrame();
    // codex n'ouvre le réseau qu'en écriture, opencode l'a ouvert : les deux
    // se présentaient à l'identique avant ce chantier.
    expect(frame).toContain("net(w)");
    expect(frame).toContain("net");
    setup.renderer.destroy();
  });

  it('signale que "denied" est hérité de la couche globale tant que la couche active ne le déclare pas', async () => {
    const state = makeState();
    state.layers[0] = { ...state.layers[0]!, override: { policy: { denied: ["copilot"] } } };
    const setup = await mount(state);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('"denied" hérité ← global');
    // "allowed" n'est déclaré nulle part : hérité du défaut, pas de "global".
    expect(frame).toContain('"allowed" hérité ← défaut');
    setup.renderer.destroy();
  });
});
