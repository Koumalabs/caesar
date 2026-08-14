import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  agentProvenance,
  configPathFor,
  defaultConfig,
  globalConfigPath,
  loadConfig,
  loadLayer,
  localConfigPath,
  materializeListEdit,
  materializePolicyList,
  mergeConfig,
  parseDuration,
  policyFieldProvenance,
  projectConfigPath,
  roleProvenance,
  saveLayer,
  type ConfigLayer,
  type CaesarConfig,
  type PolicyConfig,
  type RoleConfig,
} from "./config.js";

// `globalConfigPath()` lit `$HOME` à chaque appel (voir node:os#homedir) :
// pointer HOME vers un répertoire temporaire isole entièrement ces tests du
// vrai `~/.config/caesar/` de la machine, sans avoir à changer la signature
// de `loadConfig`.
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "caesar-home-"));
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
      default_network: "auto",
      default_timeout_ms: 600_000,
      allow_recursion: false,
      allow_inplace_write: false,
      max_depth: 2,
    });
  });

  it("aucun agent personnalisé par défaut", () => {
    expect(defaultConfig().agents).toEqual([]);
  });

  it("chaque rôle par défaut porte déjà la convention system_prompt_file (roles/<name>.md), sans qu'aucune couche ne l'ait déclarée", () => {
    // Voir l'en-tête de `DEFAULT_ROLES" (config.ts) : c'est ce qui permet à `caesar init` (couche projet) de ne
    // matérialiser que les fichiers de prompt, sans avoir à déclarer les rôles dans le TOML du projet.
    for (const role of defaultConfig().roles) {
      expect(role.system_prompt_file).toBe(`roles/${role.name}.md`);
    }
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
  it("le chemin global se trouve sous ~/.config/caesar/config.toml", async () => {
    await withFakeHome(async (home) => {
      expect(globalConfigPath()).toBe(join(home, ".config", "caesar", "config.toml"));
    });
  });

  it("le chemin projet se trouve sous <root>/.caesar/config.toml", () => {
    expect(projectConfigPath("/repo")).toBe(join("/repo", ".caesar", "config.toml"));
  });

  it("suit $HOME même quand il diffère de ce que os.homedir() rendrait — Bun ignore $HOME dans os.homedir() (tâche 15)", async () => {
    // Ce test passe trivialement sous Node (vitest, ce fichier) : `os.homedir()` y respecte déjà `$HOME`. Sa
    // valeur est de figer le comportement pour Bun (`packages/tui`, qui consomme ce module compilé) : y écrire
    // `os.homedir()` à la place de `process.env.HOME` régresserait silencieusement sous Bun uniquement, sans
    // qu'aucun test Node ne le détecte — voir `globalConfigPath` pour l'incident qui a révélé ce défaut.
    await withFakeHome(async (home) => {
      expect(globalConfigPath().startsWith(home)).toBe(true);
    });
  });
});

