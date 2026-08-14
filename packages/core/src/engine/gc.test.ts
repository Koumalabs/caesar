import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPORT_PROTOCOL, TASK_PROTOCOL, TaskSchema, readReport, taskPaths, writeReport, writeTask } from "@caesar/protocol";
import type { TaskRecord, TaskStatus } from "../store.js";
import { fileTaskStore } from "../store.js";
import { applyRecordedWorktree, createWorktree } from "./worktree.js";
import {
  clearWorktreeInUse,
  detectAbandonedTasks,
  garbageCollectWorktrees,
  markWorktreeInUse,
  sweepAbandonedTasks,
} from "./gc.js";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Beyond any value `kill(pid, 0)` could find alive, on macOS as on Linux:
 * the marker carrying it is stale by construction, without having to kill a
 * real process or bet on a pid not being reassigned.
 */
const DEAD_PID = 2_147_483_647;

/** The marker a killed orchestrator leaves behind. Returns its path. */
async function staleMarker(root: string, id: string): Promise<string> {
  const lease = await markWorktreeInUse(root, id);
  await writeFile(lease.path, JSON.stringify({ pid: DEAD_PID, token: lease.token }) + "\n", "utf8");
  return lease.path;
}

describe("garbageCollectWorktrees", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-gc-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createRecordedWorktree(id: string, status: TaskStatus): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "exercise the garbage collector",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      ended_at: status === "pending" || status === "running" ? undefined : "2026-08-11T10:01:00.000Z",
      task_dir: join(root, ".caesar", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    return record;
  }

  /** A finished task whose work was applied through the official path. */
  async function appliedRecordedWorktree(id: string): Promise<TaskRecord> {
    const record = await createRecordedWorktree(id, "succeeded");
    await writeFile(join(record.workspace, `${id}.txt`), "work\n", "utf8");
    const paths = taskPaths(record.task_dir);
    const baseRef = (await git(record.workspace, ["rev-parse", "HEAD"])).trim();
    await writeTask(paths, TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id,
      created_at: record.created_at,
      agent: record.agent,
      objective: record.objective,
      mode: "write",
      isolation: "worktree",
      workspace: record.workspace,
      base_ref: baseRef,
      deadline_ms: 60_000,
      report_path: paths.reportPath,
      events_path: paths.eventsPath,
    }));
    const applied = await applyRecordedWorktree(root, fileTaskStore(root), record);
    expect(applied.outcome).toBe("applied");
    expect(applied.isEmpty).toBe(false);
    return (await fileTaskStore(root).get(id))!;
  }

  it("removes the worktree of an applied task where nothing has moved since", async () => {
    const record = await appliedRecordedWorktree("t_applied");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "applied", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("--dry-run announces the collection of an applied task without removing or rewriting", async () => {
    const record = await appliedRecordedWorktree("t_applied_dry");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "would_remove", reason: "applied" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect((await fileTaskStore(root).get(record.id))?.applied_patch_digest).toBe(record.applied_patch_digest);
  });

  it("keeps a worktree modified since its apply, applied_at exposed", async () => {
    const record = await appliedRecordedWorktree("t_reworked");
    await writeFile(join(record.workspace, "t_reworked.txt"), "touch-up after the apply\n", "utf8");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", applied_at: record.applied_at }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });

  it("verification impossible (task.json gone): kept, never removed on a doubt", async () => {
    const record = await appliedRecordedWorktree("t_no_task_json");
    await rm(taskPaths(record.task_dir).taskFile, { force: true });

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
  });

  it("--dry-run announces a clean finished worktree without removing the worktree or the branch", async () => {
    const record = await createRecordedWorktree("t_clean", "succeeded");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: record.id,
        action: "would_remove",
        reason: "clean",
        orphan: false,
        status: "succeeded",
      }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("removes the clean finished worktree and its branch", async () => {
    const record = await createRecordedWorktree("t_removed", "failed");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "clean", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["worktree", "list"]))).not.toContain(record.id);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("keeps a modified finished worktree, then removes it with --force", async () => {
    const record = await createRecordedWorktree("t_modified", "cancelled");
    await writeFile(join(record.workspace, "work.txt"), "important\n", "utf8");
    const statusBefore = await git(record.workspace, ["status", "--porcelain"]);

    const kept = await garbageCollectWorktrees(root);

    expect(kept.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(record.workspace, ["status", "--porcelain"])).toBe(statusBefore);

    const removed = await garbageCollectWorktrees(root, { force: true });
    expect(removed.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
  });

  it.each(["pending", "running"] as const)("never removes a %s task, even with --force", async (status) => {
    const record = await createRecordedWorktree(`t_${status}`, status);
    await writeFile(join(record.workspace, "in-progress.txt"), "writing\n", "utf8");

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "active", status }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("detects and removes an orphan worktree absent from the store", async () => {
    const handle = await createWorktree(root, "t_orphan");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "t_orphan",
        action: "removed",
        reason: "clean",
        orphan: true,
        status: undefined,
      }),
    ]);
    expect(await pathExists(handle.path)).toBe(false);
    expect((await git(root, ["branch", "--list", handle.branch])).trim()).toBe("");
  });

  /**
   * The garbage-collector counterpart of the guarantee established in
   * `worktree.test.ts`: this is the most exposed path — automatic,
   * unsupervised cleanup of a worktree where nothing remains to say which
   * paths had been linked (`[worktree] link`) — and the one that must be
   * least able to destroy the main repository's `node_modules`.
   */
  it("a worktree containing a link to the main repository is cleaned up without destroying its target", async () => {
    const { mkdir, readFile, symlink } = await import("node:fs/promises");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "marker.txt"), "precious\n", "utf8");

    const handle = await createWorktree(root, "t_link");
    await symlink(join(root, "node_modules"), join(handle.path, "node_modules"), "dir");

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([expect.objectContaining({ id: "t_link", action: "removed", orphan: true })]);
    expect(await pathExists(handle.path)).toBe(false);
    expect(await readFile(join(root, "node_modules", "marker.txt"), "utf8")).toBe("precious\n");
  });

  it("protects a worktree being created before it appears in the store", async () => {
    const lease = await markWorktreeInUse(root, "t_startup");
    const handle = await createWorktree(root, "t_startup");

    const protectedResult = await garbageCollectWorktrees(root, { force: true });

    expect(protectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_startup", action: "kept", reason: "active", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);

    await clearWorktreeInUse(lease);
    const collectedResult = await garbageCollectWorktrees(root);
    expect(collectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_startup", action: "removed", reason: "clean", orphan: true }),
    ]);
  });

  it("--dry-run does not purge a marker left by a dead process", async () => {
    const id = "t_stale_marker";
    const lease = await markWorktreeInUse(root, id);
    const marker = lease.path;
    await writeFile(marker, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "would_remove", reason: "clean", orphan: true }),
    ]);
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(handle.path)).toBe(true);
  });

  /**
   * The compound consequence, and the sweep's reason for existing: the
   * "running" status of a task whose orchestrator died protected its
   * worktree for life (`kept: active`), and the process that should have
   * lifted that protection no longer existed. The worktree, its branch and
   * everything cloned into it stayed there forever.
   */
  it("concludes an abandoned task, then collects the worktree it was holding", async () => {
    const record = await createRecordedWorktree("t_abandoned", "running");
    await staleMarker(root, record.id);

    const result = await garbageCollectWorktrees(root);

    expect(result.abandoned).toEqual([{ id: record.id, status: "running", pid: DEAD_PID }]);
    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "clean", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await fileTaskStore(root).get(record.id))?.status).toBe("failed");
  });

  it("--dry-run announces the abandoned task and its worktree, without writing anything", async () => {
    const record = await createRecordedWorktree("t_abandoned_preview", "running");
    const marker = await staleMarker(root, record.id);

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.abandoned).toEqual([{ id: record.id, status: "running", pid: DEAD_PID }]);
    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "would_remove", reason: "clean" }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await pathExists(marker)).toBe(true);
    expect((await fileTaskStore(root).get(record.id))?.status).toBe("running");
  });

  it("keeps an orphan whose marker is unreadable, even with --force", async () => {
    const id = "t_invalid_marker";
    const lease = await markWorktreeInUse(root, id);
    await writeFile(lease.path, "{incomplete json", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "kept", reason: "inspection_failed", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);
  });
});

