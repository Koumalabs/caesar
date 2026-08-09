import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