describe("mergeConfig", () => {
  function policyOf(overrides: Partial<PolicyConfig>): PolicyConfig {
    return { ...defaultConfig().policy, ...overrides };
  }

  it("policy se fusionne champ par champ", () => {
    const base: CaesarConfig = { policy: policyOf({ max_parallel: 4, allow_recursion: false }), roles: [], agents: [] };
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
    const base: CaesarConfig = { policy: defaultConfig().policy, roles: [reviewerA], agents: [] };
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
    const base: CaesarConfig = { policy: defaultConfig().policy, roles: [globalRole], agents: [] };
    const merged = mergeConfig(base, { roles: [projectRole] });
    expect(merged.roles.map((r) => r.name).sort()).toEqual(["global-only", "project-only"]);
  });

  it("même logique de fusion par clé pour les agents", () => {
    const base: CaesarConfig = {
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
    const base: CaesarConfig = { policy: policyOf({ max_parallel: 7 }), roles: [], agents: [] };
    const merged = mergeConfig(base, {});
    expect(merged.policy.max_parallel).toBe(7);
  });
});

describe("loadConfig", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "caesar-project-"));
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
      const globalPath = join(home, ".config", "caesar", "config.toml");
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(globalPath, '[policy]\nmax_parallel = 9\n', "utf8");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.policy.max_parallel).toBe(9);
      expect(loaded.sources.global).toBe(globalPath);
      expect(loaded.sources.project).toBeUndefined();
    });
  });

  it("projet seul : ses valeurs s'appliquent, la source projet est renseignée", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      await writeFile(join(projectRoot, ".caesar", "config.toml"), '[policy]\nmax_parallel = 6\n', "utf8");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.policy.max_parallel).toBe(6);
      expect(loaded.sources.project).toBe(join(projectRoot, ".caesar", "config.toml"));
      expect(loaded.sources.global).toBeUndefined();
    });
  });

  it("les deux présents : le projet écrase le global sur les champs qu'il précise", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(
        join(home, ".config", "caesar", "config.toml"),
        '[policy]\nmax_parallel = 9\nallow_recursion = true\n',
        "utf8",
      );
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      await writeFile(join(projectRoot, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

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
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(
        join(home, ".config", "caesar", "config.toml"),
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
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      await writeFile(
        join(projectRoot, ".caesar", "config.toml"),
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
        // Non déclaré par la couche projet : c'est le défaut *de l'entrée*
        // (RawRoleSchema) qui s'applique, pas la valeur du rôle global —
        // c'est précisément ce que « remplace entièrement » veut dire.
        network: "auto",
        timeout_ms: 1_200_000,
      });
      // Les autres rôles par défaut (implementer, investigator) survivent.
      expect(loaded.config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
    });
  });

  it("TOML syntaxiquement invalide produit une erreur qui nomme le fichier", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, "[policy\nmax_parallel = 4\n", "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });

  it("un champ de type incorrect produit une erreur qui nomme le champ et le fichier", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[policy]\nmax_parallel = "quatre"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_parallel/);
    });
  });

  it("un champ inconnu (faute de frappe) produit une erreur qui le nomme, plutôt que d'être ignoré silencieusement", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[policy]\nmax_paralel = 4\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_paralel/);
    });
  });

  it("une durée invalide produit une erreur nommant le champ concerné", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[[role]]\nname = "x"\nagents = ["codex"]\nmode = "write"\ntimeout = "3 fortnights"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/timeout/);
    });
  });

  it("un fichier de configuration illisible (répertoire à la place d'un fichier) est une erreur nommant le fichier", async () => {
    await withFakeHome(async () => {
      const path = join(projectRoot, ".caesar", "config.toml");
      // Un répertoire du même nom que le fichier attendu : la lecture échoue avec autre chose qu'ENOENT.
      await mkdir(path, { recursive: true });

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });
});

/**
 * `[worktree]` — la section qui rend le worktree habitable. Sans elle, un
 * worktree ne contient que les fichiers suivis par git : ni dépendances
 * installées, ni `.env`, ni répertoires ignorés — et l'isolation devient
 * inexploitable, donc contournée. Voir `WorktreeConfig`.
 */
