import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeConfig } from "../config.js";
import { createWorktree } from "./worktree.js";
import { detectUntrackedNeeds, isUnderPath, materializeUntracked, runSetup } from "./materialize.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function request(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
  return { copy: [], link: [], setup: [], ...overrides };
}

describe("materializeUntracked", () => {
  let root: string;
  let worktree: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-materialize-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "caesar-test@example.com"]);
    await git(root, ["config", "user.name", "Caesar Test"]);
    await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n.superpowers/\ncache/\n", "utf8");
    await writeFile(join(root, "a.txt"), "hello\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "init"]);
    worktree = (await createWorktree(root, "t_mat")).path;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedIgnored(path: string, content = "content\n"): Promise<void> {
    await mkdir(join(root, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."), { recursive: true });
    await writeFile(join(root, path), content, "utf8");
  }

  it("copies an ignored directory and returns the mechanism used", async () => {
    // The case that made isolation unusable: `node_modules` is ignored by
    // git, therefore absent from the worktree, therefore nothing runs there.
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));

    expect(result.materialized).toHaveLength(1);
    expect(result.materialized[0]!.path).toBe("node_modules");
    expect(["clone", "copy"]).toContain(result.materialized[0]!.via);
    expect(result.excluded).toEqual(["node_modules"]);
    expect(result.shared).toEqual([]);
    expect(await readFile(join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("the copy is genuinely isolated: writing in the worktree does not touch the workspace", async () => {
    // The property that distinguishes `copy` from `link`, and that justifies
    // making it the default: on a copy-on-write filesystem the clone costs
    // nothing, and the subagent still remains confined to its own space.
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "marker.txt"), "original\n", "utf8");

    await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
    await writeFile(join(worktree, "node_modules", "marker.txt"), "modified by the agent\n", "utf8");

    expect(await readFile(join(root, "node_modules", "marker.txt"), "utf8")).toBe("original\n");
  });

  it("copies an ignored file, not only a directory", async () => {
    await seedIgnored(".env", "SECRET=1\n");
    const result = await materializeUntracked(root, worktree, request({ copy: [".env"] }));
    expect(result.excluded).toEqual([".env"]);
    expect(await readFile(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("places a symlink for `link`, and flags it as not isolated", async () => {
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(join(root, "cache", "big.bin"), "x".repeat(64), "utf8");

    const result = await materializeUntracked(root, worktree, request({ link: ["cache"] }));

    expect(result.materialized).toEqual([{ path: "cache", via: "link" }]);
    // The sharing must be said: two simultaneous tasks write there in the
    // same place, and what they break there, they break for the workspace.
    expect(result.shared).toEqual(["cache"]);
    expect((await lstat(join(worktree, "cache"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "cache"))).toContain("cache");
  });

  it("creates the intermediate directories of a nested path", async () => {
    await mkdir(join(root, "packages", "api", "node_modules"), { recursive: true });
    await writeFile(join(root, "packages", "api", "node_modules", "x.js"), "1\n", "utf8");
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");

    const result = await materializeUntracked(root, worktree, request({ copy: ["packages/api/node_modules"] }));
    expect(result.excluded).toEqual(["packages/api/node_modules"]);
    expect(await readFile(join(worktree, "packages", "api", "node_modules", "x.js"), "utf8")).toBe("1\n");
  });

  describe("what is skipped, and why", () => {
    it("absent from the workspace: nothing to place", async () => {
      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped).toEqual([expect.objectContaining({ path: "node_modules", reason: "absent" })]);
    });

    it("tracked by git: never overwritten — a link would make the agent write into the main repository", async () => {
      // The worst possible case, and the reason for the order of the checks:
      // a link placed on a tracked path would reopen exactly the defect this
      // whole fix closes.
      const result = await materializeUntracked(root, worktree, request({ link: ["a.txt"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ path: "a.txt", reason: "tracked" });
      expect(result.skipped[0]!.detail).toContain("main repository");
      // The worktree's tracked file remains git's, intact.
      expect((await lstat(join(worktree, "a.txt"))).isSymbolicLink()).toBe(false);
    });

    it("neither tracked nor ignored: placing it would pollute the diff that is the source of truth", async () => {
      await writeFile(join(root, "draft.txt"), "untracked, not ignored\n", "utf8");
      const result = await materializeUntracked(root, worktree, request({ copy: ["draft.txt"] }));
      expect(result.materialized).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ path: "draft.txt", reason: "not-ignored" });
      expect(result.skipped[0]!.detail).toContain(".gitignore");
    });

    it("already present in the worktree: left as is", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "x.js"), "workspace\n", "utf8");
      await mkdir(join(worktree, "node_modules"), { recursive: true });
      await writeFile(join(worktree, "node_modules", "x.js"), "already there\n", "utf8");

      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"] }));
      expect(result.skipped[0]).toMatchObject({ path: "node_modules", reason: "already-present" });
      expect(await readFile(join(worktree, "node_modules", "x.js"), "utf8")).toBe("already there\n");
    });

    it("the same path in copy and in link: the copy wins, since it isolates", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "x.js"), "1\n", "utf8");

      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules"], link: ["node_modules"] }));
      expect(result.materialized).toHaveLength(1);
      expect(result.materialized[0]!.via).not.toBe("link");
      expect(result.shared).toEqual([]);
      expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(false);
    });

    it("every finding carries a readable sentence, never a bare code", async () => {
      const result = await materializeUntracked(root, worktree, request({ copy: ["node_modules", "a.txt"] }));
      for (const entry of result.skipped) {
        expect(entry.detail.length).toBeGreaterThan(20);
        expect(entry.detail).toContain(entry.path);
      }
    });
  });

  describe("invalid configuration: throws, rather than skipping", () => {
    // An invalid path is not an execution circumstance: it is an error the
    // file's author must see.
    const cases: [string, WorktreeConfig][] = [
      ["absolute", request({ copy: ["/etc/passwd"] })],
      ["traversal", request({ copy: ["../elsewhere"] })],
      [".git", request({ copy: [".git"] })],
      [".caesar", request({ link: [".caesar/state"] })],
      ["empty", request({ copy: [""] })],
    ];
    for (const [name, cfg] of cases) {
      it(name, async () => {
        await expect(materializeUntracked(root, worktree, cfg)).rejects.toThrow(/invalid/);
      });
    }

    it("places nothing at all when a single entry is invalid", async () => {
      // Validation runs over the whole plan before the first write: a
      // half-set-up workshop would be worse than a clean refusal.
      await mkdir(join(root, "node_modules"), { recursive: true });
      await expect(
        materializeUntracked(root, worktree, request({ copy: ["node_modules", "../outside"] })),
      ).rejects.toThrow();
      await expect(lstat(join(worktree, "node_modules"))).rejects.toThrow();
    });
  });
});

