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
 * Fully isolates the PATH to `dir` (plus `/usr/bin`/`/bin`, neither of
 * which contains an agent CLI): unlike `withShimmedPath`
 * (`test/support.ts`), we do NOT add `dirname(process.execPath)` — that
 * directory can legitimately host a real agent CLI installed via
 * `npm install -g` next to node itself (observed with `copilot` on an nvm
 * machine), which would skew the very detection these tests check. No risk
 * here: `findBinaryInPath` only does an `access`, never a `spawn` — the
 * fake binary therefore does not need to be executable in the "actually
 * runs" sense, only present and +x.
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

/** Deposits a minimal fake binary (never executed, see `withIsolatedPath`) under `dir`. */
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

  it("creates the configuration and one system prompt per default role", async () => {
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

  it("on an already initialized project, without --force: refreshes the assets but leaves `.caesar/config.toml` and `.caesar/roles/*.md` strictly intact (success)", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { agent: ["claude"] }, io)).toBe(EXIT_OK);

      // Hand-edited: this is exactly what the refresh must preserve (see
      // the header of init.ts) — compared by content, not just by presence.
      const configPath = projectConfigPath(root);
      const editedConfig = (await readFile(configPath, "utf8")) + "# edited by hand\n";
      await writeFile(configPath, editedConfig, "utf8");

      const rolePath = join(root, ".caesar", "roles", "reviewer.md");
      const editedRole = "My custom prompt, edited by hand.\n";
      await writeFile(rolePath, editedRole, "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).toBe(editedConfig);
      expect(await readFile(rolePath, "utf8")).toBe(editedRole);
      // The output says the config was left as it was...
      expect(io2.stdoutText()).toMatch(/left untouched/);
      // ...but the assets, for their part, were indeed (re)deposited.
      expect(existsSync(join(root, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
    });
  });

  it("--force overwrites an existing configuration (roles included), and redeposits the assets", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, { agent: ["claude"] }, io)).toBe(EXIT_OK);

      const rolePath = join(root, ".caesar", "roles", "reviewer.md");
      await writeFile(rolePath, "edited by hand: --force must overwrite it.\n", "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { force: true, agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(rolePath, "utf8")).not.toMatch(/must overwrite it/);
    });
  });

  it("warns without failing when the directory is not a git repository", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stderrText()).toMatch(/git repository/);
      expect(io.stderrText()).toMatch(/git init/);
    });
  });

  it("--json renders usable JSON, without ANSI, and nothing else on stdout", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.config_path).toBe(projectConfigPath(root));
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });

  it("--json distinguishes a first init from a refresh via `refreshed` (finding I3)", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).refreshed).toBe(false);

      // Same project, second pass without --force: a refresh, where
      // `role_files: []` and `worktree: null` must not read as "this
      // project has neither roles nor a worktree".
      const io2 = makeIo();
      const code2 = await runInit(root, { json: true }, io2);
      expect(code2).toBe(EXIT_OK);
      const parsed2 = JSON.parse(io2.stdoutText());
      expect(parsed2.refreshed).toBe(true);
      expect(parsed2.role_files).toEqual([]);
      expect(parsed2.worktree).toBeNull();
    });
  });

  it("no longer raises the git warning once the directory is initialized as a repository", async () => {
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

  it("creates ~/.config/caesar/config.toml from defaultConfig(), never the project layer", async () => {
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

  it("on an already present global configuration, without --force: refreshes the assets but leaves the configuration intact (success)", async () => {
    await withFakeHome(async (home) => {
      expect(await runInit(root, { global: true, agent: ["claude"] }, io)).toBe(EXIT_OK);

      const configPath = join(home, ".config", "caesar", "config.toml");
      const edited = (await readFile(configPath, "utf8")) + "# edited by hand\n";
      await writeFile(configPath, edited, "utf8");

      const io2 = makeIo();
      const code = await runInit(root, { global: true, agent: ["claude"] }, io2);
      expect(code).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).toBe(edited);
      expect(io2.stdoutText()).toMatch(/left untouched/);
      expect(existsSync(join(home, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
    });
  });

  it("--force overwrites an existing global configuration, and redeposits the assets", async () => {
    await withFakeHome(async (home) => {
      expect(await runInit(root, { global: true, agent: ["claude"] }, io)).toBe(EXIT_OK);

      const configPath = join(home, ".config", "caesar", "config.toml");
      const edited = (await readFile(configPath, "utf8")) + "# edited by hand: --force must overwrite it\n";
      await writeFile(configPath, edited, "utf8");

      const io2 = makeIo();
      expect(await runInit(root, { global: true, force: true, agent: ["claude"] }, io2)).toBe(EXIT_OK);
      expect(await readFile(configPath, "utf8")).not.toMatch(/must overwrite it/);
    });
  });

  it("--json renders the path and the scope, without ANSI", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true, json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.scope).toBe("global");
      expect(parsed.config_path).toBe(join(home, ".config", "caesar", "config.toml"));
      expect(io.stdoutText()).not.toMatch(/\x1b\[/);
    });
  });

  it("--json distinguishes a first init from a refresh via `refreshed` (finding I3)", async () => {
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

describe("caesar init — .gitignore completion (inside a git repository)", () => {
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

  it("creates the .gitignore with the four entries, when it did not exist", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      const lines = raw.split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual([".caesar/config.local.toml", ".caesar/tasks/", ".caesar/wt/", ".caesar/state/"]);
      expect(io.stdoutText()).toMatch(/\.gitignore completed/);
    });
  });

  it("only adds the missing lines, preserves existing content, does not rewrite from scratch", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.caesar/tasks/\n", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      // The original content survives in full, at the top of the file.
      expect(raw.startsWith("node_modules/\n.caesar/tasks/\n")).toBe(true);
      // The three missing lines are added; ".caesar/tasks/" (already present) is not duplicated.
      const lines = raw.split("\n").filter((line) => line.length > 0);
      expect(lines).toEqual(["node_modules/", ".caesar/tasks/", ".caesar/config.local.toml", ".caesar/wt/", ".caesar/state/"]);
    });
  });

  it("handles an existing file without a trailing newline, without merging the last line with the next", async () => {
    await withFakeHome(async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/", "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw.startsWith("node_modules/\n")).toBe(true);
      expect(raw).toContain(".caesar/config.local.toml");
    });
  });

  it("does not touch the file (no write) when all entries are already present", async () => {
    await withFakeHome(async () => {
      const already = "node_modules/\n.caesar/config.local.toml\n.caesar/tasks/\n.caesar/wt/\n.caesar/state/\n";
      await writeFile(join(root, ".gitignore"), already, "utf8");

      const code = await runInit(root, {}, io);
      expect(code).toBe(EXIT_OK);

      const raw = await readFile(join(root, ".gitignore"), "utf8");
      expect(raw).toBe(already);
      expect(io.stdoutText()).toMatch(/\.gitignore already up to date/);
    });
  });
});

