import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, projectConfigPath } from "@caesar/core";
import { makeIo, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runInit } from "./init.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

/**
 * Isole entièrement le PATH sur `dir` (plus `/usr/bin`/`/bin`, ni l'un ni
 * l'autre ne contenant de CLI d'agent) : contrairement à `withShimmedPath`
 * (`test/support.ts`), on n'ajoute PAS `dirname(process.execPath)` — ce
 * répertoire peut légitimement héberger un vrai CLI d'agent installé via
 * `npm install -g` à côté de node lui-même (constaté avec `copilot` sur un
 * poste nvm), ce qui fausserait la détection que ces tests vérifient
 * précisément. Sans risque ici : `findBinaryInPath` ne fait qu'un `access`,
 * jamais un `spawn` — le binaire factice n'a donc pas besoin d'être
 * exécutable au sens "tourne vraiment", seulement présent et +x.
 */
async function withIsolatedPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["PATH"];
  process.env["PATH"] = [dir, "/usr/bin", "/bin"].join(delimiter);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

/** Dépose un binaire factice minimal (jamais exécuté, voir `withIsolatedPath`) sous `dir`. */
async function writeFakeBinary(dir: string, name: string): Promise<void> {
  const target = join(dir, name);
  await writeFile(target, "", "utf8");
  await chmod(target, 0o755);
}

describe("caesar init", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-"));
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
        const prompt = await readFile(join(root, ".caesar", role.system_prompt_file!), "utf8");
        expect(prompt.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it("sur un projet déjà initialisé, sans --force : rafraîchit les assets mais laisse `.caesar/config.toml` et `.caesar/roles/*.md` strictement intacts (succès)", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { agent: ["claude"] }, io)).toBe(EXIT_OK);

      // Édités à la main : c'est exactement ce que le refresh doit préserver
      // (voir l'en-tête d'init.ts) — comparaison par contenu, pas seulement
      // par présence.
      const configPath = projectConfigPath(root);
      const editedConfig = (await readFile(configPath, "utf8")) + "# édité à la main\n";
      await writeFile(configPath, editedConfig, "utf8");

      const rolePath = join(root, ".caesar", "roles", "reviewer.md");
      const editedRole = "Mon prompt personnalisé, édité à la main.\n";
      await writeFile(rolePath, editedRole, "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).toBe(editedConfig);
      expect(await readFile(rolePath, "utf8")).toBe(editedRole);
      // La sortie dit que la config a été laissée telle quelle...
      expect(io2.stdoutText()).toMatch(/laissés tels quels/);
      // ...mais les assets, eux, ont bien été (re)déposés.
      expect(existsSync(join(root, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
    });
  });

  it("--force écrase une configuration existante (rôles compris), et redépose les assets", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { agent: ["claude"] }, io)).toBe(EXIT_OK);

      const rolePath = join(root, ".caesar", "roles", "reviewer.md");
      await writeFile(rolePath, "édité à la main : --force doit l'écraser.\n", "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { force: true, agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(rolePath, "utf8")).not.toMatch(/doit l'écraser/);
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

  it("--json distingue un premier init d'un refresh via `refreshed` (constat I3)", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).refreshed).toBe(false);

      // Même projet, second passage sans --force : un refresh, où
      // `role_files: []` et `worktree: null` ne doivent pas se lire comme
      // « ce projet n'a ni rôles ni worktree ».
      const io2 = makeIo();
      const code2 = await runInit(root, { json: true }, io2);
      expect(code2).toBe(EXIT_OK);
      const parsed2 = JSON.parse(io2.stdoutText());
      expect(parsed2.refreshed).toBe(true);
      expect(parsed2.role_files).toEqual([]);
      expect(parsed2.worktree).toBeNull();
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

