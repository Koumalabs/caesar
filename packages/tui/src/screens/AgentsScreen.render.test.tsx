/**
 * Test de rendu minimal — "se monte sans lever" (voir le brief : un test de
 * montage par écran suffit, pas plus). `@opentui/core/testing` fournit un
 * renderer hors-terminal (`testRender`/`captureCharFrame`), sans dépendre
 * d'un vrai TTY.
 *
 * Deux tests supplémentaires (tâche 15), tous deux vérifiés via
 * `captureCharFrame()` — la sortie fiable de ce projet pour le rendu, à la
 * différence d'une capture pty réelle (`script`) : un essai de rendu du
 * binaire autonome sous pty a bien montré le sélecteur de portée et les
 * marques, mais deux réécritures successives de la même ligne s'y sont
 * révélées illisibles à la relecture — artefact de capture (probablement des
 * réponses de capacités du terminal hôte entrelacées dans le flux), pas un
 * défaut du TUI ; voir le rapport de la tâche pour le détail. `captureCharFrame`
 * n'a pas ce problème (grille interne d'OpenTUI, jamais de vrai pty) :
 *  - les marques d'héritage ("← global") apparaissent quand la couche active
 *    ne déclare pas encore "denied" ;
 *  - un chemin de binaire plus long que sa colonne est tronqué avec une
 *    élision, sans déborder sur la colonne "version" voisine (défaut connu
 *    corrigé par cette tâche, `fitColumn` dans `shared.ts`).
 */
import { describe, expect, it } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { AgentInstallStatus } from "@orch/core";
import { emptyConfigState as makeState } from "../state/test-helpers";
import { AgentsScreen } from "./AgentsScreen";

describe("AgentsScreen", () => {
  it("se monte sans lever et affiche le catalogue d'agents", async () => {
    const state = makeState();
    const setup = await act(async () =>
      testRender(<AgentsScreen state={state} installed={null} onToggleDenied={() => {}} />, { width: 100, height: 30 }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain("codex");
    expect(frame).toContain("antigravity");
    expect(frame).toContain("capacités");
    expect(frame).toContain("Détection de l'installation en cours");
    setup.renderer.destroy();
  });

  it("signale que \"denied\" est hérité de la couche globale tant que la couche active ne le déclare pas", async () => {
    const state = makeState(); // portée "project" active, "global" déclare seule policy.denied
    state.layers[0] = { ...state.layers[0]!, override: { policy: { denied: ["copilot"] } } };
    const setup = await act(async () =>
      testRender(<AgentsScreen state={state} installed={null} onToggleDenied={() => {}} />, { width: 100, height: 30 }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    expect(frame).toContain('"denied" hérité ← global');
    // "allowed" n'est déclaré nulle part : hérité du défaut, pas de "global" — la marque le distingue.
    expect(frame).toContain('"allowed" hérité ← défaut');
    setup.renderer.destroy();
  });

  it("tronque un chemin de binaire trop long avec une élision, sans déborder sur la colonne suivante", async () => {
    const state = makeState();
    const longPath = "/Users/quelquun/.local/share/mise/installs/node/22.11.0/bin/a-very-long-toolchain-path/codex-cli-binary";
    const installed = new Map<string, AgentInstallStatus>([
      ["codex", { id: "codex", bin: "codex", installed: true, path: longPath, version: "1.2.3" }],
    ]);
    const setup = await act(async () =>
      testRender(<AgentsScreen state={state} installed={installed} onToggleDenied={() => {}} />, { width: 100, height: 30 }),
    );
    await act(async () => setup.renderOnce());
    const frame = setup.captureCharFrame();
    // Jamais le chemin complet (déborderait sur "version") : coupé, avec une élision.
    expect(frame).not.toContain(longPath);
    expect(frame).toContain("…");
    // La colonne "version", juste après, reste lisible et intacte malgré le chemin long qui la précède.
    expect(frame).toContain("1.2.3");
    setup.renderer.destroy();
  });
});
