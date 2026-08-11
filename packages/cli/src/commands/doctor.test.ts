import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveLayer } from "@orch/core";
import { makeIo, withFakeHome, withShimmedPath, writeVersionFailShim, writeVersionOkShim, type CapturedIo } from "../../test/support.js";
import { runDoctor } from "./doctor.js";
import { EXIT_OK, terminalWidth } from "../output.js";

describe("orch doctor", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-doctor-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "orch-cli-doctor-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("un agent installé et répondant à --version, un agent absent : les deux apparaissent correctement", async () => {
    await withFakeHome(async () => {
      // "codex" (premier du catalogue) est le seul shimmé : présent avec une
      // version connue. Les quatre autres restent absents (PATH maîtrisé,
      // voir withShimmedPath) — jamais un vrai CLI d'agent n'est invoqué.
      await writeVersionOkShim(shimDir, "codex", "codex-shim 9.9.9");

      const code = await withShimmedPath(shimDir, () => runDoctor(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);

      const parsed = JSON.parse(io.stdoutText());
      const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
      expect(codex.installed).toBe(true);
      expect(codex.version).toBe("codex-shim 9.9.9");
      expect(parsed.missing).not.toContain("codex");

      const antigravity = parsed.agents.find((a: { id: string }) => a.id === "antigravity");
      expect(antigravity.installed).toBe(false);
      expect(antigravity.version).toBeUndefined();
      expect(parsed.missing).toContain("antigravity");
    });
  });

  it("un agent déclaré par chemin explicite n'envoie pas chercher dans le PATH quand le chemin ne désigne rien", async () => {
    await withFakeHome(async () => {
      await saveLayer("project", root, { agents: [{ id: "mon-cli", bin: "/opt/rien/du/tout", args: ["{{prompt}}"] }] });

      await withShimmedPath(shimDir, () => runDoctor(root, {}, io));
      const out = io.stdoutText();

      // Fragment court : les puces sont repliées à la largeur du terminal
      // (`wrapText`), une phrase entière tomberait sur deux lignes.
      expect(out).toMatch(/"\/opt\/rien\/du\/tout" n'existe pas/);
      // Le conseil doit porter sur le chemin, pas sur une installation.
      expect(out).toMatch(/Corrigez le chemin/);
      // Les agents natifs, eux, restent bien décrits par leur absence du PATH.
      expect(out).toMatch(/binaire "codex" introuvable dans le PATH/);
    });
  });

  it("un binaire installé qui échoue sur --version est signalé \"version inconnue\", sans bloquer la commande", async () => {
    await withFakeHome(async () => {
      await writeVersionFailShim(shimDir, "codex");

      const code = await withShimmedPath(shimDir, () => runDoctor(root, { json: true }, io));
      expect(code).toBe(EXIT_OK);

      const parsed = JSON.parse(io.stdoutText());
      const codex = parsed.agents.find((a: { id: string }) => a.id === "codex");
      expect(codex.installed).toBe(true);
      expect(codex.version).toBeUndefined();
    });
  });

  it("sortie humaine : tableau compact, puis ce qui est à installer et ce qui est refusé", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runDoctor(root, {}, io));
      expect(code).toBe(EXIT_OK);
      const out = io.stdoutText();
      expect(out).toContain("codex");
      expect(out).toContain("À installer");
      expect(out).not.toMatch(/\x1b\[/);

      // Un binaire absent appelle une action, un agent refusé n'en appelle
      // aucune : les ranger sous un même « À corriger » revenait à proposer de
      // défaire un refus voulu — celui de `claude` par `allow_recursion`, qui
      // est le réglage par défaut.
      expect(out).not.toContain("À corriger");

      // La colonne « binaire » n'est plus dans la vue par défaut : le chemin,
      // additionné des capacités en toutes lettres, est ce qui la faisait
      // déborder.
      expect(out).not.toMatch(/^agent\s+binaire/m);
    });
  });

  it("--verbose rétablit la colonne du binaire", async () => {
    await withFakeHome(async () => {
      const code = await withShimmedPath(shimDir, () => runDoctor(root, { verbose: true }, io));
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toMatch(/^agent\s+binaire\s+version/m);
    });
  });

  it("aucune ligne ne dépasse la largeur du terminal", async () => {
    // Le défaut constaté à l'usage : l'énumération des capacités poussait la
    // dernière colonne au-delà du bord, où le terminal la repliait sur la
    // ligne suivante — le tableau devenait illisible précisément là où il
    // devait renseigner. Vérifié sur les deux vues, la compacte et la
    // détaillée : c'est `renderTable` qui plafonne, pas le choix des colonnes.
    await withFakeHome(async () => {
      for (const options of [{}, { verbose: true }]) {
        const io2 = makeIo();
        await withShimmedPath(shimDir, () => runDoctor(root, options, io2));
        const tooWide = io2
          .stdoutText()
          .split("\n")
          .filter((line) => line.length > terminalWidth());
        expect(tooWide).toEqual([]);
      }
    });
  });
});