describe("runSetup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "caesar-setup-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the commands in the worktree, in order", async () => {
    const result = await runSetup(dir, ["echo one > one.txt", "echo two > two.txt"]);
    expect(result.failure).toBeUndefined();
    expect(result.ran).toEqual(["echo one > one.txt", "echo two > two.txt"]);
    expect((await readFile(join(dir, "one.txt"), "utf8")).trim()).toBe("one");
    expect((await readFile(join(dir, "two.txt"), "utf8")).trim()).toBe("two");
  });

  it("goes through a shell: chaining and redirections work", async () => {
    // What projects actually write here looks like
    // `npm ci && npm run build`.
    const result = await runSetup(dir, ["mkdir -p a/b && echo ok > a/b/c.txt"]);
    expect(result.failure).toBeUndefined();
    expect((await readFile(join(dir, "a", "b", "c.txt"), "utf8")).trim()).toBe("ok");
  });

  it("stops at the first failing command, and does not launch the next one", async () => {
    const result = await runSetup(dir, ["echo before > before.txt", "exit 3", "echo after > after.txt"]);
    expect(result.ran).toEqual(["echo before > before.txt"]);
    expect(result.failure).toMatchObject({ command: "exit 3", exitCode: 3 });
    await expect(readFile(join(dir, "after.txt"), "utf8")).rejects.toThrow();
  });

  it("returns the failing command's output, so the reason suffices to understand", async () => {
    const result = await runSetup(dir, ["echo 'root cause' >&2; exit 1"]);
    expect(result.failure!.output).toContain("root cause");
  });

  it("no commands: does not fail", async () => {
    expect(await runSetup(dir, [])).toEqual({ ran: [] });
  });
});