describe("caesar init --global", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-global-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée ~/.config/caesar/config.toml à partir de defaultConfig(), jamais la couche projet", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true }, io);
      expect(code).toBe(EXIT_OK);

      const { config, sources } = await loadConfig(root);
      expect(sources.global).toBe(join(home, ".config", "caesar", "config.toml"));
      expect(sources.project).toBeUndefined();
      expect(config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
      expect(config.policy.max_parallel).toBe(4);
    });
  });

  it("sur une configuration globale déjà présente, sans --force : rafraîchit les assets mais laisse la configuration intacte (succès)", async () => {
    await withFakeHome(async (home) => {
      expect(await runInit(root, { global: true, agent: ["claude"] }, io)).toBe(EXIT_OK);

      const configPath = join(home, ".config", "caesar", "config.toml");
      const edited = (await readFile(configPath, "utf8")) + "# édité à la main\n";
      await writeFile(configPath, edited, "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { global: true, agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).toBe(edited);
      expect(io2.stdoutText()).toMatch(/laissée telle quelle/);
      expect(existsSync(join(home, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
    });
  });

  it("--force écrase une configuration globale existante, et redépose les assets", async () => {
    await withFakeHome(async (home) => {
      expect(await runInit(root, { global: true, agent: ["claude"] }, io)).toBe(EXIT_OK);

      const configPath = join(home, ".config", "caesar", "config.toml");
      const edited = (await readFile(configPath, "utf8")) + "# édité à la main : --force doit l'écraser\n";
      await writeFile(configPath, edited, "utf8");

      const io2 = makeIo();
      expect(await runInit(root, { global: true, force: true, agent: ["claude"] }, io2)).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).not.toMatch(/doit l'écraser/);
    });
  });

  it("--json rend le chemin et la portée, sans ANSI", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.scope).toBe("global");
      expect(parsed.config_path).toBe(join(home, ".config", "caesar", "config.toml"));
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });

  it("--json distingue un premier init d'un refresh via `refreshed` (constat I3)", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { global: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).refreshed).toBe(false);

      const io2 = makeIo();
      const code2 = await runInit(root, { global: true, json: true }, io2);
      expect(code2).toBe(EXIT_OK);
      expect(JSON.parse(io2.stdoutText()).refreshed).toBe(true);
    });
  });
});

describe("caesar init — complétion du .gitignore (dans un dépôt git)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-gitignore-"));
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
      expect(lines).toEqual([".caesar/config.local.toml", ".caesar/tasks/", ".caesar/wt/", ".caesar/state/"]);
      expect(io.stdoutText()).toMatch(/\.gitignore complété/);
    });
  });

  it("n'ajoute que les lignes absentes, préserve le contenu existant, ne réécrit pas depuis rien", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.caesar/tasks/\n", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      // Le contenu original survit intégralement, en tête du fichier.
      expect(raw.startsWith("node_modules/\n.caesar/tasks/\n")).toBe(true);
      // Les trois lignes manquantes sont ajoutées ; ".caesar/tasks/" (déjà présent) n'est pas dupliqué.
      const lines = raw.split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual(["node_modules/", ".caesar/tasks/", ".caesar/config.local.toml", ".caesar/wt/", ".caesar/state/"]);
    });
  });

  it("gère un fichier existant sans retour à la ligne final, sans fusionner la dernière ligne avec la suivante", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw.startsWith("node_modules/\n")).toBe(true);
      expect(raw).toContain(".caesar/config.local.toml");
    });
  });

  it("ne touche pas au fichier (aucune écriture) quand toutes les entrées sont déjà présentes", async () => {
    await withFakeHome(async () => {
      const already = "node_modules/\n.caesar/config.local.toml\n.caesar/tasks/\n.caesar/wt/\n.caesar/state/\n";
      await writeFile(join(root, ".gitignore"), already, "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw).toBe(already);
      expect(io.stdoutText()).toMatch(/\.gitignore déjà à jour/);
    });
  });
});