describe("[worktree]", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "caesar-worktree-cfg-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeProject(toml: string): Promise<void> {
    await mkdir(join(projectRoot, ".caesar"), { recursive: true });
    await writeFile(join(projectRoot, ".caesar", "config.toml"), toml, "utf8");
  }

  it("absente partout : trois listes vides, jamais undefined", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree).toEqual({ copy: [], link: [], setup: [] });
    });
  });

  it("lit copy, link et setup", async () => {
    await withFakeHome(async () => {
      await writeProject('[worktree]\ncopy = ["node_modules", ".env"]\nlink = ["gros-cache"]\nsetup = ["pnpm install --offline"]\n');
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree).toEqual({
        copy: ["node_modules", ".env"],
        link: ["gros-cache"],
        setup: ["pnpm install --offline"],
      });
    });
  });

  it("un champ absent du fichier ne dit rien : la couche précédente le garde", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules"]\nsetup = ["npm ci"]\n', "utf8");
      await writeProject('[worktree]\nsetup = ["pnpm install"]\n');

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual(["node_modules"]);
      expect(loaded.config.worktree.setup).toEqual(["pnpm install"]);
    });
  });

  it("remplace la liste héritée au lieu de s'y ajouter", async () => {
    // La propriété qui rend le retrait local possible : une union laisserait
    // une entrée héritée du global impossible à retirer côté projet.
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules", ".venv"]\n', "utf8");
      await writeProject('[worktree]\ncopy = [".env"]\n');

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual([".env"]);
    });
  });

  it("liste vide déclarée : retire tout ce qui était hérité", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules"]\n', "utf8");
      await writeProject("[worktree]\ncopy = []\n");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual([]);
    });
  });

  describe("chemins refusés au chargement, avec leur cause", () => {
    // Une entrée invalide est une erreur de configuration, pas une
    // circonstance d'exécution : elle doit se voir en lisant le fichier, pas
    // se transformer plus tard en tâche qui échoue sans qu'on sache pourquoi.
    const cases: [string, string, RegExp][] = [
      ["absolu", '[worktree]\ncopy = ["/etc/passwd"]\n', /absolu/],
      ["remontée", '[worktree]\ncopy = ["../ailleurs"]\n', /\.\./],
      ["imbriqué remontant", '[worktree]\nlink = ["a/../../b"]\n', /\.\./],
      [".git", '[worktree]\ncopy = [".git"]\n', /\.git/],
      [".caesar", '[worktree]\nlink = [".caesar/state"]\n', /\.caesar/],
      ["vide", '[worktree]\ncopy = [""]\n', /vide/],
    ];
    for (const [name, toml, motif] of cases) {
      it(name, async () => {
        await withFakeHome(async () => {
          await writeProject(toml);
          await expect(loadConfig(projectRoot)).rejects.toThrow(motif);
        });
      });
    }

    it("champ inconnu de la section : refusé comme partout ailleurs", async () => {
      await withFakeHome(async () => {
        await writeProject('[worktree]\ncoppy = ["node_modules"]\n');
        await expect(loadConfig(projectRoot)).rejects.toThrow(/champ inconnu/);
      });
    });
  });

  it("accepte un chemin imbriqué légitime", async () => {
    await withFakeHome(async () => {
      await writeProject('[worktree]\ncopy = ["packages/api/node_modules", ".superpowers"]\n');
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual(["packages/api/node_modules", ".superpowers"]);
    });
  });

  it("survit à l'aller-retour saveLayer/loadLayer", async () => {
    await withFakeHome(async () => {
      const worktree = { copy: ["node_modules"], link: ["cache"], setup: ["pnpm install --offline"] };
      await saveLayer("project", projectRoot, { worktree });
      expect(await loadLayer("project", projectRoot)).toEqual({ worktree });
    });
  });
});

