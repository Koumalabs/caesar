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
  modelProvenance,
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

// `globalConfigPath()` reads `$HOME` on every call (see node:os#homedir):
// pointing HOME at a temporary directory fully isolates these tests from the
// machine's real `~/.config/caesar/`, without having to change the signature
// of `loadConfig`.
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
  ])("converts %s to %i ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("accepts a raw number interpreted as milliseconds", () => {
    expect(parseDuration(1500)).toBe(1500);
  });

  it("throws on an unrecognized form, showing the accepted forms", () => {
    expect(() => parseDuration("3 fortnights")).toThrow(/10m.*90s.*1h/s);
  });

  it("throws on a negative number", () => {
    expect(() => parseDuration(-1)).toThrow();
  });
});

describe("defaultConfig", () => {
  it("ships three immediately useful roles", () => {
    const config = defaultConfig();
    expect(config.roles.map((r) => r.name)).toEqual(["reviewer", "implementer", "investigator"]);
  });

  it("the reviewer role is read-only, inplace", () => {
    const role = defaultConfig().roles.find((r) => r.name === "reviewer")!;
    expect(role.mode).toBe("read-only");
    expect(role.isolation).toBe("inplace");
    expect(role.agents).toEqual(["codex", "antigravity"]);
  });

  it("the implementer role writes, in a worktree", () => {
    const role = defaultConfig().roles.find((r) => r.name === "implementer")!;
    expect(role.mode).toBe("write");
    expect(role.isolation).toBe("worktree");
    expect(role.agents).toEqual(["codex", "antigravity", "opencode"]);
  });

  it("the investigator role is read-only, auto isolation", () => {
    const role = defaultConfig().roles.find((r) => r.name === "investigator")!;
    expect(role.mode).toBe("read-only");
    expect(role.isolation).toBe("auto");
    expect(role.agents).toEqual(["antigravity", "codex", "opencode"]);
  });

  it("the default policy matches the brief", () => {
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

  it("no custom agent by default", () => {
    expect(defaultConfig().agents).toEqual([]);
  });

  it("no per-agent default model out of the box", () => {
    expect(defaultConfig().models).toEqual({});
  });

  it("returns a fresh copy of models on every call", () => {
    const a = defaultConfig();
    a.models["codex"] = "intruder";
    expect(defaultConfig().models).toEqual({});
  });

  it("each default role already carries the system_prompt_file convention (roles/<name>.md), without any layer having declared it", () => {
    // See the header of `DEFAULT_ROLES" (config.ts): this is what allows `caesar init` (project layer) to only
    // materialize the prompt files, without having to declare the roles in the project's TOML.
    for (const role of defaultConfig().roles) {
      expect(role.system_prompt_file).toBe(`roles/${role.name}.md`);
    }
  });

  it("returns a fresh copy on every call", () => {
    const a = defaultConfig();
    a.roles[0]!.agents.push("intruder");
    a.policy.allowed.push("intruder");
    const b = defaultConfig();
    expect(b.roles[0]!.agents).not.toContain("intruder");
    expect(b.policy.allowed).not.toContain("intruder");
  });
});

describe("globalConfigPath / projectConfigPath", () => {
  it("the global path lives under ~/.config/caesar/config.toml", async () => {
    await withFakeHome(async (home) => {
      expect(globalConfigPath()).toBe(join(home, ".config", "caesar", "config.toml"));
    });
  });

  it("the project path lives under <root>/.caesar/config.toml", () => {
    expect(projectConfigPath("/repo")).toBe(join("/repo", ".caesar", "config.toml"));
  });

  it("follows $HOME even when it differs from what os.homedir() would return — Bun ignores $HOME in os.homedir() (task 15)", async () => {
    // This test passes trivially under Node (vitest, this file): `os.homedir()` already respects `$HOME` there. Its
    // value is to pin the behavior for Bun (`packages/tui`, which consumes this compiled module): writing
    // `os.homedir()` there instead of `process.env.HOME` would regress silently under Bun only, without
    // any Node test detecting it — see `globalConfigPath` for the incident that revealed this defect.
    await withFakeHome(async (home) => {
      expect(globalConfigPath().startsWith(home)).toBe(true);
    });
  });
});

describe("mergeConfig", () => {
  function policyOf(overrides: Partial<PolicyConfig>): PolicyConfig {
    return { ...defaultConfig().policy, ...overrides };
  }

  it("policy merges field by field", () => {
    const base: CaesarConfig = { policy: policyOf({ max_parallel: 4, allow_recursion: false }), roles: [], agents: [] };
    // An override that specifies only a subset of the fields actually present in a
    // TOML file: exactly the shape `parseConfigFile` produces internally, and what
    // the type of `override` (ConfigOverride, policy as Partial<PolicyConfig>) accepts
    // directly, without a cast.
    const merged = mergeConfig(base, { policy: { max_parallel: 8 } });
    expect(merged.policy.max_parallel).toBe(8);
    expect(merged.policy.allow_recursion).toBe(false);
  });

  it("a role with the same name is replaced entirely, not merged field by field", () => {
    const reviewerA: RoleConfig = {
      name: "reviewer",
      purpose: "old",
      agents: ["codex"],
      mode: "read-only",
      isolation: "inplace",
      timeout_ms: 1000,
    };
    const reviewerB: RoleConfig = {
      name: "reviewer",
      purpose: "new",
      agents: ["opencode"],
      mode: "write",
      isolation: "worktree",
      timeout_ms: 2000,
    };
    const base: CaesarConfig = { policy: defaultConfig().policy, roles: [reviewerA], agents: [] };
    const merged = mergeConfig(base, { roles: [reviewerB] });
    expect(merged.roles).toEqual([reviewerB]);
  });

  it("roles specific to each level are kept", () => {
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

  it("same merge-by-key logic for agents", () => {
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

  it("an override without policy leaves the base policy untouched", () => {
    const base: CaesarConfig = { policy: policyOf({ max_parallel: 7 }), roles: [], agents: [] };
    const merged = mergeConfig(base, {});
    expect(merged.policy.max_parallel).toBe(7);
  });

  it("models merge key by key: the override wins on the keys it declares, the others survive", () => {
    const base: CaesarConfig = { ...defaultConfig(), models: { codex: "gpt-5.2", opencode: "big" } };
    const merged = mergeConfig(base, { models: { codex: "gpt-6" } });
    expect(merged.models).toEqual({ codex: "gpt-6", opencode: "big" });
  });

  it("an override without models leaves the base models untouched", () => {
    const base: CaesarConfig = { ...defaultConfig(), models: { codex: "gpt-5.2" } };
    expect(mergeConfig(base, {}).models).toEqual({ codex: "gpt-5.2" });
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

  it("files absent on both sides: default configuration, no source", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config).toEqual(defaultConfig());
      expect(loaded.sources).toEqual({});
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("global alone: its values apply, the global source is set", async () => {
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

  it("project alone: its values apply, the project source is set", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      await writeFile(join(projectRoot, ".caesar", "config.toml"), '[policy]\nmax_parallel = 6\n', "utf8");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.policy.max_parallel).toBe(6);
      expect(loaded.sources.project).toBe(join(projectRoot, ".caesar", "config.toml"));
      expect(loaded.sources.global).toBeUndefined();
    });
  });

  it("both present: the project overrides the global on the fields it specifies", async () => {
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
      // Specified by the project: the project wins.
      expect(loaded.config.policy.max_parallel).toBe(2);
      // Specified by the global only, absent from the project: the global survives.
      expect(loaded.config.policy.allow_recursion).toBe(true);
      expect(loaded.sources.global).toBeDefined();
      expect(loaded.sources.project).toBeDefined();
    });
  });

  it("a project role with the same name as a global role replaces it entirely, without field merging", async () => {
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
          'purpose = "project"',
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
        purpose: "project",
        agents: ["opencode"],
        mode: "write",
        isolation: "worktree",
        // Not declared by the project layer: it is the *entry's* default
        // (RawRoleSchema) that applies, not the global role's value —
        // that is precisely what "replaces entirely" means.
        network: "auto",
        timeout_ms: 1_200_000,
      });
      // The other default roles (implementer, investigator) survive.
      expect(loaded.config.roles.map((r) => r.name).sort()).toEqual(["implementer", "investigator", "reviewer"]);
    });
  });

  it("syntactically invalid TOML produces an error naming the file", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, "[policy\nmax_parallel = 4\n", "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });

  it("a field of the wrong type produces an error naming the field and the file", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[policy]\nmax_parallel = "four"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_parallel/);
    });
  });

  it("an unknown field (typo) produces an error naming it, rather than being silently ignored", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[policy]\nmax_paralel = 4\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/max_paralel/);
    });
  });

  it("an invalid duration produces an error naming the field concerned", async () => {
    await withFakeHome(async () => {
      await mkdir(join(projectRoot, ".caesar"), { recursive: true });
      const path = join(projectRoot, ".caesar", "config.toml");
      await writeFile(path, '[[role]]\nname = "x"\nagents = ["codex"]\nmode = "write"\ntimeout = "3 fortnights"\n', "utf8");

      await expect(loadConfig(projectRoot)).rejects.toThrow(/timeout/);
    });
  });

  it("an unreadable configuration file (directory instead of a file) is an error naming the file", async () => {
    await withFakeHome(async () => {
      const path = join(projectRoot, ".caesar", "config.toml");
      // A directory with the same name as the expected file: the read fails with something other than ENOENT.
      await mkdir(path, { recursive: true });

      await expect(loadConfig(projectRoot)).rejects.toThrow(path);
    });
  });
});

