import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@caesar/protocol";
import { REPORT_PROTOCOL, readTask, taskPaths } from "@caesar/protocol";
import { fileTaskStore, type TaskStore } from "../store.js";
import { garbageCollectWorktrees } from "./gc.js";
import { createQueue } from "./queue.js";

const execFileAsync = promisify(execFile);

/**
 * Replaces the fixed registry (the five real agents) with a version that can
 * additionally resolve `"fake-agent"` / `"fake-agent-native-ro"` to the test
 * fake agent, built with `createGenericAgent` — exactly as the
 * brief asks ("it declares itself to the registry via GenericAgentSpec").
 *
 * The registry itself (`../registry/index.ts`) is not modified: task 3
 * shipped and tested it, this module merely consumes it, including in
 * this test workaround.
 */
vi.mock("../registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry/index.js")>();
  const { createGenericAgent } = await import("../registry/generic.js");
  const { fileURLToPath } = await import("node:url");
  const fakeAgentPath = fileURLToPath(new URL("../../test/fixtures/fake-agent.mjs", import.meta.url));

  const fakeAgentDefinition = createGenericAgent({
    id: "fake-agent",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: false },
  });
  const fakeAgentNativeReadOnlyDefinition = createGenericAgent({
    id: "fake-agent-native-ro",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { nativeReadOnly: true },
  });
  const fakeAgentFinalMessageDefinition = createGenericAgent({
    id: "fake-agent-final-message",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { finalMessageFile: true },
  });
  // `mcpInjection: "flag"`: an agent that can load an MCP server from the
  // command line — a necessary condition for the runner to build a
  // `Channel` (task 9). `createGenericAgent` does not know how to inject the
  // MCP configuration itself (it is not one of the five real adapters);
  // only `task.channel`, read directly from `task.json`, matters here —
  // that is what the fake agent's new "ask" mode does.
  const fakeAgentChannelDefinition = createGenericAgent({
    id: "fake-agent-channel",
    bin: process.execPath,
    args: [fakeAgentPath, "{{prompt}}"],
    capabilities: { mcpInjection: "flag" },
  });

  return {
    ...actual,
    resolveAgentDefinition: (id: string) => {
      if (id === "fake-agent") return fakeAgentDefinition;
      if (id === "fake-agent-native-ro") return fakeAgentNativeReadOnlyDefinition;
      if (id === "fake-agent-final-message") return fakeAgentFinalMessageDefinition;
      if (id === "fake-agent-channel") return fakeAgentChannelDefinition;
      return actual.resolveAgentDefinition(id);
    },
  };
});

/**
 * `vi.hoisted`: mutable state safe to reference from inside a
 * `vi.mock` hoisted above everything else in the file (see the vitest
 * docs) — a plain `let` declared here would be read before its
 * initialization (TDZ), since the mock that captures it can run as soon as
 * the hoisted imports resolve, before this module has finished evaluating.
 */
const channelResolutionFailure = vi.hoisted(() => ({ active: false }));

/**
 * Simulates a failure to resolve the return channel binary (`resolveChannelEntry`,
 * `runner.ts`) without touching the real module system or the actual
 * installation of `@caesar/mcp-channel`: only `require.resolve("@caesar/mcp-channel")`
 * is intercepted, and only while `channelResolutionFailure.active` is
 * true (enabled for the duration of a single test below) — everything else in
 * this file keeps resolving normally, including the "return channel" tests
 * that precede this one and that need a successful resolution.
 */
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const real = actual.createRequire(...args);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "resolve") {
            return (id: string, options?: { paths?: string[] | null }) => {
              if (id === "@caesar/mcp-channel" && channelResolutionFailure.active) {
                throw new Error("simulated failed resolution, for the degradation test (task 9)");
              }
              return target.resolve(id, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { runTask, configureChannelLauncher, defaultChannelLauncher } = await import("./runner.js");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "caesar-test@example.com"]);
  await git(root, ["config", "user.name", "Caesar Test"]);
  // What `caesar init` writes into every real project. Without this line, each
  // isolated task would carry the "Worktrees not ignored by git" finding —
  // true, but off topic for the tests that follow. The finding itself is
  // checked by `initGitRepoWithoutIgnore`, below.
  await writeFile(join(root, ".gitignore"), ".caesar/wt/\n", "utf8");
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

/** The same repository, but without the line `caesar init` writes — for the step-0 finding. */
async function initGitRepoWithoutIgnore(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "caesar-test@example.com"]);
  await git(root, ["config", "user.name", "Caesar Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

/**
 * A freshly initialized git repository, without a single commit: its branch
 * is unborn and `HEAD` points to nothing. `repoRoot` resolves it like any
 * other repository — that is precisely what makes this case distinct from
 * the "not a git repository" case tested right next to it.
 */
async function initGitRepoWithoutCommit(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "caesar-test@example.com"]);
  await git(root, ["config", "user.name", "Caesar Test"]);
}