describe("caesar init — .gitignore hors dépôt git", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-nogit-"));
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

/**
 * `[worktree]` : la section qui rend le worktree des sous-agents habitable.
 * Sans elle, un worktree ne contient que les fichiers suivis par git — ni
 * dépendances installées, ni `.env` — et l'isolation devient inexploitable,
 * donc contournée. C'est la cause de fond du défaut d'origine, et `caesar init`
 * est le seul endroit où elle peut être posée avant qu'il ne se manifeste.
 */
describe("caesar init — l'atelier des sous-agents ([worktree])", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-worktree-"));
    io = makeIo();
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "caesar-test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Caesar Test"], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedNodeProject(): Promise<void> {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n", "utf8");
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    await execFileAsync("mkdir", ["-p", join(root, "node_modules")]);
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
  }

  it("détecte les besoins d'un projet Node et les inscrit dans la couche projet", async () => {
    await withFakeHome(async () => {
      await seedNodeProject();
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      expect(config.worktree.copy.sort()).toEqual([".env", "node_modules"]);
      expect(config.worktree.setup).toEqual(["npm install"]);
      // Annoncé, pas déposé en silence : c'est une supposition sur le projet.
      expect(io.stdoutText()).toMatch(/Atelier des sous-agents/);
    });
  });

  it("projet nu : aucune section, plutôt qu'une section vide qui ferait croire à un réglage", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);

      const raw = await readFile(projectConfigPath(root), "utf8");
      expect(raw).not.toMatch(/\[worktree\]/);
      expect(io.stdoutText()).not.toMatch(/Atelier des sous-agents/);
    });
  });

  it("ne propose jamais un chemin que git ne veut pas ignorer", async () => {
    await withFakeHome(async () => {
      // Un `node_modules` non ignoré polluerait `caesar diff`, qui fait foi, et
      // `caesar gc` ne nettoierait plus jamais ce worktree.
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: root });
      await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      await execFileAsync("mkdir", ["-p", join(root, "node_modules")]);

      expect(await runInit(root, {}, io)).toBe(EXIT_OK);
      const { config } = await loadConfig(root);
      expect(config.worktree.copy).toEqual([]);
      expect(config.worktree.setup).toEqual(["npm install"]);
    });
  });

  it("--json rend la section détectée", async () => {
    await withFakeHome(async () => {
      await seedNodeProject();
      expect(await runInit(root, { json: true }, io)).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.worktree.copy.sort()).toEqual([".env", "node_modules"]);
    });
  });

  it("--force redétecte : une section obsolète se remet à jour", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);
      expect((await loadConfig(root)).config.worktree.copy).toEqual([]);

      await seedNodeProject();
      expect(await runInit(root, { force: true }, makeIo())).toBe(EXIT_OK);
      expect((await loadConfig(root)).config.worktree.copy.sort()).toEqual([".env", "node_modules"]);
    });
  });
});

/**
 * La connaissance agentique (skill Agent Skills + commandes, `@caesar/core`
 * `installAgentAssets`) : `--agent` explicite est utilisé partout où le test
 * porte sur *quelles* cibles sont servies, pour rester indépendant de ce qui
 * est réellement installé sur la machine qui fait tourner la suite — voir
 * `withIsolatedPath`/`writeFakeBinary` plus haut pour les deux tests qui, à
 * l'inverse, portent sur la détection PATH elle-même.
 */