describe("detectUntrackedNeeds", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-detect-"));
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "caesar-test@example.com"]);
    await git(root, ["config", "user.name", "Caesar Test"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function commitIgnore(lines: string): Promise<void> {
    await writeFile(join(root, ".gitignore"), lines, "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "init"]);
  }

  it("bare project: nothing at all, rather than an empty section", async () => {
    // An empty section would suggest a setting. `caesar init` then writes
    // nothing.
    await commitIgnore("");
    expect(await detectUntrackedNeeds(root)).toBeNull();
  });

  it("pnpm project: node_modules and the pnpm command", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected).toEqual({ copy: ["node_modules"], link: [], setup: ["pnpm install --frozen-lockfile --prefer-offline"] });
  });

  it("the most specific marker fixes the command: a pnpm project does not receive npm install", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.setup).toEqual(["npm ci"]);
  });

  it("proposes only what exists: no node_modules, no copy entry", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
    expect(detected!.setup).toEqual(["npm install"]);
  });

  it("never proposes a path git refuses to ignore", async () => {
    // The detection applies upstream exactly the rules the placement will
    // require: proposing a non-ignored path would pollute the diff that is
    // the source of truth, and `caesar gc` would never clean up this
    // worktree again.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("# nothing ignored\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
  });

  it("never proposes a path tracked by git", async () => {
    // Proposing a tracked path would reopen the original defect: the agent
    // would write into the main repository.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "committed.js"), "1\n", "utf8");
    await commitIgnore("");

    const detected = await detectUntrackedNeeds(root);
    expect(detected!.copy).toEqual([]);
  });

  it("brings along an ignored .env, whatever the ecosystem", async () => {
    await commitIgnore(".env\n");
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
    expect((await detectUntrackedNeeds(root))!.copy).toEqual([".env"]);
  });

  it("Rust project: target, without a command", async () => {
    await writeFile(join(root, "Cargo.toml"), "[package]\n", "utf8");
    await commitIgnore("target/\n");
    await mkdir(join(root, "target"), { recursive: true });

    expect(await detectUntrackedNeeds(root)).toEqual({ copy: ["target"], link: [], setup: [] });
  });

  it("never proposes a link: the copy isolates, the link does not", async () => {
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n");
    await mkdir(join(root, "node_modules"), { recursive: true });

    expect((await detectUntrackedNeeds(root))!.link).toEqual([]);
  });

  it("what it proposes, materializeUntracked knows how to place", async () => {
    // The property that binds the two functions: a detection that proposed
    // what the placement skips would produce a configuration file every run
    // would complain about.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await commitIgnore("node_modules/\n.env\n");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "x.js"), "1\n", "utf8");
    await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");

    const detected = (await detectUntrackedNeeds(root))!;
    const worktree = (await createWorktree(root, "t_detect")).path;
    const result = await materializeUntracked(root, worktree, detected);

    expect(result.skipped).toEqual([]);
    expect(result.excluded.sort()).toEqual([".env", "node_modules"]);
  });
});

describe("isUnderPath", () => {
  it("recognizes an exact path and its descendants", () => {
    expect(isUnderPath("node_modules", "node_modules")).toBe(true);
    expect(isUnderPath("node_modules/pkg/index.js", "node_modules")).toBe(true);
    expect(isUnderPath("packages/api/node_modules/x", "packages/api/node_modules")).toBe(true);
  });

  it("compares by segments, never by string prefix", () => {
    // `node_modules-old` is not a child of `node_modules`: a bare string
    // comparison would have wrongly excluded it from the diff.
    expect(isUnderPath("node_modules-old/x", "node_modules")).toBe(false);
    expect(isUnderPath("other/node_modules", "node_modules")).toBe(false);
  });
});
