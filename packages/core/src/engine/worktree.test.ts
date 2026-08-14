import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_PROTOCOL, TaskSchema, taskPaths, writeTask } from "@caesar/protocol";
import type { Task } from "@caesar/protocol";
import { fileTaskStore } from "../store.js";
import type { TaskRecord } from "../store.js";
import {
  applyRecordedWorktree,
  createWorktree,
  describeWorkspaceMismatch,
  diffWorktree,
  listGitWorktrees,
  loadWorktreeHandle,
  patchDigest,
  removeWorktree,
  repoRoot,
  worktreesDirIgnored,
} from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "caesar-test@example.com"]);
  await git(root, ["config", "user.name", "Caesar Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

describe("worktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-worktree-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("repoRoot", () => {
    it("resolves the root of a git repository", async () => {
      const resolved = await repoRoot(root);
      // macOS resolves /tmp to /private/tmp: we compare the real paths.
      expect(resolved).toBe(await realpath(root));
    });

    it("returns null outside a git repository", async () => {
      const outside = await mkdtemp(join(tmpdir(), "caesar-not-a-repo-"));
      try {
        expect(await repoRoot(outside)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("createWorktree / diffWorktree", () => {
    it("creates the worktree under <root>/.caesar/wt/<taskId> on the caesar/<taskId> branch", async () => {
      const handle = await createWorktree(root, "task-1");
      expect(handle.path).toBe(join(root, ".caesar", "wt", "task-1"));
      expect(handle.branch).toBe("caesar/task-1");
      // A SHA, never the "HEAD" string: that is what makes the diff immune
      // to the commits the agent makes in its workshop.
      expect(handle.baseRef).toMatch(/^[0-9a-f]{40}$/);
      expect(handle.baseRef).toBe((await git(root, ["rev-parse", "HEAD"])).trim());

      const content = await readFile(join(handle.path, "a.txt"), "utf8");
      expect(content).toBe("hello\n");

      const branches = await git(root, ["branch", "--list", "caesar/task-1"]);
      expect(branches).toContain("caesar/task-1");
    });

    it("sees a file created without a commit, thanks to --intent-to-add", async () => {
      const handle = await createWorktree(root, "task-2");
      await writeFile(join(handle.path, "new.txt"), "content\n", "utf8");
      await writeFile(join(handle.path, "a.txt"), "hello\nmodified\n", "utf8");

      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(false);
      expect(diff.files).toEqual(
        expect.arrayContaining([
          { path: "new.txt", action: "created", summary: "" },
          { path: "a.txt", action: "modified", summary: "" },
        ]),
      );
      expect(diff.patch).toContain("new.txt");
      expect(diff.patch).toContain("+content");
    });

    it("empty diff when the worktree underwent no change", async () => {
      const handle = await createWorktree(root, "task-3");
      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(true);
      expect(diff.files).toEqual([]);
      expect(diff.patch).toBe("");
    });

    it("reports a deletion as such", async () => {
      const handle = await createWorktree(root, "task-4");
      await rm(join(handle.path, "a.txt"));
      const diff = await diffWorktree(handle);
      expect(diff.files).toEqual([{ path: "a.txt", action: "deleted", summary: "" }]);
    });

    /**
     * The workshop lifts the hypothesis under which this module was written —
     * "agents do not commit". A sub-agent that installs, runs the tests
     * and punctuates its work with commits is exactly what the worktree
     * must allow; the diff must survive it.
     */
    describe("an agent that commits in its workshop", () => {
      async function commitAll(dir: string, message: string): Promise<void> {
        await git(dir, ["config", "user.email", "agent@example.com"]);
        await git(dir, ["config", "user.name", "Sub-agent"]);
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-q", "-m", message]);
      }

      it("sees its work in the diff, exactly as if it had not committed", async () => {
        // Diffed against `HEAD`, this diff would be empty: `HEAD` would
        // designate the agent's own commit. `caesar` would have concluded "no
        // changes", `caesar apply` would have applied nothing, and all the
        // work would have evaporated in silence.
        const handle = await createWorktree(root, "task-commit");
        await writeFile(join(handle.path, "new.txt"), "content\n", "utf8");
        await writeFile(join(handle.path, "a.txt"), "hello\nmodified\n", "utf8");
        await commitAll(handle.path, "the agent's work");

        const diff = await diffWorktree(handle);
        expect(diff.isEmpty).toBe(false);
        expect(diff.files).toEqual(
          expect.arrayContaining([
            { path: "new.txt", action: "created", summary: "" },
            { path: "a.txt", action: "modified", summary: "" },
          ]),
        );
        expect(diff.patch).toContain("+content");
      });

      it("accumulates several commits into a single diff against the starting point", async () => {
        const handle = await createWorktree(root, "task-commits");
        await writeFile(join(handle.path, "one.txt"), "1\n", "utf8");
        await commitAll(handle.path, "first milestone");
        await writeFile(join(handle.path, "two.txt"), "2\n", "utf8");
        await commitAll(handle.path, "second milestone");

        const diff = await diffWorktree(handle);
        expect(diff.files.map((f) => f.path).sort()).toEqual(["one.txt", "two.txt"]);
      });

      it("mixes a commit and uncommitted work in the same diff", async () => {
        // The real end-of-task case: a few commits, then modifications
        // still in the working tree. The two mechanisms —
        // the starting SHA and `--intent-to-add` — must play together.
        const handle = await createWorktree(root, "task-mixed");
        await writeFile(join(handle.path, "committed.txt"), "committed\n", "utf8");
        await commitAll(handle.path, "milestone");
        await writeFile(join(handle.path, "in-progress.txt"), "not yet\n", "utf8");

        const diff = await diffWorktree(handle);
        expect(diff.files.map((f) => f.path).sort()).toEqual(["committed.txt", "in-progress.txt"]);
      });
    });
  });

  describe("removeWorktree", () => {
    it("removes the worktree and its branch", async () => {
      const handle = await createWorktree(root, "task-remove");
      await removeWorktree(root, handle);

      const worktrees = await git(root, ["worktree", "list"]);
      expect(worktrees).not.toContain("task-remove");

      const branches = await git(root, ["branch", "--list", "caesar/task-remove"]);
      expect(branches.trim()).toBe("");
    });

    /**
     * The guarantee `[worktree] link` rests on: the link's target lives
     * in the main repository, and its survival must not be an assumption.
     * These two tests observe it rather than presume it — they would fail
     * the day `git worktree remove --force` started following links,
     * which would make link materialization indefensible as it stands.
     */
    it("a link to the main repository is detached, never followed: its target survives", async () => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "marker.txt"), "precious\n", "utf8");

      const handle = await createWorktree(root, "task-link");
      await symlink(join(root, "node_modules"), join(handle.path, "node_modules"), "dir");
      await removeWorktree(root, handle);

      expect(await readFile(join(root, "node_modules", "marker.txt"), "utf8")).toBe("precious\n");
      const worktrees = await git(root, ["worktree", "list"]);
      expect(worktrees).not.toContain("task-link");
    });

    it("including for a link placed under a nested path", async () => {
      // `[worktree] link` accepts `packages/api/node_modules`: the guarantee
      // is worthless if it stops at the worktree root.
      await mkdir(join(root, "target"), { recursive: true });
      await writeFile(join(root, "target", "inside.txt"), "intact\n", "utf8");

      const handle = await createWorktree(root, "task-nested");
      await mkdir(join(handle.path, "packages", "api"), { recursive: true });
      await symlink(join(root, "target"), join(handle.path, "packages", "api", "node_modules"), "dir");
      await removeWorktree(root, handle);

      expect(await readFile(join(root, "target", "inside.txt"), "utf8")).toBe("intact\n");
    });
  });

  describe("loadWorktreeHandle", () => {
    function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
      return {
        id: "task-handle",
        agent: "codex",
        objective: "task",
        status: "succeeded",
        created_at: new Date().toISOString(),
        task_dir: join(root, ".caesar", "tasks", "task-handle"),
        workspace: join(root, ".caesar", "wt", "task-handle"),
        isolation: "worktree",
        mode: "write",
        report_via: "file",
        depth: 0,
        branch: "caesar/task-handle",
        ...overrides,
      };
    }

    it('null when isolation is not "worktree"', async () => {
      const handle = await loadWorktreeHandle(record({ isolation: "inplace", branch: undefined }));
      expect(handle).toBeNull();
    });

    it('null when isolation is "worktree" but no branch is recorded', async () => {
      const handle = await loadWorktreeHandle(record({ branch: undefined }));
      expect(handle).toBeNull();
    });

    it("rebuilds the handle from task.json, base_ref included", async () => {
      const rec = record();
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "caesar.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        base_ref: "deadbeef",
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle).toEqual({ path: rec.workspace, branch: "caesar/task-handle", baseRef: "deadbeef" });
    });

    it('base_ref absent from task.json: falls back to "HEAD"', async () => {
      const rec = record({ id: "task-handle-2", task_dir: join(root, ".caesar", "tasks", "task-handle-2") });
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "caesar.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle?.baseRef).toBe("HEAD");
    });
  });
});