describe("caesar init — connaissance agentique (assets)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-assets-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dépose effectivement la skill et les commandes pour les cibles retenues, sur un projet neuf", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { agent: ["claude", "codex"] }, io);
      expect(code).toBe(EXIT_OK);

      // claude : copie dédiée, skill et commandes.
      expect(existsSync(join(root, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, ".claude", "commands", "caesar-delegate.md"))).toBe(true);
      // codex : partagé, skill seulement (voir agent-assets.ts, ASSET_TARGETS).
      expect(existsSync(join(root, ".agents", "skills", "caesar", "SKILL.md"))).toBe(true);
      // opencode n'a pas été demandé : son répertoire dédié n'existe pas.
      expect(existsSync(join(root, ".opencode", "commands"))).toBe(false);
    });
  });

  it("--agent restreint bien les cibles retenues, et un id inconnu échoue clairement", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { agent: ["claude", "codex"], json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect([...parsed.assets.targets].sort()).toEqual(["claude", "codex"]);

      const io2 = makeIo();
      const code2 = await runInit(root, { agent: ["pas-un-client"] }, io2);
      expect(code2).toBe(EXIT_USAGE);
      expect(io2.stderrText()).toMatch(/pas-un-client/);
      expect(io2.stdoutText()).toBe("");
    });
  });

  it("--json rend assets.targets/files/stale sans séquence ANSI, en portée projet et globale", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { agent: ["claude"], json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.assets.targets).toEqual(["claude"]);
      expect(Array.isArray(parsed.assets.files)).toBe(true);
      expect(parsed.assets.files.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.assets.stale)).toBe(true);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);

      const io2 = makeIo();
      const code2 = await runInit(root, { global: true, agent: ["claude"], json: true }, io2);
      expect(code2).toBe(EXIT_OK);
      const parsedGlobal = JSON.parse(io2.stdoutText());
      expect(parsedGlobal.assets.targets).toEqual(["claude"]);
      expect(parsedGlobal.assets.files.length).toBeGreaterThan(0);
      expect(Array.isArray(parsedGlobal.assets.stale)).toBe(true);
      expect(io2.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });

  it("--no-skills : assets: null en JSON, et aucun fichier d'asset déposé", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true, skills: false }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.assets).toBeNull();
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(existsSync(join(root, ".claude"))).toBe(false);
    });
  });

  it("--global dépose les assets sous HOME, jamais sous root/", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true, agent: ["claude"] }, io);
      expect(code).toBe(EXIT_OK);
      expect(existsSync(join(home, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
    });
  });

  it("détection sous PATH factice : seule la cible dont le binaire est présent est servie", async () => {
    await withFakeHome(async () => {
      const shimDir = await mkdtemp(join(tmpdir(), "caesar-cli-init-shim-"));
      try {
        await writeFakeBinary(shimDir, "codex");
        const code = await withIsolatedPath(shimDir, () => runInit(root, { json: true }, io));
        expect(code).toBe(EXIT_OK);
        const parsed = JSON.parse(io.stdoutText());
        expect(parsed.assets.targets).toEqual(["codex"]);
        expect(existsSync(join(root, ".agents", "skills", "caesar", "SKILL.md"))).toBe(true);
        expect(existsSync(join(root, ".claude"))).toBe(false);
      } finally {
        await rm(shimDir, { recursive: true, force: true });
      }
    });
  });

  it("PATH vide : aucun runtime détecté, le socle partagé est déposé quand même, et la sortie le dit", async () => {
    await withFakeHome(async () => {
      const previousPath = process.env["PATH"];
      process.env["PATH"] = "";
      try {
        const code = await runInit(root, {}, io);
        expect(code).toBe(EXIT_OK);
        expect(io.stdoutText()).toMatch(/Aucun runtime détecté/);
        expect(existsSync(join(root, ".agents", "skills", "caesar", "SKILL.md"))).toBe(true);
        expect(existsSync(join(root, ".claude"))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
      }
    });
  });

  it("--json : un settings.json malformé remonte son avertissement dans `warnings`, et la fusion n'a pas lieu", async () => {
    await withFakeHome(async () => {
      const settingsPath = join(root, ".claude", "settings.json");
      await mkdir(join(root, ".claude"), { recursive: true });
      const malformed = "{ ceci n'est pas du JSON";
      await writeFile(settingsPath, malformed, "utf8");

      const code = await runInit(root, { agent: ["claude"], json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      // Le warning du module (agent-assets.ts, computeSettingsMerge) remonte
      // dans le tableau `warnings` de premier niveau, pas seulement en
      // sortie humaine — sinon un consommateur `--json` ne verrait que des
      // fichiers déposés avec succès et jamais la fusion sautée.
      expect(parsed.warnings.some((w: string) => /JSON invalide/.test(w))).toBe(true);
      // La fusion n'a pas eu lieu : le fichier reste tel quel, toujours malformé.
      expect(await readFile(settingsPath, "utf8")).toBe(malformed);
    });
  });
});