/**
 * `[worktree]` — the section that makes the worktree habitable. Without it, a
 * worktree only contains the files tracked by git: no installed
 * dependencies, no `.env`, no ignored directories — and isolation becomes
 * unusable, hence bypassed. See `WorktreeConfig`.
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

  it("absent everywhere: three empty lists, never undefined", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree).toEqual({ copy: [], link: [], setup: [] });
    });
  });

  it("reads copy, link and setup", async () => {
    await withFakeHome(async () => {
      await writeProject('[worktree]\ncopy = ["node_modules", ".env"]\nlink = ["big-cache"]\nsetup = ["pnpm install --offline"]\n');
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree).toEqual({
        copy: ["node_modules", ".env"],
        link: ["big-cache"],
        setup: ["pnpm install --offline"],
      });
    });
  });

  it("a field absent from the file says nothing: the previous layer keeps it", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules"]\nsetup = ["npm ci"]\n', "utf8");
      await writeProject('[worktree]\nsetup = ["pnpm install"]\n');

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual(["node_modules"]);
      expect(loaded.config.worktree.setup).toEqual(["pnpm install"]);
    });
  });

  it("replaces the inherited list instead of adding to it", async () => {
    // The property that makes local removal possible: a union would leave an
    // entry inherited from the global impossible to remove on the project side.
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules", ".venv"]\n', "utf8");
      await writeProject('[worktree]\ncopy = [".env"]\n');

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual([".env"]);
    });
  });

  it("declared empty list: removes everything that was inherited", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[worktree]\ncopy = ["node_modules"]\n', "utf8");
      await writeProject("[worktree]\ncopy = []\n");

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual([]);
    });
  });

  describe("paths refused at load time, with their cause", () => {
    // An invalid entry is a configuration error, not an execution
    // circumstance: it must show up when reading the file, not turn
    // later into a task that fails without anyone knowing why.
    const cases: [string, string, RegExp][] = [
      ["absolute", '[worktree]\ncopy = ["/etc/passwd"]\n', /absolute/],
      ["upward traversal", '[worktree]\ncopy = ["../elsewhere"]\n', /\.\./],
      ["nested climbing", '[worktree]\nlink = ["a/../../b"]\n', /\.\./],
      [".git", '[worktree]\ncopy = [".git"]\n', /\.git/],
      [".caesar", '[worktree]\nlink = [".caesar/state"]\n', /\.caesar/],
      ["empty", '[worktree]\ncopy = [""]\n', /empty/],
    ];
    for (const [name, toml, pattern] of cases) {
      it(name, async () => {
        await withFakeHome(async () => {
          await writeProject(toml);
          await expect(loadConfig(projectRoot)).rejects.toThrow(pattern);
        });
      });
    }

    it("unknown field in the section: refused like everywhere else", async () => {
      await withFakeHome(async () => {
        await writeProject('[worktree]\ncoppy = ["node_modules"]\n');
        await expect(loadConfig(projectRoot)).rejects.toThrow(/unknown field/);
      });
    });
  });

  it("accepts a legitimate nested path", async () => {
    await withFakeHome(async () => {
      await writeProject('[worktree]\ncopy = ["packages/api/node_modules", ".superpowers"]\n');
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.worktree.copy).toEqual(["packages/api/node_modules", ".superpowers"]);
    });
  });

  it("survives the saveLayer/loadLayer round-trip", async () => {
    await withFakeHome(async () => {
      const worktree = { copy: ["node_modules"], link: ["cache"], setup: ["pnpm install --offline"] };
      await saveLayer("project", projectRoot, { worktree });
      expect(await loadLayer("project", projectRoot)).toEqual({ worktree });
    });
  });
});

/**
 * `[models]` — the per-agent default model table. A twin of `[policy]` in its
 * merge semantics (key by key), never of `[[agent]]`: declaring an
 * `[[agent]]` entry with a native id would replace the native adapter
 * entirely (see `listAgentDefinitions`), which is exactly what a mere model
 * preference must not do.
 */