/**
 * The gap between the *caesar* root and the *git* root. `resolveRoot` (CLI)
 * stops at the first `.caesar/` **or** `.git/`: when `.caesar/` lives in a
 * subdirectory of a repository, the two diverge. `createWorktree` creates
 * under the git root; the gc used to sweep `<root>/.caesar/wt`, that is, a
 * directory where nothing is ever created — orphans there were purely
 * invisible.
 */
describe("garbageCollectWorktrees — caesar root distinct from the git root", () => {
  let repo: string;
  let caesarRoot: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "caesar-gc-split-"));
    await initRepo(repo);
    caesarRoot = join(repo, "subproject");
    await execFileAsync("mkdir", ["-p", join(caesarRoot, ".caesar")]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("finds and cleans up an orphan created under the git root", async () => {
    const handle = await createWorktree(repo, "t_subproject");

    const result = await garbageCollectWorktrees(caesarRoot);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: "t_subproject", action: "removed", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(false);
    expect((await git(repo, ["branch", "--list", handle.branch])).trim()).toBe("");
  });
});

/**
 * The branch comes from `git worktree list --porcelain`, never from a
 * deduction on the directory name (`caesar/<dirname>`): that coincidence of
 * construction would leave branches behind as soon as the two stopped being
 * fabricated together — which readable branch naming does precisely.
 */
