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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { buildProgram } from "./bin.js";
import { makeIo, type CapturedIo } from "../test/support.js";

const execFileAsync = promisify(execFile);
const BIN_PATH = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe("buildProgram (structurel)", () => {
  it("expose toutes les sous-commandes du brief", () => {
    const io = makeIo();
    const program = buildProgram(io, { value: 0 });
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["agents", "apply", "cancel", "channel", "config", "diff", "doctor", "gc", "init", "logs", "mcp", "policy", "protocol", "ps", "role", "run"]);

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

    const channel = program.commands.find((c) => c.name() === "channel")!;
    expect(channel.commands.map((c) => c.name()).sort()).toEqual(["serve"]);
  });

  it("\"config\" déclare --root/--json via withCommonOptions, comme les autres sous-commandes (tâche 10, C)", () => {
    const io = makeIo();
    const program = buildProgram(io, { value: 0 });
    const config = program.commands.find((c) => c.name() === "config")!;
    const flags = config.options.map((o) => o.long).sort();
    expect(flags).toEqual(["--json", "--root"]);
    // "doctor" passe par le même `withCommonOptions` : on vérifie qu'il porte
    // ces deux options, sans exiger qu'il n'en porte aucune autre — il déclare
    // en propre un `--verbose`, et une commande qui gagne une option propre ne
    // doit pas faire échouer un test qui parle des options *communes*.
    const doctor = program.commands.find((c) => c.name() === "doctor")!;
    expect(doctor.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--json", "--root"]));
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

  it("--version affiche la version du package.json, sort en code 0", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--version"]);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("\"channel\" est masqué de l'aide (tâche 12, sous-commande interne), mais reste joignable", async () => {
    const { stdout } = await execFileAsync("node", [BIN_PATH, "--help"]);
    expect(stdout).not.toContain("channel");

    // Joignable explicitement malgré l'absence de l'aide : une option requise
    // manquante (`--task-dir`) produit son erreur habituelle (code 2, comme
    // tout argument/option requis manquant ailleurs dans ce CLI) plutôt
    // qu'une commande inconnue — la sous-commande est bien câblée, seulement
    // cachée.
    await expect(execFileAsync("node", [BIN_PATH, "channel", "serve"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "channel", "serve"]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/--task-dir/);
    }
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

  // Tâche 10, C : le filet d'exception de `bin.ts` distingue désormais une
  // erreur de configuration/usage (code 2, comportement historique) d'un
  // vrai échec d'exécution (code 1) — les deux tests suivants prouvent
  // chaque branche plutôt que de se fier à la seule lecture du code.

  it("un fichier de configuration invalide sort en code 2 (erreur de configuration, pas d'exécution)", async () => {
    await mkdir(join(root, ".orch"), { recursive: true });
    await writeFile(join(root, ".orch", "config.toml"), "ceci n'est pas du toml valide [[[", "utf8");

    await expect(execFileAsync("node", [BIN_PATH, "policy", "show", "--root", root])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "policy", "show", "--root", root]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/TOML invalide/);
    }
  });

  it("une vraie erreur système non anticipée (répertoire non accessible en écriture) sort en code 1, pas 2", async () => {
    const orchDir = join(root, ".orch");
    await mkdir(orchDir, { recursive: true });
    // Lecture toujours possible (aucun config.toml : chemin "absent", pas une
    // erreur), écriture impossible : `saveProjectConfig` (appelé par
    // `policy allow`) échoue avec une vraie erreur système (`EACCES`), jamais
    // ré-enveloppée en `Error` métier — contrairement à `loadConfig`.
    await chmod(orchDir, 0o500);
    try {
      await expect(execFileAsync("node", [BIN_PATH, "policy", "allow", "codex", "--root", root])).rejects.toMatchObject({ code: 1 });
    } finally {
      await chmod(orchDir, 0o700);
    }
  });

  it("\"config --json\" est refusé explicitement, pas silencieusement ignoré (revue de la tâche 10)", async () => {
    await expect(execFileAsync("node", [BIN_PATH, "config", "--root", root, "--json"])).rejects.toMatchObject({ code: 2 });
    try {
      await execFileAsync("node", [BIN_PATH, "config", "--root", root, "--json"]);
    } catch (error) {
      expect((error as { stderr: string }).stderr).toMatch(/--json/);
    }
  });
});