describe("runTask", () => {
  let root: string;
  let store: TaskStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "caesar-runner-")));
    store = fileTaskStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("model warning from the caller", () => {
    it("pours modelWarning into the report as an info finding, like networkWarning", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        {
          agentId: "fake-agent",
          objective: "write",
          mode: "write",
          workspace: root,
          modelWarning: 'Model "x" ignored: agent "fake-agent" does not support choosing a model.',
        },
      );

      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.report.findings).toEqual([
        expect.objectContaining({ severity: "info", title: expect.stringMatching(/model/i) }),
      ]);
    });
  });

  describe('"auto" isolation rule', () => {
    it("write + git repository → worktree", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "write", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      // Named to be read: role or agent, objective, then the first eight
      // characters of the identifier for uniqueness. The directory,
      // for its part, remains `.caesar/wt/<taskId>` — it is the store key.
      expect(outcome.record.branch).toBe(`caesar/fake-agent/write-${outcome.record.id.replace("t_", "").slice(0, 8)}`);
      expect(outcome.record.workspace).toBe(join(root, ".caesar", "wt", outcome.record.id));
      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.report.status).toBe("success");
      expect(outcome.report.findings).toEqual([]);
    });

    it("protects the worktree against gc before its running record is published", async () => {
      await initGitRepo(root);
      let releaseCreate!: () => void;
      let notifyCreate!: () => void;
      const createReached = new Promise<void>((resolvePromise) => {
        notifyCreate = resolvePromise;
      });
      const createReleased = new Promise<void>((resolvePromise) => {
        releaseCreate = resolvePromise;
      });
      const delayedStore: TaskStore = {
        create: async (record) => {
          notifyCreate();
          await createReleased;
          await store.create(record);
        },
        update: (id, patch) => store.update(id, patch),
        get: (id) => store.get(id),
        list: (filter) => store.list(filter),
      };

      const running = runTask(
        { store: delayedStore, root },
        {
          taskId: "t_concurrent_startup",
          agentId: "fake-agent",
          objective: "start during gc",
          mode: "write",
          isolation: "worktree",
          workspace: root,
        },
      );
      await createReached;

      await expect(
        runTask(
          { store, root },
          {
            taskId: "t_concurrent_startup",
            agentId: "fake-agent",
            objective: "concurrent startup with the same identifier",
            mode: "write",
            isolation: "worktree",
            workspace: root,
          },
        ),
      ).rejects.toThrow();

      const duringStartup = await garbageCollectWorktrees(root, { force: true });
      expect(duringStartup.entries).toEqual([
        expect.objectContaining({ id: "t_concurrent_startup", action: "kept", reason: "active", orphan: true }),
      ]);

      releaseCreate();
      const outcome = await running;
      expect(outcome.record.status).toBe("succeeded");

      const afterCompletion = await garbageCollectWorktrees(root);
      expect(afterCompletion.entries).toEqual([
        expect.objectContaining({ id: "t_concurrent_startup", action: "removed", reason: "clean", orphan: false }),
      ]);
    });

    it("write + workspace outside a git repository → inplace, with a degraded-isolation finding", async () => {
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "write", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.branch).toBeUndefined();
      expect(outcome.record.workspace).toBe(root);
      expect(outcome.report.findings).toEqual([expect.objectContaining({ severity: "low" })]);
    });

    it("read-only + native mode enforced by the CLI → inplace, with a diff observed via git status (C2 of the final review)", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-native-ro", objective: "read", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.workspace).toBe(root);
      // Before C2 of the final review, `outcome.diff` remained `undefined` in
      // "inplace" isolation — no reconciliation was ever attempted there,
      // which was precisely the gap "the git diff is the source of truth"
      // promised never to have. `diffWorkspaceStatus` (git status
      // before/after, `worktree.ts`) fills that gap as soon as a git
      // repository is available: here the agent wrote nothing, so the diff is
      // defined but empty.
      expect(outcome.diff).toBeDefined();
      expect(outcome.diff!.isEmpty).toBe(true);
      expect(outcome.record.changes_verified_by).toBe("git");
    });

    it("read-only + agent without a native mode → worktree forced", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "read", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.diff).toBeDefined();
      expect(outcome.diff!.isEmpty).toBe(true);
    });

    it("worktree explicitly requested outside a git repository: fails clearly rather than degrading silently", async () => {
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "worktree" },
        ),
      ).rejects.toThrow(/git repository/);
    });

    it("worktree requested on a repository without a commit: the error names the cause and the remedy, not HEAD", async () => {
      // Observed in practice on a freshly initialized repository: the command
      // failed with git's raw message, "Command failed: git worktree
      // add … HEAD / fatal: invalid reference: HEAD", which says neither why
      // nor what to do. `repoRoot` succeeds here — it really is a repository —,
      // only the starting point is missing.
      await initGitRepoWithoutCommit(root);
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "worktree" },
        ),
      ).rejects.toThrow(/no commits[\s\S]*first commit/);
    });

    it('write + "auto" on a repository without a commit → inplace, with a finding explaining the fallback', async () => {
      await initGitRepoWithoutCommit(root);
      const outcome = await runTask(
        { store, root, queue: createQueue(2) },
        { agentId: "fake-agent", objective: "write", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.branch).toBeUndefined();
      expect(outcome.report.findings).toEqual([
        expect.objectContaining({ severity: "low", detail: expect.stringMatching(/no commits/) }),
      ]);
    });

    it("read-only without a native mode on a repository without a commit → inplace, the finding saying the guarantee is missing and why", async () => {
      // Same treatment as the twin "workspace outside a git repository" case:
      // the worktree that `mustForceWorktree` normally imposes is out of
      // reach here, and the task proceeds without it. What matters then is
      // that the report carries a trace of the missing guarantee, and its
      // cause.
      await initGitRepoWithoutCommit(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "read", mode: "read-only", workspace: root },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.report.findings).toEqual([
        expect.objectContaining({ detail: expect.stringMatching(/no commits[\s\S]*first commit/) }),
      ]);
    });
  });

  /**
   * The workshop, end to end: the worktree git creates only carries the
   * tracked files, and that is what made isolation unusable on a real
   * project — hence bypassed. These tests verify that a sub-agent finds
   * there what it needs, and that what the orchestrator placed there shows
   * up neither in the diff, nor in `caesar apply`.
   */
  describe("the workshop ([worktree])", () => {
    async function seedIgnored(): Promise<void> {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n", "utf8");
      await git(root, ["add", ".gitignore"]);
      await git(root, ["commit", "-q", "-m", "gitignore"]);
      await execFileAsync("mkdir", ["-p", join(root, "node_modules")]);
      await writeFile(join(root, "node_modules", "dep.js"), "module.exports = 1;\n", "utf8");
      await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
    }

    it("delivers the sub-agent a worktree containing its dependencies", async () => {
      await initGitRepo(root);
      await seedIgnored();

      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "work",
          mode: "write",
          workspace: root,
          worktreeSetup: { copy: ["node_modules", ".env"], link: [], setup: [] },
        },
      );

      expect(outcome.record.isolation).toBe("worktree");
      const workspace = outcome.record.workspace;
      expect(await readFile(join(workspace, "node_modules", "dep.js"), "utf8")).toBe("module.exports = 1;\n");
      expect(await readFile(join(workspace, ".env"), "utf8")).toBe("SECRET=1\n");
    });

    it("what the orchestrator placed does not show up as the agent's work", async () => {
      // Without exclusion, a copied `.env` would become applicable to the main
      // repository again via `caesar apply` — the orchestrator would blame the
      // agent for what it deposited itself.
      await initGitRepo(root);
      await seedIgnored();

      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "write a file",
          mode: "write",
          workspace: root,
          worktreeSetup: { copy: ["node_modules", ".env"], link: [], setup: [] },
          context: JSON.stringify({ files: [{ path: "real-work.txt", content: "from the agent" }] }),
        },
      );

      expect(outcome.record.excluded_paths).toEqual(["node_modules", ".env"]);
      const paths = outcome.diff!.files.map((f) => f.path);
      expect(paths).toContain("real-work.txt");
      expect(paths).not.toContain(".env");
      expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    });

    it("runs the setup commands in the worktree before the agent", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "work",
          mode: "write",
          workspace: root,
          worktreeSetup: { copy: [], link: [], setup: ["echo mounted > .preparation"] },
        },
      );

      expect((await readFile(join(outcome.record.workspace, ".preparation"), "utf8")).trim()).toBe("mounted");
    });

    it("a failing setup fails the task, with the output attached", async () => {
      // Better not to start than to open for the agent a half-mounted
      // workshop, where it would spend its budget repairing an installation.
      await initGitRepo(root);
      await expect(
        runTask(
          { store, root },
          {
            agentId: "fake-agent",
            objective: "work",
            mode: "write",
            workspace: root,
            worktreeSetup: { copy: [], link: [], setup: ["echo 'dependency not found' >&2; exit 1"] },
          },
        ),
      ).rejects.toThrow(/dependency not found[\s\S]*\[worktree\]/);
    });

    it("a declared path not ignored by git produces a finding naming the remedy", async () => {
      // The diagnostic that was missing the day of the workaround: without it,
      // an incomplete worktree only shows up as a task that fails for no
      // visible reason, and the natural reaction is to give up on isolation.
      await initGitRepo(root);
      await writeFile(join(root, "draft.txt"), "neither tracked nor ignored\n", "utf8");

      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "work",
          mode: "write",
          workspace: root,
          worktreeSetup: { copy: ["draft.txt"], link: [], setup: [] },
        },
      );

      expect(outcome.report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "low",
            title: "Path not materialized in the worktree",
            detail: expect.stringMatching(/\.gitignore/),
          }),
        ]),
      );
    });

    it("a linked path is flagged as not isolated", async () => {
      await initGitRepo(root);
      await seedIgnored();

      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "work",
          mode: "write",
          workspace: root,
          worktreeSetup: { copy: [], link: ["node_modules"], setup: [] },
        },
      );

      expect(outcome.report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "info",
            title: "Paths shared with the workspace",
            detail: expect.stringMatching(/NOT isolated[\s\S]*node_modules/),
          }),
        ]),
      );
    });

    it("flags — without refusing — that .caesar/wt/ is not ignored by git", async () => {
      // Step 0 of the `superpowers:using-git-worktrees` skill, adapted: a
      // finding, not a refusal. Verified rather than assumed, git does not
      // suck in the contents of a non-ignored worktree — it recognizes it as
      // a nested repository and adds only a gitlink. Failing a delegation
      // over a .gitignore line would cost more than what it protects.
      await initGitRepoWithoutIgnore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "work", mode: "write", workspace: root },
      );

      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "low",
            title: "Worktrees not ignored by git",
            detail: expect.stringMatching(/\.gitignore/),
          }),
        ]),
      );
    });

    it("without a [worktree] section, nothing changes: the worktree remains what git makes of it", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "work", mode: "write", workspace: root },
      );
      expect(outcome.record.isolation).toBe("worktree");
      expect(outcome.record.excluded_paths).toBeUndefined();
      expect(outcome.report.findings).toEqual([]);
    });
  });

  /**
   * The hardening this block guarantees: `prepareIsolation` is the only
   * point that all facades go through, including a direct call to
   * `runTask`. `resolveDelegation` renders the same verdict earlier, but
   * nothing forces a caller to go through it — these tests here are about the
   * safety net.
   */
  describe("in-place write: refused without opt-in", () => {
    it('refuses "inplace" + write in a usable repository, naming the remedy', async () => {
      // The case observed in production: three `implementer` tasks delegated
      // with `isolation: "inplace"` wrote onto the user's working branch,
      // without anything saying so.
      await initGitRepo(root);
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "inplace" },
        ),
      ).rejects.toThrow(/refused[\s\S]*allow_inplace_write/);
    });

    it("lets it through under a caller-carried opt-in", async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "write",
          mode: "write",
          workspace: root,
          isolation: "inplace",
          allowInplaceWrite: true,
        },
      );
      expect(outcome.record.isolation).toBe("inplace");
    });

    it("does not refuse outside a usable repository: an unversioned project remains accessible", async () => {
      // Without a repository, no worktree can be created: refusing would offer
      // no way out and would put `caesar` out of service where it used to work.
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "inplace" },
      );
      expect(outcome.record.isolation).toBe("inplace");
    });

    it('does not refuse read-only: that belongs to "mustForceWorktree", which contains instead of forbidding', async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "read", mode: "read-only", workspace: root, isolation: "inplace" },
      );
      // Forced to worktree by `mustForceWorktree`, not refused.
      expect(outcome.record.isolation).toBe("worktree");
    });

    it('does not refuse "auto": the resolution already picks the worktree for writes', async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "auto" },
      );
      expect(outcome.record.isolation).toBe("worktree");
    });

    it("two simultaneous in-place writes: the second fails naming the occupant", async () => {
      // Under opt-in, two tasks share the same tree —
      // `diffWorkspaceStatus` compares the git state before/after and would
      // then attribute each one's modifications to the other. The
      // reconciliation, which is the whole value of the system, would become
      // wrong without flagging anything.
      await initGitRepo(root);
      const common = {
        agentId: "fake-agent",
        mode: "write" as const,
        isolation: "inplace" as const,
        allowInplaceWrite: true,
        workspace: root,
      };

      const first = runTask(
        { store, root },
        { ...common, objective: "first", context: JSON.stringify({ mode: "hang", sleepMs: 700 }) },
      );
      // Lets the first take the lock before launching the second.
      await new Promise((r) => setTimeout(r, 150));
      await expect(
        runTask({ store, root }, { ...common, objective: "second" }),
      ).rejects.toThrow(/already writing there[\s\S]*worktree/);

      await first;
    }, 20_000);

    it("the lock is returned at the end: one in-place write can follow another", async () => {
      await initGitRepo(root);
      const common = {
        agentId: "fake-agent",
        mode: "write" as const,
        isolation: "inplace" as const,
        allowInplaceWrite: true,
        workspace: root,
      };

      await runTask({ store, root }, { ...common, objective: "first" });
      const second = await runTask({ store, root }, { ...common, objective: "second" });
      expect(second.record.status).toBe("succeeded");
    });

    it("does not lock when no worktree was possible: parallelism remains intact", async () => {
      // Outside a git repository, `inplace` is not a choice but the only
      // option. Locking would serialize every write delegation on an
      // unversioned project, without offering an alternative — and it is
      // precisely `caesar_delegate`'s parallelism promise that would pay the
      // price.
      const common = { agentId: "fake-agent", mode: "write" as const, workspace: root };
      const [a, b] = await Promise.all([
        runTask({ store, root }, { ...common, objective: "a" }),
        runTask({ store, root }, { ...common, objective: "b" }),
      ]);
      expect(a.record.isolation).toBe("inplace");
      expect(b.record.isolation).toBe("inplace");
    }, 20_000);

    it("refuses before creating anything: neither a worktree, nor a task directory", async () => {
      // A refusal that left behind a worktree or a ghost task would make
      // the repository pay the price of a negative decision.
      await initGitRepo(root);
      await expect(
        runTask(
          { store, root },
          { agentId: "fake-agent", objective: "write", mode: "write", workspace: root, isolation: "inplace" },
        ),
      ).rejects.toThrow();

      const { stdout } = await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"]);
      expect(stdout).not.toContain(".caesar/wt");
      expect(await store.list()).toHaveLength(0);
    });
  });

  it("a read-only task whose agent writes produces a high-severity finding, naming the file", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "read-only that is not one",
        mode: "read-only",
        workspace: root,
        context: JSON.stringify({ files: [{ path: "sneaky.txt", content: "I should not have written this" }] }),
      },
    );

    expect(outcome.diff!.isEmpty).toBe(false);
    const high = outcome.report.findings.filter((f) => f.severity === "high");
    expect(high).toHaveLength(1);
    expect(high[0]!.detail).toContain("sneaky.txt");
  });

  /**
   * The four seam tests requested by the final review: they would have
   * caught C1 through C4 before merge. C1 (an agent declared via `[[agent]]`
   * runs end to end through `caesar run`) lives in `packages/cli/src/commands/run.test.ts`,
   * the only level where the CLI/`.caesar/config.toml` makes sense; the other
   * three are here, at the level of the engine they exercise directly.
   */
  describe("seam tests — final review", () => {
    it('C2: report.changes differs from the real git diff ⇒ a finding appears, also in "inplace" isolation (not just "worktree")', async () => {
      // The "worktree" counterpart of this test already exists further down
      // ("reconciles a lying declaration with the real diff end to
      // end"): before C2 of the final review, no reconciliation was
      // ever attempted in "inplace" isolation — `report.changes` remained the
      // agent's raw declaration there, with no finding flagging a lie in
      // either direction.
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent",
          objective: "agent lying about its changes, inplace",
          mode: "write",
          isolation: "inplace",
          // `inplace` + write in a usable repository is now refused by
          // default (`decideInplaceWrite`): this test is about diff
          // reconciliation, not the isolation rule, so it assumes the
          // opt-in the way a user who set
          // `allow_inplace_write = true` would.
          allowInplaceWrite: true,
          workspace: root,
          context: JSON.stringify({
            files: [{ path: "real.txt", content: "actually written" }],
            declaredChanges: [{ path: "invented.txt", action: "modified", summary: "does not exist" }],
          }),
        },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.changes_verified_by).toBe("git");
      expect(outcome.report.changes).toEqual([{ path: "real.txt", action: "created", summary: "" }]);
      const files = outcome.report.findings.map((f) => f.file).sort();
      expect(files).toEqual(["invented.txt", "real.txt"]);
    });

    it('C3: a read-only agent that writes is detected even if "inplace" is explicitly requested (isolation forced to "worktree")', async () => {
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent", // capabilities.nativeReadOnly === false
          objective: "read-only, inplace explicitly requested regardless",
          mode: "read-only",
          isolation: "inplace", // before C3, this explicit value silently undid the constraint.
          workspace: root,
          context: JSON.stringify({ files: [{ path: "sneaky2.txt", content: "still not supposed to write" }] }),
        },
      );

      // The constraint wins over the explicit request: isolation genuinely forced to "worktree".
      expect(outcome.record.isolation).toBe("worktree");
      const high = outcome.report.findings.filter((f) => f.severity === "high");
      expect(high).toHaveLength(1);
      expect(high[0]!.detail).toContain("sneaky2.txt");
      // The contradicted bypass is flagged, not merely absorbed in silence.
      expect(outcome.report.findings.some((f) => f.title === "Degraded isolation")).toBe(true);
    });

    it('C3: a natively read-only agent that writes anyway is detected in genuine "inplace" isolation (never forced to "worktree")', async () => {
      // The hardest case of "whatever isolation is requested": here
      // isolation genuinely remains "inplace" (natively read-only
      // agent, `mustForceWorktree` does not apply) — detection must
      // therefore come from the before/after `git status` reconciliation (C2),
      // never from a worktree.
      await initGitRepo(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "fake-agent-native-ro", // capabilities.nativeReadOnly === true
          objective: "native read-only lying about its promise",
          mode: "read-only",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "sneaky3.txt", content: "the CLI has a bug" }] }),
        },
      );

      expect(outcome.record.isolation).toBe("inplace");
      expect(outcome.record.changes_verified_by).toBe("git");
      const high = outcome.report.findings.filter((f) => f.severity === "high");
      expect(high).toHaveLength(1);
      expect(high[0]!.detail).toContain("sneaky3.txt");
    });

    it("C4: max_parallel = 1 (shared Queue, limit 1) ⇒ two delegations run in series, never simultaneously", async () => {
      const queue = createQueue(1);
      const concurrentRunningCounts: number[] = [];
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          const running = await store.list({ status: ["running"] });
          concurrentRunningCounts.push(running.filter((r) => r.pid !== undefined).length);
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 15));
        }
      })();

      const makeInput = (label: string) => ({
        agentId: "fake-agent",
        objective: `task ${label}`,
        mode: "write" as const,
        isolation: "inplace" as const,
        workspace: root,
        context: JSON.stringify({ sleepMs: 200 }),
      });

      const [a, b] = await Promise.all([
        runTask({ store, root, queue }, makeInput("a")),
        runTask({ store, root, queue }, makeInput("b")),
      ]);
      polling = false;
      await pollLoop;

      expect(a.record.status).toBe("succeeded");
      expect(b.record.status).toBe("succeeded");
      // Proof by state observation, not by stopwatch (same method as
      // `packages/mcp-server/src/tools/await.test.ts:79-98`): never more
      // than one "running" task with an active pid at a time, despite two
      // `runTask` calls launched in parallel with `Promise.all` — exactly the
      // guarantee `policy.max_parallel` must provide, and that
      // `RunnerDeps.queue` was until now wired nowhere (C4).
      expect(Math.max(...concurrentRunningCounts)).toBeLessThanOrEqual(1);
      // The test is only meaningful if it actually observed an active
      // task during execution: otherwise "never more than one" would be true
      // by default of observation, not by the guarantee under test.
      expect(concurrentRunningCounts.some((n) => n === 1)).toBe(true);
    });

    it("four simultaneous tasks each get their own worktree, without stepping on each other", async () => {
      // The C4 test above only covers `inplace` isolation: concurrent
      // worktree creation — `git worktree add` launched four times
      // at once on the same repository — was verified nowhere, even
      // though it is the normal use case of the MCP server (max_parallel = 4
      // by default, all delegations sharing a single queue).
      await initGitRepo(root);
      const queue = createQueue(4);

      const outcomes = await Promise.all(
        ["a", "b", "c", "d"].map((label) =>
          runTask(
            { store, root, queue },
            {
              agentId: "fake-agent",
              objective: `task ${label}`,
              mode: "write" as const,
              isolation: "worktree" as const,
              workspace: root,
              context: JSON.stringify({ sleepMs: 120 }),
            },
          ),
        ),
      );

      for (const outcome of outcomes) expect(outcome.record.status).toBe("succeeded");

      // Each task has its own directory and its own branch: the identifier
      // comes from a UUID (`generateTaskId`), so no collision is possible —
      // but it was the concurrent git command that needed exercising.
      const workspaces = outcomes.map((o) => o.record.workspace);
      expect(new Set(workspaces).size).toBe(4);
      for (const workspace of workspaces) expect(workspace).toContain(join(".caesar", "wt"));

      const { stdout } = await execFileAsync("git", ["branch", "--list", "caesar/*"], { cwd: root });
      expect(stdout.split("\n").filter((line) => line.trim() !== "")).toHaveLength(4);
    }, 30_000);

    it("C4 (control): without a shared limit, the same two delegations do run simultaneously — the limit-1 Queue above is thus indeed what serializes", async () => {
      const concurrentRunningCounts: number[] = [];
      let polling = true;
      const pollLoop = (async () => {
        while (polling) {
          const running = await store.list({ status: ["running"] });
          concurrentRunningCounts.push(running.filter((r) => r.pid !== undefined).length);
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 15));
        }
      })();

      const makeInput = (label: string) => ({
        agentId: "fake-agent",
        objective: `control task ${label}`,
        mode: "write" as const,
        isolation: "inplace" as const,
        workspace: root,
        context: JSON.stringify({ sleepMs: 200 }),
      });

      // No shared Queue (`{ store, root, queue: undefined }`): the two
      // delegations are throttled by nothing.
      await Promise.all([
        runTask({ store, root, queue: undefined }, makeInput("a")),
        runTask({ store, root, queue: undefined }, makeInput("b")),
      ]);
      polling = false;
      await pollLoop;

      expect(concurrentRunningCounts.some((n) => n === 2)).toBe(true);
    });
  });

  it("a task whose agent writes no report produces a synthesized report", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent ignoring the contract",
        mode: "write",
        workspace: root,
        context: JSON.stringify({ mode: "silent" }),
      },
    );

    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("succeeded");
    expect(outcome.report.status).toBe("success");
  });

  it("an agent capable of finalMessageFile is wired end to end: the runner points it at the file, it uses it", async () => {
    await initGitRepo(root);
    const embedded = {
      protocol: REPORT_PROTOCOL,
      task_id: "does not matter, resolveReport does not trust it",
      status: "success",
      summary: "dropped by the CLI into final-message.txt, never into report.json",
      changes: [],
    };
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent-final-message",
        objective: "agent reporting via final message file",
        mode: "write",
        workspace: root,
        // "silent": no report.json written, to prove the report
        // really comes from final-message.txt and nothing else.
        context: JSON.stringify({ mode: "silent", finalMessage: JSON.stringify(embedded) }),
      },
    );

    expect(outcome.source).toBe("extracted");
    expect(outcome.report.summary).toBe("dropped by the CLI into final-message.txt, never into report.json");
  });

  it("records the sub-process pid during execution then clears it at the end", async () => {
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "checks the pid lifecycle",
        mode: "write",
        workspace: root,
        isolation: "inplace",
        timeoutMs: 300,
        context: JSON.stringify({ mode: "hang", sleepMs: 5000 }),
      },
    );

    // Waits for the pid to appear in the store, while the task is still running.
    let seenPid: number | undefined;
    for (let i = 0; i < 100 && seenPid === undefined; i++) {
      const records = await store.list({ status: ["running"] });
      seenPid = records[0]?.pid;
      if (seenPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seenPid).toBeGreaterThan(0);

    const outcome = await runPromise;
    expect(outcome.record.pid).toBeUndefined();
  });

  it("caller-provided taskId: used as-is, without generating another", async () => {
    const outcome = await runTask(
      { store, root },
      { agentId: "fake-agent", objective: "imposed identifier", mode: "write", workspace: root, taskId: "t_imposed" },
    );

    expect(outcome.record.id).toBe("t_imposed");
    expect(outcome.record.task_dir).toBe(join(root, ".caesar", "tasks", "t_imposed"));
    expect(await store.get("t_imposed")).not.toBeNull();
  });

  it("a signal already triggered at entry does not even engage isolation: no worktree created, status cancelled", async () => {
    await initGitRepo(root);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "signal already aborted before launch",
        // write + git repository: the "auto" isolation rule would normally
        // have created a worktree. The guard must step in before that happens.
        mode: "write",
        workspace: root,
        signal: controller.signal,
      },
    );

    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.branch).toBeUndefined();
    expect(outcome.diff).toBeUndefined();
    expect(outcome.report.status).toBe("failed");
    await expect(access(join(root, ".caesar", "wt"))).rejects.toThrow();
  });

  it("onEvent receives the events as they stream, before runTask resolves", async () => {
    const seenBeforeResolution: string[] = [];
    let resolved = false;

    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "live events",
        mode: "write",
        workspace: root,
        onEvent: (event) => seenBeforeResolution.push(event.type),
      },
    ).then((outcome) => {
      resolved = true;
      return outcome;
    });

    // The first event ("started") must be observable before `runTask` has
    // even finished resolving — that is what distinguishes a live stream
    // from an after-the-fact replay.
    for (let i = 0; i < 100 && seenBeforeResolution.length === 0; i++) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
    }
    expect(seenBeforeResolution).toContain("started");
    expect(resolved).toBe(false);

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("succeeded");
    expect(seenBeforeResolution).toContain("finished");
  });

  it("an AbortSignal cancelled during execution interrupts the task without leaving a child process", async () => {
    const controller = new AbortController();
    const runPromise = runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "task interrupted via AbortSignal",
        mode: "write",
        workspace: root,
        signal: controller.signal,
        context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
      },
    );

    // Lets the sub-process actually start before cancelling.
    for (let i = 0; i < 100; i++) {
      const [record] = await store.list({ status: ["running"] });
      if (record?.pid !== undefined) break;
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
    }
    controller.abort();

    const outcome = await runPromise;
    expect(outcome.record.status).toBe("cancelled");
    expect(outcome.record.pid).toBeUndefined();
  });

  it("reconciles a lying declaration with the real diff end to end", async () => {
    await initGitRepo(root);
    const outcome = await runTask(
      { store, root },
      {
        agentId: "fake-agent",
        objective: "agent lying about its changes",
        mode: "write",
        workspace: root,
        context: JSON.stringify({
          files: [{ path: "real.txt", content: "actually written" }],
          declaredChanges: [{ path: "invented.txt", action: "modified", summary: "does not exist" }],
        }),
      },
    );

    expect(outcome.source).toBe("file");
    expect(outcome.report.changes).toEqual([{ path: "real.txt", action: "created", summary: "" }]);
    const files = outcome.report.findings.map((f) => f.file).sort();
    expect(files).toEqual(["invented.txt", "real.txt"]);
  });

  describe("return channel (task 9)", () => {
    it('channel: true + agent that can load an MCP server: task.channel is built, the report tier becomes "channel"', async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-channel", objective: "with channel", mode: "write", workspace: root, channel: true },
      );

      expect(outcome.record.report_via).toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toEqual({
        transport: "mcp-stdio",
        command: process.execPath,
        args: [expect.stringMatching(/bin\.js$/), outcome.record.task_dir],
        server_name: "caesar",
      });
    });

    it("channel absent (default): task.channel remains empty even for an agent that would support it", async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent-channel", objective: "no channel requested", mode: "write", workspace: root },
      );

      expect(outcome.record.report_via).not.toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toBeFalsy();
    });

    it("degradation: channel: true for an agent without mcpInjection is silently ignored, the task still completes", async () => {
      const outcome = await runTask(
        { store, root },
        { agentId: "fake-agent", objective: "channel requested but unsupported", mode: "write", workspace: root, channel: true },
      );

      expect(outcome.record.status).toBe("succeeded");
      expect(outcome.record.report_via).not.toBe("channel");
      const task = await readTask(taskPaths(outcome.record.task_dir));
      expect(task.channel).toBeFalsy();
    });

    it("degradation: a failed resolution of the channel binary does not keep the task from completing, via a lower tier", async () => {
      // A case distinct from the two previous ones: here, the agent does
      // support mcpInjection and the channel is indeed requested — it is its
      // very construction (`buildChannel`/`resolveChannelEntry`, `runner.ts`)
      // that fails (broken installation, simulated via the `node:module` mock
      // above), genuinely exercising the `catch` branch rather than a
      // neighboring case where the agent ignores a channel otherwise built
      // successfully.
      channelResolutionFailure.active = true;
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "broken binary resolution", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.record.report_via).not.toBe("channel");
        expect(outcome.source).not.toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toBeFalsy();
      } finally {
        channelResolutionFailure.active = false;
      }
    });

    it("configureChannelLauncher (task 12): a custom launcher replaces the default resolution", async () => {
      // Exercises the extension point through the real facade (`runTask`),
      // not by calling an internal function directly — see the task 12
      // report: a test that bypassed `configureChannelLauncher`
      // to build `task.channel` by hand would protect nothing of what
      // `bun-entry.ts` actually does in production.
      configureChannelLauncher((taskDir): Channel => ({
        transport: "mcp-stdio",
        command: "caesar",
        args: ["channel", "serve", "--task-dir", taskDir],
        server_name: "caesar",
      }));
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "custom launcher", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.report_via).toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toEqual({
          transport: "mcp-stdio",
          command: "caesar",
          args: ["channel", "serve", "--task-dir", outcome.record.task_dir],
          server_name: "caesar",
        });
      } finally {
        configureChannelLauncher(defaultChannelLauncher);
      }
    });

    it("configureChannelLauncher (task 12): a custom launcher that throws degrades without failing the task", async () => {
      // Same guarantee as for `resolveChannelEntry` (previous test), but on
      // the injected-launcher side: the brief demands it explicitly ("the
      // guarantee […] must hold in both worlds"), hence in both possible
      // failure sources, not just the default resolution.
      configureChannelLauncher(() => {
        throw new Error("broken custom launcher, simulated for this test");
      });
      try {
        const outcome = await runTask(
          { store, root },
          { agentId: "fake-agent-channel", objective: "broken custom launcher", mode: "write", workspace: root, channel: true },
        );

        expect(outcome.record.status).toBe("succeeded");
        expect(outcome.record.report_via).not.toBe("channel");
        expect(outcome.source).not.toBe("channel");
        const task = await readTask(taskPaths(outcome.record.task_dir));
        expect(task.channel).toBeFalsy();
      } finally {
        configureChannelLauncher(defaultChannelLauncher);
      }
    });
  });
});