describe("garbageCollectWorktrees — the branch comes from git", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-gc-branch-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cleans up the real branch of an orphan whose name cannot be deduced from the directory", async () => {
    const path = join(root, ".caesar", "wt", "t_free");
    await execFileAsync("mkdir", ["-p", join(root, ".caesar", "wt")]);
    await git(root, ["worktree", "add", "-q", "-b", "caesar/implement/cache-overhaul-t_free", path]);

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: "t_free", branch: "caesar/implement/cache-overhaul-t_free", action: "removed" }),
    ]);
    expect((await git(root, ["branch", "--list", "caesar/implement/cache-overhaul-t_free"])).trim()).toBe("");
  });
});

/**
 * A task's status is written by the process driving it, in its `finally`.
 * Killed — `kill -9`, closing of the MCP session hosting it, machine
 * shutdown — it never writes it, and the record stays "running" for life:
 * `caesar ps` displays it at the top indefinitely, `caesar watch` follows it
 * endlessly, and `caesar gc` protects its worktree like that of a perfectly
 * alive task. Nothing reconciled this state.
 */
describe("sweepAbandonedTasks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-gc-abandon-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function record(id: string, status: TaskStatus): Promise<TaskRecord> {
    const value: TaskRecord = {
      id,
      agent: "codex",
      objective: "exercise the reconciliation",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      started_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", id),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      pid: DEAD_PID,
    };
    await fileTaskStore(root).create(value);
    return value;
  }

  it("concludes a task whose marker names a vanished process", async () => {
    const task = await record("t_orphan", "running");
    const marker = await staleMarker(root, task.id);

    const abandoned = await sweepAbandonedTasks(root);

    expect(abandoned).toEqual([{ id: task.id, status: "running", pid: DEAD_PID }]);
    const updated = await fileTaskStore(root).get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.ended_at).toBeDefined();
    expect(updated?.pid).toBeUndefined();
    expect(updated?.report_status).toBe("failed");
    // The stale marker is reclaimed: without that, it would stay on disk
    // forever — the orphan sweep only visits what git knows.
    expect(await pathExists(marker)).toBe(false);
  });

  it("says in the report what the status cannot say", async () => {
    const task = await record("t_report", "running");
    await staleMarker(root, task.id);

    await sweepAbandonedTasks(root);

    const report = await readReport(taskPaths(task.task_dir));
    expect(report?.status).toBe("failed");
    expect(report?.summary).toContain(String(DEAD_PID));
    expect(report?.summary).toContain("reconciled with git");
  });

  it("never overwrites the report the agent had time to write", async () => {
    const task = await record("t_agent_report", "running");
    await staleMarker(root, task.id);
    const paths = taskPaths(task.task_dir);
    await writeReport(paths, {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: "partial",
      summary: "Half the work is done.",
    });

    await sweepAbandonedTasks(root);

    const report = await readReport(paths);
    expect(report?.summary).toBe("Half the work is done.");
    // The process, for its part, stays failed: no one saw its exit code.
    const updated = await fileTaskStore(root).get(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.report_status).toBe("partial");
  });

  it("does not touch a task whose marker names a living process", async () => {
    const task = await record("t_alive", "running");
    const lease = await markWorktreeInUse(root, task.id);

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");

    await clearWorktreeInUse(lease);
  });

  /**
   * Absence is not proof of death: a record written by something other than
   * the engine never took a marker, and must not be declared dead for that.
   * `caesar cancel` remains the manual exit.
   */
  it("concludes nothing about a task without a marker", async () => {
    const task = await record("t_no_marker", "running");

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");
  });

  it("does not touch already-finished tasks", async () => {
    const task = await record("t_finished", "succeeded");
    await staleMarker(root, task.id);

    expect(await sweepAbandonedTasks(root)).toEqual([]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("succeeded");
  });

  it("also concludes a task that died before its launch", async () => {
    const task = await record("t_never_launched", "pending");
    await staleMarker(root, task.id);

    const abandoned = await sweepAbandonedTasks(root);

    expect(abandoned).toEqual([{ id: task.id, status: "pending", pid: DEAD_PID }]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("failed");
  });

  it("detectAbandonedTasks observes without writing anything", async () => {
    const task = await record("t_finding", "running");
    const marker = await staleMarker(root, task.id);

    expect(await detectAbandonedTasks(root)).toEqual([{ id: task.id, status: "running", pid: DEAD_PID }]);
    expect((await fileTaskStore(root).get(task.id))?.status).toBe("running");
    expect(await pathExists(marker)).toBe(true);
  });
});
