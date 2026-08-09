import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@orch/core";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runAgentsDisable, runAgentsEnable, runAgentsList, runAgentsTest } from "./agents.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

describe("orch agents list", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-agents-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--json liste le catalogue avec présence, capacités et politique, sans ANSI", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsList(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.agents.map((a: { id: string }) => a.id)).toEqual(["codex", "antigravity", "opencode", "copilot", "claude"]);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });
});

describe("orch agents enable / disable", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-agents-toggle-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("disable puis enable : la modification est persistée dans le TOML et relue", async () => {
    await withFakeHome(async () => {
      expect(await runAgentsDisable(root, "codex", {}, io)).toBe(EXIT_OK);
      let loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).toContain("codex");

      const io2 = makeIo();
      expect(await runAgentsEnable(root, "codex", {}, io2)).toBe(EXIT_OK);
      loaded = await loadConfig(root);
      expect(loaded.config.policy.denied).not.toContain("codex");
    });
  });

  it("--json rapporte l'état final de la liste denied", async () => {
    await withFakeHome(async () => {
      const code = await runAgentsDisable(root, "opencode", { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.denied).toContain("opencode");
    });
  });
});

describe("orch agents test", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-agents-test-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuse un identifiant d'agent inconnu, sans lancer quoi que ce soit", async () => {
    const code = await runAgentsTest(root, "agent-fantome", { yes: true }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/inconnu/);
  });

  it("exige --yes : refuse de lancer une tâche réelle sans confirmation explicite", async () => {
    const code = await runAgentsTest(root, "codex", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/--yes/);
  });

  it("respecte la politique : un agent refusé n'est jamais lancé, même avec --yes", async () => {
    await withFakeHome(async () => {
      await runAgentsDisable(root, "codex", {}, makeIo());
      const code = await runAgentsTest(root, "codex", { yes: true }, io);
      expect(code).toBe(EXIT_USAGE);
      expect(io.stderrText()).toContain("codex");
      expect(io.stderrText()).toMatch(/denied/);
    });
  });

  it("--yes : aller-retour complet avec un agent factice substitué au vrai binaire", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        // "git init" : `agents test` passe par `runTask`, dont l'isolation "inplace"
        // explicite n'a pas besoin d'un dépôt git, mais un dépôt réel écarte
        // toute ambiguïté sur le comportement observé.
        await execFileAsync("git", ["init", "-q"], { cwd: root });
        await execFileAsync("git", ["config", "user.email", "orch-test@example.com"], { cwd: root });
        await execFileAsync("git", ["config", "user.name", "Orch Test"], { cwd: root });

        const code = await runAgentsTest(root, "codex", { yes: true, json: true }, io);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.responded).toBe(true);
        expect(parsed.report_source).toBe("file");
        expect(code).toBe(EXIT_OK);
      }),
    );
  }, 20_000);
});