describe("saveLayer / loadConfig — aller-retour", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "caesar-roundtrip-"));
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
      // compris. `saveLayer` accepte directement un `CaesarConfig` complet : il
      // satisfait structurellement `ConfigOverride` (tous ses champs présents).
      const config: CaesarConfig = mergeConfig(defaultConfig(), {
        policy: {
          allowed: ["codex", "antigravity"],
          denied: ["copilot"],
          max_parallel: 6,
          default_isolation: "worktree",
          default_mode: "read-only",
          default_network: "off",
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
            network: "on",
            timeout_ms: 120_000,
            system_prompt_file: "roles/custom.md",
          },
        ],
        agents: [
          {
            id: "monagent",
            displayName: "Mon agent",
            bin: "mon-cli",
            args: ["--prompt", "{{prompt}}"],
            cwdMode: "process",
            networkArgs: ["--online"],
          },
        ],
      });

      await saveLayer("project", projectRoot, config);
      const loaded = await loadConfig(projectRoot);

      expect(loaded.config).toEqual(config);
      expect(loaded.sources.project).toBe(projectConfigPath(projectRoot));
    });
  });

  it("un agent déclaré garde sa capacité \"lecture seule native\" à l'aller-retour", async () => {
    // La seule capacité que `[[agent]]` sait porter (voir `RawAgentSchema`) —
    // et la seule que le moteur honore sans que la ligne de commande ait à
    // coopérer : `runner.ts` s'en sert pour décider si une tâche en lecture
    // seule doit être isolée dans un worktree. Perdue à la relecture, la
    // déclaration serait sans effet, en silence.
    const override = {
      agents: [{ id: "monagent", bin: "mon-cli", args: ["{{prompt}}"], capabilities: { nativeReadOnly: true } }],
    };
    await saveLayer("project", projectRoot, override);
    const layer = await loadLayer("project", projectRoot);
    expect(layer.agents).toEqual(override.agents);
  });

  it("un agent sans capacité déclarée ne se voit pas en inventer une", async () => {
    await saveLayer("project", projectRoot, { agents: [{ id: "monagent", bin: "mon-cli", args: ["{{prompt}}"] }] });
    const layer = await loadLayer("project", projectRoot);
    expect(layer.agents?.[0]).not.toHaveProperty("capabilities");
  });

  it("écrit un en-tête avertissant que les commentaires manuels ne survivent pas", async () => {
    await saveLayer("project", projectRoot, defaultConfig());
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    expect(raw.split("\n")[0]).toMatch(/^#.*commentaire/i);
  });

  it("écrit de façon atomique (fichier temporaire renommé, aucun résidu)", async () => {
    await saveLayer("project", projectRoot, defaultConfig());
    const entries = await readdir(join(projectRoot, ".caesar"));
    expect(entries).toEqual(["config.toml"]);
  });

  it("ne sérialise que ce que l'override déclare : un override partiel produit un fichier qui ne porte que ce champ", async () => {
    await saveLayer("project", projectRoot, { policy: { denied: ["copilot", "opencode"] } });
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");

    // Le fichier ne doit porter aucune trace des défauts (max_parallel, rôles…) : uniquement ce que l'override a
    // déclaré. C'est la preuve, au niveau du fichier, que `saveLayer` ne réécrit jamais la fusion. Comparaison
    // structurelle (via `parseToml`) plutôt que sous-chaîne littérale : insensible au formatage des espaces dans
    // les tableaux TOML (smol-toml écrit `[ "a", "b" ]`, pas `["a", "b"]`).
    expect(parseToml(raw)).toEqual({ policy: { denied: ["copilot", "opencode"] } });
    expect(raw).not.toContain("max_parallel");
    expect(raw).not.toContain("[[role]]");
    expect(raw).not.toContain("[[agent]]");
    expect(raw).not.toContain("allowed");

    // Et la relecture de cette seule couche ne rend que ce qui a été déclaré.
    const layer = await loadLayer("project", projectRoot);
    expect(layer).toEqual({ policy: { denied: ["copilot", "opencode"] } });
  });

  it("un override vide n'écrit aucune section — juste l'en-tête", async () => {
    await saveLayer("project", projectRoot, {});
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    expect(raw.trim()).toBe(
      "# Fichier généré par @caesar/core : les commentaires ajoutés à la main ne survivent pas à une prochaine écriture.",
    );
    expect(await loadLayer("project", projectRoot)).toEqual({});
  });
});

describe("configPathFor / localConfigPath", () => {
  it("délègue à globalConfigPath/projectConfigPath/localConfigPath selon la couche", async () => {
    await withFakeHome(async (home) => {
      expect(configPathFor("global", "/repo")).toBe(join(home, ".config", "caesar", "config.toml"));
      expect(configPathFor("project", "/repo")).toBe(join("/repo", ".caesar", "config.toml"));
      expect(configPathFor("local", "/repo")).toBe(join("/repo", ".caesar", "config.local.toml"));
      expect(localConfigPath("/repo")).toBe(join("/repo", ".caesar", "config.local.toml"));
    });
  });
});

describe("loadLayer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-loadlayer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("un fichier absent rend un override vide, pas une erreur", async () => {
    await withFakeHome(async () => {
      expect(await loadLayer("global", root)).toEqual({});
      expect(await loadLayer("project", root)).toEqual({});
      expect(await loadLayer("local", root)).toEqual({});
    });
  });

  it("rend exactement ce que le fichier déclare, jamais les défauts ni les autres couches", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 9\n', "utf8");

    const layer = await loadLayer("project", root);
    expect(layer).toEqual({ policy: { max_parallel: 9 } });
    // Ni "denied"/"allowed" (absents du fichier), ni les rôles par défaut.
    expect(layer.roles).toBeUndefined();
  });

  it("lit la couche locale (config.local.toml), distincte de la couche projet", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 2\n', "utf8");
    await writeFile(join(root, ".caesar", "config.local.toml"), '[policy]\nmax_parallel = 7\n', "utf8");

    expect(await loadLayer("project", root)).toEqual({ policy: { max_parallel: 2 } });
    expect(await loadLayer("local", root)).toEqual({ policy: { max_parallel: 7 } });
  });
});