/**
 * Step 0 of the `superpowers:using-git-worktrees` skill, which this project
 * assumed settled: detect before creating. Two blind spots that `caesar`
 * had nowhere — the state of the `.gitignore`, and the gap between the root
 * it delegates on and the one where the work happens.
 */
describe("step 0 — detect before creating", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "caesar-step0-")));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("worktreesDirIgnored", () => {
    it("false when nothing ignores .caesar/wt/", async () => {
      expect(await worktreesDirIgnored(root, "t_1")).toBe(false);
    });

    it("true with the line caesar init writes — pattern ending with a slash", async () => {
      // The case that demanded rephrasing the question: a directory
      // pattern only applies to `.caesar/wt` on the condition that this
      // directory already exists. Querying the path we are about to occupy
      // (`.caesar/wt/<taskId>`) answers in every case.
      await writeFile(join(root, ".gitignore"), ".caesar/wt/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(true);
    });

    it("true also when all of .caesar/ is ignored", async () => {
      await writeFile(join(root, ".gitignore"), ".caesar/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(true);
    });

    it("false when the .gitignore talks about something else", async () => {
      await writeFile(join(root, ".gitignore"), "node_modules/\n.caesar/tasks/\n", "utf8");
      expect(await worktreesDirIgnored(root, "t_1")).toBe(false);
    });
  });

  describe("listGitWorktrees", () => {
    it("returns the main repository then each worktree, with its branch", async () => {
      const handle = await createWorktree(root, "t_list");
      const entries = await listGitWorktrees(root);

      expect(entries[0]!.path).toBe(root);
      const found = entries.find((entry) => entry.path === handle.path);
      // The branch comes from git, never from a deduction on the directory
      // name: that is what lets the gc clean up a branch whose name cannot
      // be guessed.
      expect(found!.branch).toBe("caesar/t_list");
    });

    it("returns an empty list outside a git repository, rather than throwing", async () => {
      const outside = await mkdtemp(join(tmpdir(), "caesar-not-a-repo-"));
      try {
        expect(await listGitWorktrees(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("describeWorkspaceMismatch", () => {
    it("silent when the two roots coincide", async () => {
      expect(await describeWorkspaceMismatch(root, root)).toBeNull();
    });

    it("silent when the current directory is not inside a repository", async () => {
      // The MCP server's current directory is not proof of intent:
      // outside a repository, there is no reason to believe it designates a
      // place of work.
      const outside = await mkdtemp(join(tmpdir(), "caesar-outside-repo-"));
      try {
        expect(await describeWorkspaceMismatch(root, outside)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("flags the Superpowers case: we work in a worktree, caesar delegates on the original repository", async () => {
      // `caesar mcp install` freezes `--root` once and for all. Let the main
      // agent move into a worktree — which the skill recommends — and
      // the sub-agents work in a tree nobody is looking at anymore.
      const handle = await createWorktree(root, "t_elsewhere");
      const message = await describeWorkspaceMismatch(root, handle.path);
      expect(message).toContain(root);
      expect(message).toContain("caesar mcp install");
    });
  });
});

describe("applyRecordedWorktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-apply-record-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A recorded worktree task, with the task.json that loadWorktreeHandle will re-read. */
  async function recordedTask(id: string): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "apply and record",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      ended_at: "2026-08-12T09:01:00.000Z",
      task_dir: join(root, ".caesar", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    const paths = taskPaths(record.task_dir);
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: handle.path,
      base_ref: handle.baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    return record;
  }

  it("applies the patch and writes applied_at + digest into the record", async () => {
    const record = await recordedTask("t_recorded");
    await writeFile(join(record.workspace, "b.txt"), "work\n", "utf8");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: false });
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("work\n");
    const reread = await fileTaskStore(root).get(record.id);
    expect(reread?.applied_at).toBeDefined();
    const handle = await loadWorktreeHandle(reread!);
    expect(reread?.applied_patch_digest).toBe(patchDigest((await diffWorktree(handle!)).patch));
  });

  it("empty diff: outcome applied but nothing applied, nothing recorded", async () => {
    const record = await recordedTask("t_empty");

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "applied", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("conflict: files named, nothing recorded", async () => {
    const record = await recordedTask("t_conflict");
    await writeFile(join(record.workspace, "a.txt"), "worktree version\n", "utf8");
    await writeFile(join(root, "a.txt"), "diverging workspace version\n", "utf8");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-q", "-m", "divergence"]);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result.outcome).toBe("conflicts");
    expect(result.conflicts).toContain("a.txt");
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });

  it("task without a worktree (inplace): no_worktree, nothing recorded", async () => {
    const record: TaskRecord = {
      id: "t_inplace",
      agent: "codex",
      objective: "in-place task",
      status: "succeeded",
      created_at: "2026-08-12T09:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", "t_inplace"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);

    const result = await applyRecordedWorktree(root, fileTaskStore(root), record);

    expect(result).toEqual({ outcome: "no_worktree", conflicts: [], isEmpty: true });
    expect((await fileTaskStore(root).get(record.id))?.applied_at).toBeUndefined();
  });
});
