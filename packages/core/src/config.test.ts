import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  parseDuration,
  projectConfigPath,
  saveProjectConfig,
  type OrchConfig,
  type PolicyConfig,
  type RoleConfig,
} from "./config.js";

// `globalConfigPath()` lit `$HOME` à chaque appel (voir node:os#homedir) :
// pointer HOME vers un répertoire temporaire isole entièrement ces tests du
// vrai `~/.config/orch/` de la machine, sans avoir à changer la signature
// de `loadConfig`.
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "orch-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

describe("parseDuration", () => {
  it.each([
    ["10m", 600_000],
    ["90s", 90_000],
    ["1h", 3_600_000],
    ["500ms", 500],
    ["5000", 5000],
  ])("convertit %s en %i ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("accepte un nombre brut interprété en millisecondes", () => {
    expect(parseDuration(1500)).toBe(1500);
  });

  it("lève sur une forme non reconnue, en montrant les formes acceptées", () => {
    expect(() => parseDuration("3 fortnights")).toThrow(/10m.*90s.*1h/s);
  });

  it("lève sur un nombre négatif", () => {
    expect(() => parseDuration(-1)).toThrow();
  });
});

describe("defaultConfig", () => {
  it("livre trois rôles immédiatement utiles", () => {
    const config = defaultConfig();
    expect(config.roles.map((r) => r.name)).toEqual(["reviewer", "implementer", "investigator"]);
  });

  it("le rôle reviewer est en lecture seule, inplace", () => {
    const role = defaultConfig().roles.find((r) => r.name === "reviewer")!;
    expect(role.mode).toBe("read-only");
    expect(role.isolation).toBe("inplace");
    expect(role.agents).toEqual(["codex", "antigravity"]);
  });

  it("le rôle implementer écrit, en worktree", () => {
    const role = defaultConfig().roles.find((r) => r.name === "implementer")!;
    expect(role.mode).toBe("write");
    expect(role.isolation).toBe("worktree");
    expect(role.agents).toEqual(["codex", "antigravity", "opencode"]);
  });

  it("le rôle investigator est en lecture seule, isolation auto", () => {
    const role = defaultConfig().roles.find((r) => r.name === "investigator")!;
    expect(role.mode).toBe("read-only");
    expect(role.isolation).toBe("auto");
    expect(role.agents).toEqual(["antigravity", "codex", "opencode"]);
  });

  it("la politique par défaut correspond au brief", () => {
    expect(defaultConfig().policy).toEqual<PolicyConfig>({
      allowed: [],
      denied: [],
      max_parallel: 4,
      default_isolation: "auto",
      default_mode: "write",
      default_timeout_ms: 600_000,
      allow_recursion: false,
      max_depth: 2,
    });
  });

  it("aucun agent personnalisé par défaut", () => {
    expect(defaultConfig().agents).toEqual([]);
  });

  it("renvoie une copie fraîche à chaque appel", () => {
    const a = defaultConfig();
    a.roles[0]!.agents.push("intrus");
    a.policy.allowed.push("intrus");
    const b = defaultConfig();
    expect(b.roles[0]!.agents).not.toContain("intrus");
    expect(b.policy.allowed).not.toContain("intrus");
  });
});

describe("globalConfigPath / projectConfigPath", () => {
  it("le chemin global se trouve sous ~/.config/orch/config.toml", async () => {
    await withFakeHome(async (home) => {
      expect(globalConfigPath()).toBe(join(home, ".config", "orch", "config.toml"));
    });
  });

  it("le chemin projet se trouve sous <root>/.orch/config.toml", () => {
    expect(projectConfigPath("/repo")).toBe(join("/repo", ".orch", "config.toml"));
  });
});