describe("loadConfig — trois couches, la locale incluse", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-threelayers-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("le local l'emporte sur le projet, qui l'emporte sur le global, sur les champs qu'il précise", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), "[policy]\nmax_parallel = 9\nallow_recursion = true\n", "utf8");
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");
      await writeFile(join(root, ".caesar", "config.local.toml"), "[policy]\nmax_parallel = 5\n", "utf8");

      const loaded = await loadConfig(root);
      // Précisé par les trois : le local (le plus spécifique) gagne.
      expect(loaded.config.policy.max_parallel).toBe(5);
      // Précisé par le global seulement : survit, aucune couche plus spécifique ne l'a touché.
      expect(loaded.config.policy.allow_recursion).toBe(true);
      expect(loaded.sources.global).toBeDefined();
      expect(loaded.sources.project).toBeDefined();
      expect(loaded.sources.local).toBe(join(root, ".caesar", "config.local.toml"));
    });
  });

  it("expose les trois couches dans l'ordre d'application, y compris celles dont le fichier est absent", async () => {
    await withFakeHome(async () => {
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");

      const loaded = await loadConfig(root);
      expect(loaded.layers.map((l) => l.scope)).toEqual(["global", "project", "local"]);
      expect(loaded.layers[0]!.override).toEqual({});
      expect(loaded.layers[1]!.override).toEqual({ policy: { max_parallel: 2 } });
      expect(loaded.layers[2]!.override).toEqual({});
    });
  });

  it("aucune couche : loadConfig(...).config reste la configuration par défaut, comme avant l'introduction du local", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(root);
      expect(loaded.config).toEqual(defaultConfig());
      expect(loaded.sources).toEqual({});
    });
  });
});

describe("policyFieldProvenance / roleProvenance / agentProvenance", () => {
  function layersOf(overrides: Partial<Record<ConfigLayer["scope"], ConfigLayer["override"]>>): ConfigLayer[] {
    return (["global", "project", "local"] as const).map((scope) => ({
      scope,
      path: `/fake/${scope}.toml`,
      override: overrides[scope] ?? {},
    }));
  }

  it("policyFieldProvenance : \"default\" quand aucune couche ne déclare le champ", () => {
    const layers = layersOf({});
    expect(policyFieldProvenance(layers, "max_parallel")).toBe("default");
  });

  it("policyFieldProvenance : la couche la plus spécifique qui déclare le champ l'emporte", () => {
    const layers = layersOf({
      global: { policy: { max_parallel: 9, allow_recursion: true } },
      project: { policy: { max_parallel: 2 } },
    });
    // Déclaré par project (plus spécifique que global) : provenance "project".
    expect(policyFieldProvenance(layers, "max_parallel")).toBe("project");
    // Déclaré par global seulement : provenance "global".
    expect(policyFieldProvenance(layers, "allow_recursion")).toBe("global");
    // Jamais déclaré : "default".
    expect(policyFieldProvenance(layers, "max_depth")).toBe("default");
  });

  it("roleProvenance : la couche qui déclare une entrée [[role]] de ce nom, \"default\" sinon", () => {
    const role = (name: string): RoleConfig => ({ name, purpose: "", agents: [], mode: "write", isolation: "auto", timeout_ms: 1 });
    const layers = layersOf({
      global: { roles: [role("reviewer")] },
      local: { roles: [role("reviewer")] },
    });
    // Déclaré par global ET local : le local (plus spécifique) l'emporte.
    expect(roleProvenance(layers, "reviewer")).toBe("local");
    expect(roleProvenance(layers, "implementer")).toBe("default");
  });

  it("agentProvenance : la couche qui déclare une entrée [[agent]] de cet id, \"default\" sinon (agents natifs compris)", () => {
    const layers = layersOf({ project: { agents: [{ id: "monagent", bin: "mon-cli", args: [] }] } });
    expect(agentProvenance(layers, "monagent")).toBe("project");
    expect(agentProvenance(layers, "codex")).toBe("default");
  });
});

