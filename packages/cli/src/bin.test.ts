/**
 * Deux niveaux de test pour `bin.ts` :
 * - un test structurel, qui construit le programme (`buildProgram`) sans
 *   jamais parser `process.argv` ni toucher au disque ;
 * - une poignée de tests qui lancent le vrai binaire compilé
 *   (`dist/bin.js`) en sous-processus — le seul endroit de cette tâche où
 *   le comportement du binaire lui-même est en jeu (câblage commander,
 *   codes de sortie, séparation stdout/stderr), donc justifiant un vrai
 *   sous-processus plutôt qu'un appel direct de fonction.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "./bin.js";
import { makeIo, type CapturedIo } from "../test/support.js";

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe("buildProgram (structurel)", () => {
  it("expose toutes les sous-commandes du brief", () => {
    const io = makeIo();
    const program = buildProgram(io, { value: 0 });
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["agents", "apply", "cancel", "config", "diff", "doctor", "init", "logs", "mcp", "policy", "protocol", "ps", "role", "run"]);

    const agents = program.commands.find((c) => c.name() === "agents")!;
    expect(agents.commands.map((c) => c.name()).sort()).toEqual(["disable", "enable", "list", "test"]);

    const role = program.commands.find((c) => c.name() === "role")!;
    expect(role.commands.map((c) => c.name()).sort()).toEqual(["add", "list", "remove", "show"]);

    const policy = program.commands.find((c) => c.name() === "policy")!;
    expect(policy.commands.map((c) => c.name()).sort()).toEqual(["allow", "deny", "show"]);

    const protocol = program.commands.find((c) => c.name() === "protocol")!;
    expect(protocol.commands.map((c) => c.name()).sort()).toEqual(["schema"]);

    const mcp = program.commands.find((c) => c.name() === "mcp")!;
    expect(mcp.commands.map((c) => c.name()).sort()).toEqual(["install", "serve"]);
  });
});

describe("orch (binaire compilé)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-bin-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--help sort en code 0", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--help"]);
    expect(stdout).toContain("Orchestrateur de sous-agents");
  });

  it("un argument requis manquant sort en code 2, message une seule fois sur stderr", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "run"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "run"]);
    } catch (error) {
      const stderr = (error as { stderr: string }).stderr;
      const occurrences = stderr.split("missing required argument").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("--root et --json fonctionnent placés après la sous-commande, sortie JSON pure sur stdout", async () => {
    const { stdout, stderr } = await execFileAsync("node", [BIN_PATH, "protocol", "schema", "task", "--root", root, "--json"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toMatch(/\x1b\[/);
    expect(stderr).toBe("");
  });
});