describe("mergeConfig", () => {
  function policyOf(overrides: Partial<PolicyConfig>): PolicyConfig {
    return { ...defaultConfig().policy, ...overrides };
  }

  it("policy se fusionne champ par champ", () => {
    const base: OrchConfig = { policy: policyOf({ max_parallel: 4, allow_recursion: false }), roles: [], agents: [] };
    // Un override qui ne précise qu'un sous-ensemble des champs réellement présents dans un
    // fichier TOML : c'est exactement la forme que produit `parseConfigFile` en interne, et ce
    // que le type de `override` (ConfigOverride, policy en Partial<PolicyConfig>) accepte
    // directement, sans cast.
    const merged = mergeConfig(base, { policy: { max_parallel: 8 } });
    expect(merged.policy.max_parallel).toBe(8);
    expect(merged.policy.allow_recursion).toBe(false);
  });

  it("un rôle de même nom est remplacé entièrement, pas fusionné champ par champ", () => {
    const reviewerA: RoleConfig = {
      name: "reviewer",
      purpose: "ancien",
      agents: ["codex"],
      mode: "read-only",
      isolation: "inplace",
      timeout_ms: 1000,
    };
    const reviewerB: RoleConfig = {
      name: "reviewer",
      purpose: "nouveau",
      agents: ["opencode"],
      mode: "write",
      isolation: "worktree",
      timeout_ms: 2000,
    };
    const base: OrchConfig = { policy: defaultConfig().policy, roles: [reviewerA], agents: [] };
    const merged = mergeConfig(base, { roles: [reviewerB] });
    expect(merged.roles).toEqual([reviewerB]);
  });

  it("les rôles propres à chaque niveau sont conservés", () => {
    const globalRole: RoleConfig = {
      name: "global-only",
      purpose: "",
      agents: ["codex"],
      mode: "read-only",
      isolation: "inplace",
      timeout_ms: 1000,
    };
    const projectRole: RoleConfig = {
      name: "project-only",
      purpose: "",
      agents: ["opencode"],
      mode: "write",
      isolation: "worktree",
      timeout_ms: 1000,
    };
    const base: OrchConfig = { policy: defaultConfig().policy, roles: [globalRole], agents: [] };
    const merged = mergeConfig(base, { roles: [projectRole] });
    expect(merged.roles.map((r) => r.name).sort()).toEqual(["global-only", "project-only"]);
  });

  it("même logique de fusion par clé pour les agents", () => {
    const base: OrchConfig = {
      policy: defaultConfig().policy,
      roles: [],
      agents: [{ id: "shared", bin: "old-bin", args: [] }],
    };
    const merged = mergeConfig(base, {
      agents: [
        { id: "shared", bin: "new-bin", args: ["--x"] },
        { id: "project-only", bin: "other", args: [] },
      ],
    });
    expect(merged.agents).toEqual([
      { id: "shared", bin: "new-bin", args: ["--x"] },
      { id: "project-only", bin: "other", args: [] },
    ]);
  });

  it("un override sans policy laisse la policy de base intacte", () => {
    const base: OrchConfig = { policy: policyOf({ max_parallel: 7 }), roles: [], agents: [] };
    const merged = mergeConfig(base, {});
    expect(merged.policy.max_parallel).toBe(7);
  });
});