describe("materializeListEdit", () => {
  it("ajoute un id à la liste effective, matérialisée si la couche ne déclarait pas encore le champ", () => {
    const result = materializeListEdit(["copilot"], undefined, "opencode", true);
    expect(result).toEqual({ effective: ["copilot", "opencode"], materialized: true });
  });

  it("n'est pas matérialisée quand la couche déclare déjà le champ, même vide", () => {
    const result = materializeListEdit(["codex"], [], "codex", true);
    expect(result).toEqual({ effective: ["codex"], materialized: false });
  });

  it("retire un id, sans dupliquer si présent plusieurs fois dans l'effectif", () => {
    const result = materializeListEdit(["codex", "opencode"], ["codex", "opencode"], "codex", false);
    expect(result).toEqual({ effective: ["opencode"], materialized: false });
  });

  it("est le calcul que materializePolicyList applique ensuite au disque (même résultat, en mémoire)", async () => {
    const root = await mkdtemp(join(tmpdir(), "caesar-materialize-pure-"));
    try {
      await withFakeHome(async () => {
        await mkdir(join(root, ".caesar"), { recursive: true });
        await writeFile(join(root, ".caesar", "config.toml"), '[policy]\ndenied = ["codex"]\n', "utf8");

        const pure = materializeListEdit(["codex"], ["codex"], "opencode", true);
        const io = await materializePolicyList(root, "project", "denied", "opencode", true);
        expect(io).toEqual(pure);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("materializePolicyList", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-materialize-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("augmente la liste effective (pas seulement l'id ajouté) et écrit ce résultat dans la couche visée", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "opencode", true);
      expect(result.effective).toEqual(["copilot", "opencode"]);
      expect(result.materialized).toBe(true);

      // La couche projet porte désormais la liste effective entière, pas seulement "opencode".
      const layer = await loadLayer("project", root);
      expect(layer.policy?.denied).toEqual(["copilot", "opencode"]);
    });
  });

  it("materialized est faux quand la couche déclarait déjà ce champ", async () => {
    await withFakeHome(async () => {
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), '[policy]\ndenied = ["codex"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "opencode", true);
      expect(result.materialized).toBe(false);
      expect(result.effective).toEqual(["codex", "opencode"]);
    });
  });

  it("ne touche pas aux autres champs déjà déclarés par la couche visée", async () => {
    await withFakeHome(async () => {
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 7\n', "utf8");

      await materializePolicyList(root, "project", "denied", "codex", true);

      const layer = await loadLayer("project", root);
      expect(layer.policy?.max_parallel).toBe(7);
      expect(layer.policy?.denied).toEqual(["codex"]);
    });
  });

  it("retirer un id absent laisse la liste effective inchangée (present=false, ensemble)", async () => {
    await withFakeHome(async () => {
      const result = await materializePolicyList(root, "project", "allowed", "codex", false);
      expect(result.effective).toEqual([]);
    });
  });

  it("retrait dans une liste héritée : la moitié symétrique de l'augmentation — le global déclare denied = [a, b], le projet retire a, et matérialise denied = [b]", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot", "opencode"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "copilot", false);
      expect(result.materialized).toBe(true);
      // "copilot" retiré, "opencode" (hérité du global) survit dans la liste matérialisée — pas juste "sans copilot".
      expect(result.effective).toEqual(["opencode"]);

      // Le projet porte désormais cette liste en propre ; le global, lui, n'a pas bougé.
      const projectLayer = await loadLayer("project", root);
      expect(projectLayer).toEqual({ policy: { denied: ["opencode"] } });
      const globalLayer = await loadLayer("global", root);
      expect(globalLayer).toEqual({ policy: { denied: ["copilot", "opencode"] } });

      const { config } = await loadConfig(root);
      expect(config.policy.denied).toEqual(["opencode"]);
    });
  });

  it("le défaut I11 : deux couches, la globale et la projet, se matérialisent indépendamment", async () => {
    // Scénario minimal (voir le scénario complet côté CLI, packages/cli/src/commands/policy.test.ts) : la couche
    // globale ne doit jamais se retrouver aplatie dans la couche projet par une matérialisation de liste.
    await withFakeHome(async () => {
      await materializePolicyList(root, "global", "denied", "copilot", true);
      await materializePolicyList(root, "project", "denied", "opencode", true);

      const globalLayer = await loadLayer("global", root);
      const projectLayer = await loadLayer("project", root);
      expect(globalLayer).toEqual({ policy: { denied: ["copilot"] } });
      expect(projectLayer).toEqual({ policy: { denied: ["copilot", "opencode"] } });

      const { config } = await loadConfig(root);
      expect(config.policy.denied).toEqual(["copilot", "opencode"]);
    });
  });
});