describe("caesar init — .gitignore outside a git repository", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-nogit-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates no .gitignore outside a git repository, and says so in the output (JSON and human)", async () => {
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
      expect(io2.stderrText()).toMatch(/gitignore.*was not completed/);
    });
  });
});

/**
 * `[worktree]`: the section that makes the sub-agents' worktree habitable.
 * Without it, a worktree contains only the files tracked by git — neither
 * installed dependencies nor `.env` — and isolation becomes unusable, hence
 * bypassed. It is the root cause of the original defect, and `caesar init`
 * is the only place where it can be set before that shows up.
 */
describe("caesar init — the sub-agents' workshop ([worktree])", () => {
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

  it("detects a Node project's needs and records them in the project layer", async () => {
    await withFakeHome(async () => {
      await seedNodeProject();
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);

      const { config } = await loadConfig(root);
      expect(config.worktree.copy.sort()).toEqual([".env", "node_modules"]);
      expect(config.worktree.setup).toEqual(["npm install"]);
      // Announced, not deposited in silence: it is an assumption about the project.
      expect(io.stdoutText()).toMatch(/Sub-agent workshop/);
    });
  });

  it("bare project: no section, rather than an empty section that would look like a setting", async () => {
    await withFakeHome(async () => {
      expect(await runInit(root, {}, io)).toBe(EXIT_OK);

      const raw = await readFile(projectConfigPath(root), "utf8");
      expect(raw).not.toMatch(/\[worktree\]/);
      expect(io.stdoutText()).not.toMatch(/Sub-agent workshop/);
    });
  });

  it("never proposes a path that git does not want to ignore", async () => {
    await withFakeHome(async () => {
      // A non-ignored `node_modules` would pollute `caesar diff`, which is
      // the source of truth, and `caesar gc` would never clean that
      // worktree again.
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

  it("--json renders the detected section", async () => {
    await withFakeHome(async () => {
      await seedNodeProject();
      expect(await runInit(root, { json: true }, io)).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.worktree.copy.sort()).toEqual([".env", "node_modules"]);
    });
  });

  it("--force re-detects: a stale section gets updated", async () => {
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
 * The agentic knowledge (Agent Skills skill + commands, `@caesar/core`
 * `installAgentAssets`): an explicit `--agent` is used everywhere the test
 * is about *which* targets are served, to stay independent of what is
 * actually installed on the machine running the suite — see
 * `withIsolatedPath`/`writeFakeBinary` above for the two tests that,
 * conversely, are about PATH detection itself.
 */
describe("caesar init — agentic knowledge (assets)", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-init-assets-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("actually deposits the skill and the commands for the picked targets, on a fresh project", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { agent: ["claude", "codex"] }, io);
      expect(code).toBe(EXIT_OK);

      // claude: dedicated copy, skill and commands.
      expect(existsSync(join(root, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, ".claude", "commands", "caesar-delegate.md"))).toBe(true);
      // codex: shared, skill only (see agent-assets.ts, ASSET_TARGETS).
      expect(existsSync(join(root, ".agents", "skills", "caesar", "SKILL.md"))).toBe(true);
      // opencode was not requested: its dedicated directory does not exist.
      expect(existsSync(join(root, ".opencode", "commands"))).toBe(false);
    });
  });

  it("--agent does restrict the picked targets, and an unknown id fails clearly", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { agent: ["claude", "codex"], json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect([...parsed.assets.targets].sort()).toEqual(["claude", "codex"]);

      const io2 = makeIo();
      const code2 = await runInit(root, { agent: ["not-a-client"] }, io2);
      expect(code2).toBe(EXIT_USAGE);
      expect(io2.stderrText()).toMatch(/not-a-client/);
      expect(io2.stdoutText()).toBe("");
    });
  });

  it("--json renders assets.targets/files/stale without any ANSI sequence, in project and global scope", async () => {
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

  it("--no-skills: assets: null in JSON, and no asset file deposited", async () => {
    await withFakeHome(async () => {
      const code = await runInit(root, { json: true, skills: false }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.assets).toBeNull();
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(existsSync(join(root, ".claude"))).toBe(false);
    });
  });

  it("--global deposits the assets under HOME, never under root/", async () => {
    await withFakeHome(async (home) => {
      const code = await runInit(root, { global: true, agent: ["claude"] }, io);
      expect(code).toBe(EXIT_OK);
      expect(existsSync(join(home, ".claude", "skills", "caesar", "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
    });
  });

  it("detection under a fake PATH: only the target whose binary is present is served", async () => {
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

  it("empty PATH: no runtime detected, the shared base is deposited anyway, and the output says so", async () => {
    await withFakeHome(async () => {
      const previousPath = process.env["PATH"];
      process.env["PATH"] = "";
      try {
        const code = await runInit(root, {}, io);
        expect(code).toBe(EXIT_OK);
        expect(io.stdoutText()).toMatch(/No runtime detected/);
        expect(existsSync(join(root, ".agents", "skills", "caesar", "SKILL.md"))).toBe(true);
        expect(existsSync(join(root, ".claude"))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
      }
    });
  });

  it("--json: a malformed settings.json raises its warning in `warnings`, and the merge does not happen", async () => {
    await withFakeHome(async () => {
      const settingsPath = join(root, ".claude", "settings.json");
      await mkdir(join(root, ".claude"), { recursive: true });
      const malformed = "{ this is not JSON";
      await writeFile(settingsPath, malformed, "utf8");

      const code = await runInit(root, { agent: ["claude"], json: true }, io);
      expect(code).toBe(EXIT_OK);
      const parsed = JSON.parse(io.stdoutText());
      // The module's warning (agent-assets.ts, computeSettingsMerge) rises
      // into the top-level `warnings` array, not only into human output —
      // otherwise a `--json` consumer would only see files deposited
      // successfully and never the skipped merge.
      expect(parsed.warnings.some((w: string) => /invalid JSON/i.test(w))).toBe(true);
      // The merge did not happen: the file stays as-is, still malformed.
      expect(await readFile(settingsPath, "utf8")).toBe(malformed);
    });
  });
});
