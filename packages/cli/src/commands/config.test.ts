import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIo, withShimmedPath, type CapturedIo } from "../../test/support.js";
import { configureInProcessTui, runConfig } from "./config.js";
import { EXIT_RUNTIME } from "../output.js";

/**
 * Dépose un faux "bun" qui n'a rien d'un vrai runtime : il note dans
 * `captureFile` les arguments qu'il a reçus et son répertoire courant, puis
 * sort avec `exitCode`. Suffisant pour vérifier ce que `runConfig` construit
 * et lance, sans jamais monter le moindre rendu OpenTUI dans les tests
 * `vitest` de `packages/cli` (le vrai TUI, lui, tourne sous `bun test` —
 * voir le rapport de la tâche).
 */
async function writeFakeBunShim(dir: string, options: { captureFile: string; exitCode: number }): Promise<void> {
  const target = join(dir, "bun");
  const script = `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(options.captureFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${options.exitCode});
`;
  await writeFile(target, script, "utf8");
  await chmod(target, 0o755);
}

describe("caesar config — bun absent", () => {
  let root: string;
  let shimDir: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-config-shim-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("explique la situation, renvoie vers les sous-commandes équivalentes, et ne lance rien", async () => {
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(EXIT_RUNTIME);
      expect(io.stderrText()).toMatch(/Bun/);
      expect(io.stderrText()).toContain("caesar policy show");
      expect(io.stderrText()).toContain("caesar role list");
      expect(io.stderrText()).toContain("caesar agents list");
    });
  });
});

describe("caesar config — bun présent", () => {
  let root: string;
  let shimDir: string;
  let captureFile: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-config-shim-"));
    captureFile = join(shimDir, "capture.json");
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  });

  it("construit la bonne ligne de commande (main.tsx du TUI, racine du projet) et propage le code de sortie", async () => {
    await writeFakeBunShim(shimDir, { captureFile, exitCode: 0 });
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(0);

      const captured = JSON.parse(await readFile(captureFile, "utf8")) as { argv: string[]; cwd: string };
      expect(captured.argv).toHaveLength(2);
      expect(captured.argv[0]).toMatch(/packages[\\/]tui[\\/]src[\\/]main\.tsx$/);
      expect(captured.argv[1]).toBe(root);
    });
  });

  it("propage un code de sortie non nul", async () => {
    await writeFakeBunShim(shimDir, { captureFile, exitCode: 7 });
    await withShimmedPath(shimDir, async () => {
      const code = await runConfig(root, io);
      expect(code).toBe(7);
    });
  });
});

describe("caesar config — lanceur in-process configuré (tâche 12)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-config-root-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    // Toujours restaurer l'absence de lanceur : un test qui laisserait un
    // lanceur configuré empoisonnerait tous les tests suivants de ce
    // fichier, y compris ceux du chemin Node par défaut ci-dessus.
    configureInProcessTui(undefined);
  });

  it("délègue au lanceur configuré plutôt que de chercher \"bun\", et rend son code de sortie — sans jamais toucher au PATH", async () => {
    let receivedRoot: string | undefined;
    configureInProcessTui(async (r) => {
      receivedRoot = r;
      return 3;
    });

    // Aucun `withShimmedPath` ici, délibérément : si `runConfig` retombait
    // par erreur sur le chemin spawn (bug de régression), l'absence de
    // "bun" shimmé le ferait échouer de façon visible plutôt que de
    // masquer le bug en fournissant un faux binaire qui répondrait quand
    // même correctement.
    const code = await runConfig(root, io);
    expect(code).toBe(3);
    expect(receivedRoot).toBe(root);
  });
});
