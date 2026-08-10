import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, projectConfigPath } from "@orch/core";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runInit } from "./init.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

describe("orch init", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-init-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée la configuration et un prompt système par rôle par défaut", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      expect(config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
      for (const role of config.roles) {
        expect(role.system_prompt_file).toBe(`roles/${role.name}.md`);
        const prompt = await readFile(join(root, ".orch", role.system_prompt_file!), "utf8");
        expect(prompt.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it("refuse d'écraser une configuration existante sans --force", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);

      const io2 = makeIo();
      const code = await runInit(root, {}, io2);
      expect(code).toBe(EXIT_USAGE);
      expect(io2.stderrText()).toContain(projectConfigPath(root));
      expect(io2.stdoutText()).toBe("");
    });
  });

  it("--force écrase une configuration existante", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);
      const io2 = makeIo();
      const code = await runInit(root, { force: true }, io2);
      expect(code).toBe(EXIT_OK);
    });
  });

  it("avertit sans échouer quand le répertoire n'est pas un dépôt git", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stderrText()).toMatch(/dépôt git/);
      expect(io.stderrText()).toMatch(/git init/);
    });
  });

  it("--json rend un JSON exploitable, sans ANSI, et rien d'autre sur stdout", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.config_path).toBe(projectConfigPath(root));
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });

  it("ne signale plus l'avertissement git une fois le répertoire initialisé en dépôt", async () => {
    await withFakeHome(async () => {
      await execFileAsync("git", ["init", "-q"], { cwd: root });
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stderrText()).toBe("");
    });
  });
});

describe("orch init --global", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-init-global-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée ~/.config/orch/config.toml à partir de defaultConfig(), jamais la couche projet", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true }, io);
      expect(code).toBe(EXIT_OK);

      const { config, sources } = await loadConfig(root);
      expect(sources.global).toBe(join(home, ".config", "orch", "config.toml"));
      expect(sources.project).toBeUndefined();
      expect(config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
      expect(config.policy.max_parallel).toBe(4);
    });
  });

  it("refuse d'écraser une configuration globale existante sans --force", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { global: true }, io)).toBe(EXIT_OK);

      const io2 = makeIo();
      const code = await runInit(root, { global: true }, io2);
      expect(code).toBe(EXIT_USAGE);
      expect(io2.stderrText()).toMatch(/globale/);
      expect(io2.stdoutText()).toBe("");
    });
  });

  it("--force écrase une configuration globale existante", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { global: true }, io)).toBe(EXIT_OK);
      const io2 = makeIo();
      expect(await runInit(root, { global: true, force: true }, io2)).toBe(EXIT_OK);
    });
  });

  it("--json rend le chemin et la portée, sans ANSI", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.scope).toBe("global");
      expect(parsed.config_path).toBe(join(home, ".config", "orch", "config.toml"));
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("orch init — complétion du .gitignore (dans un dépôt git)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-init-gitignore-"));
    io = makeIo();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée le .gitignore avec les quatre entrées, quand il n'existait pas", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      const lines = raw.split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual([".orch/config.local.toml", ".orch/tasks/", ".orch/wt/", ".orch/state/"]);
      expect(io.stdoutText()).toMatch(/\.gitignore complété/);
    });
  });

  it("n'ajoute que les lignes absentes, préserve le contenu existant, ne réécrit pas depuis rien", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.orch/tasks/\n", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      // Le contenu original survit intégralement, en tête du fichier.
      expect(raw.startsWith("node_modules/\n.orch/tasks/\n")).toBe(true);
      // Les trois lignes manquantes sont ajoutées ; ".orch/tasks/" (déjà présent) n'est pas dupliqué.
      const lines = raw.split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual(["node_modules/", ".orch/tasks/", ".orch/config.local.toml", ".orch/wt/", ".orch/state/"]);
    });
  });

  it("gère un fichier existant sans retour à la ligne final, sans fusionner la dernière ligne avec la suivante", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw.startsWith("node_modules/\n")).toBe(true);
      expect(raw).toContain(".orch/config.local.toml");
    });
  });

  it("ne touche pas au fichier (aucune écriture) quand toutes les entrées sont déjà présentes", async () => {
    await withFakeHome(async () => {
      const already = "node_modules/\n.orch/config.local.toml\n.orch/tasks/\n.orch/wt/\n.orch/state/\n";
      await writeFile(join(root, ".gitignore"), already, "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw).toBe(already);
      expect(io.stdoutText()).toMatch(/\.gitignore déjà à jour/);
    });
  });
});

describe("orch init — .gitignore hors dépôt git", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-init-nogit-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ne crée aucun .gitignore hors dépôt git, et le dit dans la sortie (JSON et humaine)", async () => {
    await withFakeHome(async () => {
      const io = makeIo();
      const code = await runInit(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.gitignore).toBeNull();

      await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toThrow();

      const io2 = makeIo();
      const code2 = await runInit(root, { force: true }, io2);
      expect(code2).toBe(EXIT_OK);
      expect(io2.stderrText()).toMatch(/gitignore.*n'a pas été complété/);
    });
  });
});