describe("loadConfig", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "orch-project-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("fichiers absents des deux côtés : configuration par défaut, aucune source", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config).toEqual(defaultConfig());
      expect(loaded.sources).toEqual({});
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("global seul : ses valeurs s'appliquent, la source global est renseignée", async () => {
    await withFakeHome(async (home) => {
      const globalPath = join(home, ".config", "orch", "config.toml");
      await mkdir(join(home, ".config", "orch"), { recursive: true });
      await writeFile(globalPath, '[policy]\nmax_parallel = 9\n', "utf8");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.policy.max_parallel).toBe(9);
      expect(loaded.sources.global).toBe(globalPath);
      expect(loaded.sources.project).toBeUndefined();
    });
  });

  it("projet seul : ses valeurs s'appliquent, la source projet est renseignée", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      await writeFile(join(projectRoot, ".orch", "config.toml"), '[policy]\nmax_parallel = 6\n', "utf8");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.policy.max_parallel).toBe(6);
      expect(loaded.sources.project).toBe(join(projectRoot, ".orch", "config.toml"));
      expect(loaded.sources.global).toBeUndefined();
    });
  });

  it("les deux présents : le projet écrase le global sur les champs qu'il précise", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "orch"), { recursive: true });
      await writeFile(
        join(home, ".config", "orch", "config.toml"),
        '[policy]\nmax_parallel = 9\nallow_recursion = true\n',
        "utf8",
      );
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      await writeFile(join(projectRoot, ".orch", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

      const loaded = await loadConfig(projectRoot);
      // Précisé par le projet : le projet gagne.
      expect(loaded.config.policy.max_parallel).toBe(2);
      // Précisé par le global seulement, absent du projet : le global survit.
      expect(loaded.config.policy.allow_recursion).toBe(true);
      expect(loaded.sources.global).toBeDefined();
      expect(loaded.sources.project).toBeDefined();
    });
  });

  it("un rôle projet de même nom qu'un rôle global le remplace entièrement, sans fusion de champs", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "orch"), { recursive: true });
      await writeFile(
        join(home, ".config", "orch", "config.toml"),
        [
          "[[role]]",
          'name = "reviewer"',
          'purpose = "global"',
          'agents = ["codex"]',
          'mode = "read-only"',
          'isolation = "inplace"',
          'timeout = "5m"',
          "",
        ].join("\n"),
        "utf8",
      );
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      await writeFile(
        join(projectRoot, ".orch", "config.toml"),
        [
          "[[role]]",
          'name = "reviewer"',
          'purpose = "projet"',
          'agents = ["opencode"]',
          'mode = "write"',
          'isolation = "worktree"',
          'timeout = "20m"',
          "",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadConfig(projectRoot);
      const reviewers = loaded.config.roles.filter((r) => r.name === "reviewer");
      expect(reviewers).toHaveLength(1);
      expect(reviewers[0]).toEqual({
        name: "reviewer",
        purpose: "projet",
        agents: ["opencode"],
        mode: "write",
        isolation: "worktree",
        timeout_ms: 1_200_000,
      });
      // Les autres rôles par défaut (implementer, investigator) survivent.
      expect(loaded.config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
    });
  });

  it("TOML syntaxiquement invalide produit une erreur qui nomme le fichier", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      const path = join(projectRoot, ".orch", "config.toml");
      await writeFile(path, "[policy\nmax_parallel = 4\n", "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });

  it("un champ de type incorrect produit une erreur qui nomme le champ et le fichier", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      const path = join(projectRoot, ".orch", "config.toml");
      await writeFile(path, '[policy]\nmax_parallel = "quatre"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_parallel/);
    });
  });

  it("un champ inconnu (faute de frappe) produit une erreur qui le nomme, plutôt que d'être ignoré silencieusement", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      const path = join(projectRoot, ".orch", "config.toml");
      await writeFile(path, '[policy]\nmax_paralel = 4\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_paralel/);
    });
  });

  it("une durée invalide produit une erreur nommant le champ concerné", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".orch"), { recursive: true });
      const path = join(projectRoot, ".orch", "config.toml");
      await writeFile(path, '[[role]]\nname = "x"\nagents = ["codex"]\nmode = "write"\ntimeout = "3 fortnights"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/timeout/);
    });
  });

  it("un fichier de configuration illisible (répertoire à la place d'un fichier) est une erreur nommant le fichier", async () => {
    await withFakeHome(async () => {
      const path = join(projectRoot, ".orch", "config.toml");
      // Un répertoire du même nom que le fichier attendu : la lecture échoue avec autre chose qu'ENOENT.
      await mkdir(path, { recursive: true });

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });
});

describe("saveProjectConfig / loadConfig — aller-retour", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "orch-roundtrip-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("relit une configuration équivalente après écriture", async () => {
    await withFakeHome(async () => {
      // `loadConfig` reconstruit toujours sa base depuis `defaultConfig()` :
      // pour que l'aller-retour soit fidèle, la configuration sauvegardée
      // doit déjà être la forme complète (post-fusion) qu'on veut retrouver —
      // exactement ce que produirait un vrai fichier projet une fois fusionné
      // à la configuration par défaut, `reviewer`/`implementer`/`investigator`
      // compris.
      const config: OrchConfig = mergeConfig(defaultConfig(), {
        policy: {
          allowed: ["codex", "antigravity"],
          denied: ["copilot"],
          max_parallel: 6,
          default_isolation: "worktree",
          default_mode: "read-only",
          default_timeout_ms: 45_000,
          allow_recursion: true,
          max_depth: 3,
        },
        roles: [
          {
            name: "custom",
            purpose: "Rôle de test.",
            agents: ["codex"],
            mode: "write",
            isolation: "auto",
            timeout_ms: 120_000,
            system_prompt_file: "roles/custom.md",
          },
        ],
        agents: [{ id: "monagent", displayName: "Mon agent", bin: "mon-cli", args: ["--prompt", "{{prompt}}"], cwdMode: "process" }],
      });

      await saveProjectConfig(projectRoot, config);
      const loaded = await loadConfig(projectRoot);

      expect(loaded.config).toEqual(config);
      expect(loaded.sources.project).toBe(projectConfigPath(projectRoot));
    });
  });

  it("écrit un en-tête avertissant que les commentaires manuels ne survivent pas", async () => {
    await saveProjectConfig(projectRoot, defaultConfig());
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    expect(raw.split("\n")[0]).toMatch(/^#.*commentaire/i);
  });

  it("écrit de façon atomique (fichier temporaire renommé, aucun résidu)", async () => {
    await saveProjectConfig(projectRoot, defaultConfig());
    const entries = await readdir(join(projectRoot, ".orch"));
    expect(entries).toEqual(["config.toml"]);
  });
});