describe("[models]", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "caesar-models-cfg-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeProject(toml: string): Promise<void> {
    await mkdir(join(projectRoot, ".caesar"), { recursive: true });
    await writeFile(join(projectRoot, ".caesar", "config.toml"), toml, "utf8");
  }

  it("absent everywhere: an empty table, never undefined", async () => {
    await withFakeHome(async () => {
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.models).toEqual({});
    });
  });

  it("reads a per-agent default model table", async () => {
    await withFakeHome(async () => {
      await writeProject('[models]\ncodex = "gpt-5.2"\nclaude = "claude-opus-5"\n');
      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.models).toEqual({ codex: "gpt-5.2", claude: "claude-opus-5" });
    });
  });

  it("merges key by key across layers: the project wins on the keys it redeclares, the global keeps the others", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[models]\ncodex = "gpt-5.2"\nopencode = "big"\n', "utf8");
      await writeProject('[models]\ncodex = "gpt-6"\n');

      const loaded = await loadConfig(projectRoot);
      expect(loaded.config.models).toEqual({ codex: "gpt-6", opencode: "big" });
    });
  });

  it("an empty value is refused: removing a default means deleting the key, not emptying it", async () => {
    await withFakeHome(async () => {
      await writeProject('[models]\ncodex = ""\n');
      await expect(loadConfig(projectRoot)).rejects.toThrow(/models\.codex/);
      await expect(loadConfig(projectRoot)).rejects.toThrow(/empty/);
    });
  });

  it("a non-string value is refused, naming the field and the file", async () => {
    await withFakeHome(async () => {
      await writeProject("[models]\ncodex = 4\n");
      await expect(loadConfig(projectRoot)).rejects.toThrow(/models\.codex/);
    });
  });

  it("a file without [models] declares nothing: loadLayer stays faithful", async () => {
    await withFakeHome(async () => {
      await writeProject("[policy]\nmax_parallel = 3\n");
      const layer = await loadLayer("project", projectRoot);
      expect(layer.models).toBeUndefined();
    });
  });

  it("survives the saveLayer/loadLayer round-trip", async () => {
    await withFakeHome(async () => {
      const models = { codex: "gpt-5.2", claude: "claude-opus-5" };
      await saveLayer("project", projectRoot, { models });
      expect(await loadLayer("project", projectRoot)).toEqual({ models });
    });
  });
});

describe("saveLayer / loadConfig — round-trip", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "caesar-roundtrip-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("re-reads an equivalent configuration after writing", async () => {
    await withFakeHome(async () => {
      // `loadConfig` always rebuilds its base from `defaultConfig()`:
      // for the round-trip to be faithful, the saved configuration
      // must already be the complete (post-merge) shape we want to find again —
      // exactly what a real project file would produce once merged
      // with the default configuration, `reviewer`/`implementer`/`investigator`
      // included. `saveLayer` directly accepts a complete `CaesarConfig`: it
      // structurally satisfies `ConfigOverride` (all its fields present).
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
            purpose: "Test role.",
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
            id: "myagent",
            displayName: "My agent",
            bin: "my-cli",
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

  it("a declared agent keeps its \"native read-only\" capability across the round-trip", async () => {
    // The only capability `[[agent]]` can carry (see `RawAgentSchema`) —
    // and the only one the engine honors without the command line having to
    // cooperate: `runner.ts` uses it to decide whether a read-only task
    // must be isolated in a worktree. Lost on re-read, the
    // declaration would be silently ineffective.
    const override = {
      agents: [{ id: "myagent", bin: "my-cli", args: ["{{prompt}}"], capabilities: { nativeReadOnly: true } }],
    };
    await saveLayer("project", projectRoot, override);
    const layer = await loadLayer("project", projectRoot);
    expect(layer.agents).toEqual(override.agents);
  });

  it("an agent without a declared capability does not get one invented for it", async () => {
    await saveLayer("project", projectRoot, { agents: [{ id: "myagent", bin: "my-cli", args: ["{{prompt}}"] }] });
    const layer = await loadLayer("project", projectRoot);
    expect(layer.agents?.[0]).not.toHaveProperty("capabilities");
  });

  it("writes a header warning that manual comments do not survive", async () => {
    await saveLayer("project", projectRoot, defaultConfig());
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    expect(raw.split("\n")[0]).toMatch(/^#.*comment/i);
  });

  it("writes atomically (temporary file renamed, no residue)", async () => {
    await saveLayer("project", projectRoot, defaultConfig());
    const entries = await readdir(join(projectRoot, ".caesar"));
    expect(entries).toEqual(["config.toml"]);
  });

  it("serializes only what the override declares: a partial override produces a file carrying only that field", async () => {
    await saveLayer("project", projectRoot, { policy: { denied: ["copilot", "opencode"] } });
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");

    // The file must carry no trace of the defaults (max_parallel, roles…): only what the override
    // declared. This is the file-level proof that `saveLayer` never rewrites the merge. Structural
    // comparison (via `parseToml`) rather than a literal substring: insensitive to whitespace formatting in
    // TOML arrays (smol-toml writes `[ "a", "b" ]`, not `["a", "b"]`).
    expect(parseToml(raw)).toEqual({ policy: { denied: ["copilot", "opencode"] } });
    expect(raw).not.toContain("max_parallel");
    expect(raw).not.toContain("[[role]]");
    expect(raw).not.toContain("[[agent]]");
    expect(raw).not.toContain("allowed");

    // And re-reading this single layer returns only what was declared.
    const layer = await loadLayer("project", projectRoot);
    expect(layer).toEqual({ policy: { denied: ["copilot", "opencode"] } });
  });

  it("an empty override writes no section — just the header", async () => {
    await saveLayer("project", projectRoot, {});
    const raw = await readFile(projectConfigPath(projectRoot), "utf8");
    expect(raw.trim()).toBe(
      "# File generated by @caesar/core: comments added by hand do not survive the next write.",
    );
    expect(await loadLayer("project", projectRoot)).toEqual({});
  });
});

describe("configPathFor / localConfigPath", () => {
  it("delegates to globalConfigPath/projectConfigPath/localConfigPath depending on the layer", async () => {
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

  it("an absent file yields an empty override, not an error", async () => {
    await withFakeHome(async () => {
      expect(await loadLayer("global", root)).toEqual({});
      expect(await loadLayer("project", root)).toEqual({});
      expect(await loadLayer("local", root)).toEqual({});
    });
  });

  it("returns exactly what the file declares, never the defaults nor the other layers", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 9\n', "utf8");

    const layer = await loadLayer("project", root);
    expect(layer).toEqual({ policy: { max_parallel: 9 } });
    // Neither "denied"/"allowed" (absent from the file), nor the default roles.
    expect(layer.roles).toBeUndefined();
  });

  it("reads the local layer (config.local.toml), distinct from the project layer", async () => {
    await mkdir(join(root, ".caesar"), { recursive: true });
    await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 2\n', "utf8");
    await writeFile(join(root, ".caesar", "config.local.toml"), '[policy]\nmax_parallel = 7\n', "utf8");

    expect(await loadLayer("project", root)).toEqual({ policy: { max_parallel: 2 } });
    expect(await loadLayer("local", root)).toEqual({ policy: { max_parallel: 7 } });
  });
});

describe("loadConfig — three layers, the local one included", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-threelayers-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the local wins over the project, which wins over the global, on the fields it specifies", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), "[policy]\nmax_parallel = 9\nallow_recursion = true\n", "utf8");
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), "[policy]\nmax_parallel = 2\n", "utf8");
      await writeFile(join(root, ".caesar", "config.local.toml"), "[policy]\nmax_parallel = 5\n", "utf8");

      const loaded = await loadConfig(root);
      // Specified by all three: the local (the most specific) wins.
      expect(loaded.config.policy.max_parallel).toBe(5);
      // Specified by the global only: survives, no more specific layer touched it.
      expect(loaded.config.policy.allow_recursion).toBe(true);
      expect(loaded.sources.global).toBeDefined();
      expect(loaded.sources.project).toBeDefined();
      expect(loaded.sources.local).toBe(join(root, ".caesar", "config.local.toml"));
    });
  });

  it("exposes the three layers in application order, including those whose file is absent", async () => {
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

  it("no layer: loadConfig(...).config stays the default configuration, as before the local layer was introduced", async () => {
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

  it("policyFieldProvenance: \"default\" when no layer declares the field", () => {
    const layers = layersOf({});
    expect(policyFieldProvenance(layers, "max_parallel")).toBe("default");
  });

  it("policyFieldProvenance: the most specific layer that declares the field wins", () => {
    const layers = layersOf({
      global: { policy: { max_parallel: 9, allow_recursion: true } },
      project: { policy: { max_parallel: 2 } },
    });
    // Declared by project (more specific than global): provenance "project".
    expect(policyFieldProvenance(layers, "max_parallel")).toBe("project");
    // Declared by global only: provenance "global".
    expect(policyFieldProvenance(layers, "allow_recursion")).toBe("global");
    // Never declared: "default".
    expect(policyFieldProvenance(layers, "max_depth")).toBe("default");
  });

  it("roleProvenance: the layer that declares a [[role]] entry of that name, \"default\" otherwise", () => {
    const role = (name: string): RoleConfig => ({ name, purpose: "", agents: [], mode: "write", isolation: "auto", timeout_ms: 1 });
    const layers = layersOf({
      global: { roles: [role("reviewer")] },
      local: { roles: [role("reviewer")] },
    });
    // Declared by global AND local: the local (more specific) wins.
    expect(roleProvenance(layers, "reviewer")).toBe("local");
    expect(roleProvenance(layers, "implementer")).toBe("default");
  });

  it("agentProvenance: the layer that declares an [[agent]] entry with that id, \"default\" otherwise (native agents included)", () => {
    const layers = layersOf({ project: { agents: [{ id: "myagent", bin: "my-cli", args: [] }] } });
    expect(agentProvenance(layers, "myagent")).toBe("project");
    expect(agentProvenance(layers, "codex")).toBe("default");
  });

  it("modelProvenance: the most specific layer that declares this agent's key, \"default\" otherwise — per key, not per table", () => {
    const layers = layersOf({
      global: { models: { codex: "gpt-5.2", opencode: "big" } },
      local: { models: { codex: "gpt-6" } },
    });
    expect(modelProvenance(layers, "codex")).toBe("local");
    // The local layer declares *a* [models] table, but not this key: the global keeps the provenance.
    expect(modelProvenance(layers, "opencode")).toBe("global");
    expect(modelProvenance(layers, "claude")).toBe("default");
  });
});

describe("materializeListEdit", () => {
  it("adds an id to the effective list, materialized if the layer did not yet declare the field", () => {
    const result = materializeListEdit(["copilot"], undefined, "opencode", true);
    expect(result).toEqual({ effective: ["copilot", "opencode"], materialized: true });
  });

  it("is not materialized when the layer already declares the field, even empty", () => {
    const result = materializeListEdit(["codex"], [], "codex", true);
    expect(result).toEqual({ effective: ["codex"], materialized: false });
  });

  it("removes an id, without duplicating if present several times in the effective list", () => {
    const result = materializeListEdit(["codex", "opencode"], ["codex", "opencode"], "codex", false);
    expect(result).toEqual({ effective: ["opencode"], materialized: false });
  });

  it("is the computation materializePolicyList then applies to disk (same result, in memory)", async () => {
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

  it("grows the effective list (not just the added id) and writes that result into the targeted layer", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "opencode", true);
      expect(result.effective).toEqual(["copilot", "opencode"]);
      expect(result.materialized).toBe(true);

      // The project layer now carries the entire effective list, not just "opencode".
      const layer = await loadLayer("project", root);
      expect(layer.policy?.denied).toEqual(["copilot", "opencode"]);
    });
  });

  it("materialized is false when the layer already declared this field", async () => {
    await withFakeHome(async () => {
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), '[policy]\ndenied = ["codex"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "opencode", true);
      expect(result.materialized).toBe(false);
      expect(result.effective).toEqual(["codex", "opencode"]);
    });
  });

  it("does not touch the other fields already declared by the targeted layer", async () => {
    await withFakeHome(async () => {
      await mkdir(join(root, ".caesar"), { recursive: true });
      await writeFile(join(root, ".caesar", "config.toml"), '[policy]\nmax_parallel = 7\n', "utf8");

      await materializePolicyList(root, "project", "denied", "codex", true);

      const layer = await loadLayer("project", root);
      expect(layer.policy?.max_parallel).toBe(7);
      expect(layer.policy?.denied).toEqual(["codex"]);
    });
  });

  it("removing an absent id leaves the effective list unchanged (present=false, set semantics)", async () => {
    await withFakeHome(async () => {
      const result = await materializePolicyList(root, "project", "allowed", "codex", false);
      expect(result.effective).toEqual([]);
    });
  });

  it("removal from an inherited list: the symmetric half of growing it — the global declares denied = [a, b], the project removes a, and materializes denied = [b]", async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, ".config", "caesar"), { recursive: true });
      await writeFile(join(home, ".config", "caesar", "config.toml"), '[policy]\ndenied = ["copilot", "opencode"]\n', "utf8");

      const result = await materializePolicyList(root, "project", "denied", "copilot", false);
      expect(result.materialized).toBe(true);
      // "copilot" removed, "opencode" (inherited from the global) survives in the materialized list — not just "without copilot".
      expect(result.effective).toEqual(["opencode"]);

      // The project now carries this list in its own right; the global, for its part, has not moved.
      const projectLayer = await loadLayer("project", root);
      expect(projectLayer).toEqual({ policy: { denied: ["opencode"] } });
      const globalLayer = await loadLayer("global", root);
      expect(globalLayer).toEqual({ policy: { denied: ["copilot", "opencode"] } });

      const { config } = await loadConfig(root);
      expect(config.policy.denied).toEqual(["opencode"]);
    });
  });

  it("the I11 defect: two layers, the global and the project, materialize independently", async () => {
    // Minimal scenario (see the full scenario on the CLI side, packages/cli/src/commands/policy.test.ts): the
    // global layer must never end up flattened into the project layer by a list materialization.
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
