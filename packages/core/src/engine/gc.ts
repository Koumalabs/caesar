/**
 * Inventory and cleanup of what tasks leave behind: their disposable
 * worktrees, and their records left "running" when no one is driving
 * them anymore.
 *
 * The whole decision lives here, not in the CLI: the other frontends can
 * thus present exactly the same removals and keeps. An active task is
 * protected before the Git inspection even happens; a finished task is only
 * removed if its worktree is clean or if its patch has been applied and has
 * not moved since (`applied_at` + digest, set by `applyRecordedWorktree`),
 * unless explicitly requested with `force`. Directories under `.caesar/wt`
 * that match no worktree record still present are treated as orphans.
 *
 * Both cleanups live in the same file because the first conditions the
 * second: a record stuck on "running" protects its worktree indefinitely
 * (`kept: active`), and the process that should have concluded it no longer
 * exists to lift that protection.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative as relative_, resolve } from "node:path";
import { promisify } from "node:util";
import { REPORT_PROTOCOL, ReportSchema, readReport, taskPaths, writeReport } from "@caesar/protocol";
import type { TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { fileTaskStore } from "../store.js";
import { acquireLease, inspectLease, purgeLease, releaseLease } from "./lock.js";
import type { Lease, LeaseInspection } from "./lock.js";
import { diffWorktree, listGitWorktrees, loadWorktreeHandle, patchDigest, removeWorktree, repoRoot } from "./worktree.js";
import type { WorktreeHandle } from "./worktree.js";

const execFileAsync = promisify(execFile);
const WORKTREES_IN_USE_DIR = join(".caesar", "state", "worktrees-in-use");

export type WorktreeGcAction = "removed" | "would_remove" | "kept";
export type WorktreeGcReason = "clean" | "modified" | "applied" | "active" | "inspection_failed";

export interface WorktreeGcEntry {
  id: string;
  path: string;
  branch: string;
  orphan: boolean;
  status?: TaskStatus;
  /**
   * The instant of the last apply (`caesar apply`) carried by the record,
   * passed through as-is: it is what distinguishes, among the entries kept
   * as `modified`, those that were applied and then touched up afterwards.
   */
  applied_at?: string;
  action: WorktreeGcAction;
  reason: WorktreeGcReason;
  error?: string;
}

export interface WorktreeGcOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface WorktreeGcResult {
  dryRun: boolean;
  force: boolean;
  entries: WorktreeGcEntry[];
  removed: number;
  wouldRemove: number;
  kept: number;
  /**
   * The tasks concluded outright because the process driving them had
   * disappeared — see `sweepAbandonedTasks`. Under `dryRun`, those that
   * would have been: nothing is written, but their worktrees are counted as
   * collectable, without which the preview would announce a keep that the
   * real pass would not perform.
   */
  abandoned: AbandonedTask[];
}

interface Candidate {
  id: string;
  handle: WorktreeHandle;
  orphan: boolean;
  status?: TaskStatus;
  /** Absent for an orphan: no record in the store claims it. */
  record?: TaskRecord;
}

/**
 * The lease the runner puts on a task's identifier, before its worktree
 * even exists on disk.
 *
 * Kept as a type of this module rather than an alias of `Lease`: callers
 * reason in task identifiers, not lock keys.
 */
export interface WorktreeInUseLease extends Lease {
  id: string;
}

/**
 * Marks an identifier before its worktree is exposed on disk. The runner
 * keeps this marker until its termination so that a concurrent GC never
 * mistakes the pre-store window for an orphan.
 *
 * The mechanism itself now lives in `lock.ts`, where a second use pulled it
 * (write exclusivity on a workspace). This function's contract is unchanged,
 * refusal reason included.
 */
export async function markWorktreeInUse(root: string, id: string): Promise<WorktreeInUseLease> {
  const lease = await acquireLease(join(root, WORKTREES_IN_USE_DIR), id, {
    describeHolder: () => `Task "${id}" is already being prepared or executed.`,
  });
  return { ...lease, id };
}

/** Best-effort marker removal, only if the owner's token still matches. */
export async function clearWorktreeInUse(lease: WorktreeInUseLease): Promise<void> {
  await releaseLease(lease);
}

function inspectWorktreeMarker(root: string, id: string): Promise<LeaseInspection> {
  return inspectLease(join(root, WORKTREES_IN_USE_DIR), id);
}

// ---------------------------------------------------------------------------
// Abandoned tasks
// ---------------------------------------------------------------------------

/** A task the store still says is active, while the process driving it no longer exists. */
export interface AbandonedTask {
  id: string;
  /** The status the store still carried: "running", or "pending" if the task died before its launch. */
  status: TaskStatus;
  /** The vanished orchestrator process, as its marker named it. */
  pid: number;
}

/**
 * The tasks whose orchestrator died without concluding them.
 *
 * A task's status is written by the process driving it, in its `finally`:
 * killed (`kill -9`, closing of the MCP session hosting it, machine
 * shutdown), it never writes it. The record stays "running" forever —
 * `caesar ps` displays it at the top indefinitely, `caesar watch` follows it
 * endlessly, and its worktree, protected like that of an active task, is
 * never collected again. Nothing, until now, reconciled this state; the
 * repository's other locks all repair themselves on read (`reclaimDead` in
 * `slots.ts`, `purgeLease` in `lock.ts`).
 *
 * The proof of death is the marker that `markWorktreeInUse` sets **before**
 * the record and only removes **after** the final status: as long as a task
 * is genuinely being driven, its marker names a living process.
 * A stale marker (`stale`: the pid no longer exists) is therefore a dated,
 * positive fact, never a deduction.
 *
 * An **absent** marker concludes nothing, deliberately: absence is not proof
 * of death. A record written by something other than the engine — a manual
 * repair, a test fixture — must not be declared dead because it never took a
 * marker. `caesar cancel <id>` remains the manual exit: it already marks as
 * "cancelled" a task whose pid has disappeared.
 */
export function detectAbandonedTasks(root: string, store: TaskStore = fileTaskStore(root)): Promise<AbandonedTask[]> {
  return collectAbandoned(root, store, false);
}

/**
 * Concludes abandoned tasks: marker reclaimed, status "failed",
 * `ended_at` set, `pid` cleared.
 *
 * "failed" rather than a new status: the outcome is the one the engine's
 * `finally` already writes when it loses a task en route, and a seventh
 * status would have to traverse the protocol, the CLI, the TUI and the exit
 * codes to say the same thing. The report, for its part, says what actually
 * happened — that is where the nuance has a reader.
 *
 * The marker is reclaimed **before** the status is written: its reclaim is
 * exclusive (`purgeLease`), so it serves as a mutex between two simultaneous
 * sweeps. The one that loses the race concludes nothing.
 */
export function sweepAbandonedTasks(root: string, store: TaskStore = fileTaskStore(root)): Promise<AbandonedTask[]> {
  return collectAbandoned(root, store, true);
}

/** The finding, common to both; `commit` alone decides whether it is also recorded. */
async function collectAbandoned(root: string, store: TaskStore, commit: boolean): Promise<AbandonedTask[]> {
  const records = await store.list({ status: ["pending", "running"] });
  const abandoned: AbandonedTask[] = [];
  for (const record of records) {
    const marker = await inspectWorktreeMarker(root, record.id);
    if (marker.state !== "stale") continue;
    if (commit) {
      if (!(await purgeLease(marker))) continue;
      await finalizeAbandoned(store, record, marker.marker.pid);
    }
    abandoned.push({ id: record.id, status: record.status, pid: marker.marker.pid });
  }
  return abandoned;
}

/**
 * Writes an abandoned task's report, then its final status.
 *
 * A report already present is **never** overwritten: an agent may well have
 * deposited its own just before the orchestrator disappeared, and it is then
 * the only testimony of what it did. The process status remains "failed"
 * regardless: no one saw its exit code, and the reconciliation with git
 * never took place — `report_status` carries the other level, as everywhere
 * else.
 */
async function finalizeAbandoned(store: TaskStore, record: TaskRecord, pid: number): Promise<void> {
  const patch: Partial<TaskRecord> = { status: "failed", ended_at: new Date().toISOString(), pid: undefined };

  if (record.task_dir) {
    const paths = taskPaths(record.task_dir);
    const existing = await readReport(paths);
    if (existing) {
      patch.report_status = existing.status;
    } else {
      const report = ReportSchema.parse({
        protocol: REPORT_PROTOCOL,
        task_id: record.id,
        status: "failed",
        summary:
          `Task interrupted before completion: the orchestrator process (pid ${pid}) disappeared without concluding it. ` +
          `What the agent had done before that disappearance was never reconciled with git.`,
      });
      await writeReport(paths, report);
      patch.report_status = report.status;
    }
  }

  await store.update(record.id, patch);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isActive(status: TaskStatus | undefined): boolean {
  return status === "pending" || status === "running";
}

/**
 * Inspects the index, tracked files and untracked files without modifying
 * the worktree's index. `GIT_OPTIONAL_LOCKS=0` notably prevents the
 * opportunistic update of its cache during this read, which keeps
 * `--dry-run` write-free.
 */
async function worktreeHasChanges(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", path, "status", "--porcelain", "--untracked-files=normal"], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim().length > 0;
}

async function recordedCandidates(root: string): Promise<Candidate[]> {
  const records = await fileTaskStore(root).list();
  const candidates = await Promise.all(
    records
      .filter((record): record is TaskRecord & { isolation: "worktree" } => record.isolation === "worktree")
      .map(async (record): Promise<Candidate | null> => {
        if (!(await pathExists(record.workspace))) return null;
        return {
          id: record.id,
          handle: {
            path: record.workspace,
            branch: record.branch ?? `caesar/${record.id}`,
            // The cleanup never compares against the base; only the shape of
            // the shared handle requires this value.
            baseRef: "HEAD",
          },
          orphan: false,
          status: record.status,
          record,
        };
      }),
  );
  return candidates.filter((candidate): candidate is Candidate => candidate !== null);
}

/**
 * Caesar's worktrees that no record in the store claims.
 *
 * Two sources, combined, each covering the other's blind spot:
 *
 * - **`git worktree list --porcelain`**, the truth about what git considers
 *   a worktree, and the only one to give the actually associated branch. The
 *   GC used to deduce it from the directory name (`caesar/<dirname>`): a
 *   coincidence of construction, which would leave branches behind as soon
 *   as the two stopped being fabricated together. It also reports worktrees
 *   whose tree was erased by hand, which the directory sweep by construction
 *   cannot see.
 * - **the sweep of `.caesar/wt/`**, for residues git does not know about: a
 *   directory left by a creation interrupted before git registered it.
 *   `removeWorktree` will fail on it, and the entry will say
 *   `inspection_failed` rather than leaving the directory invisible.
 *
 * The repository is looked up **from `root`**, and worktrees are recognized
 * by their location under `<repo>/.caesar/wt/`, never under `<root>/.caesar/wt/`:
 * `createWorktree` creates them under the *git* root, whereas `root` is the
 * *caesar* root — `resolveRoot` (CLI) stops at the first `.caesar/` **or**
 * `.git/`. When `.caesar/` lives in a subdirectory of a repository, the two
 * diverge, and the GC used to look where nothing is ever created: orphans
 * there were purely invisible.
 */
async function orphanCandidates(root: string, recorded: Candidate[]): Promise<Candidate[]> {
  const repo = (await repoRoot(root)) ?? root;
  const worktreesDir = join(repo, ".caesar", "wt");
  const byPath = new Map<string, Candidate>();

  const canonicalWorktreesDir = await canonical(worktreesDir);
  for (const entry of await listGitWorktrees(repo)) {
    if (!isUnderDir(entry.path, canonicalWorktreesDir)) continue;
    const id = basename(entry.path);
    byPath.set(await canonical(entry.path), {
      id,
      handle: {
        path: entry.path,
        branch: entry.branch ?? `caesar/${id}`,
        // The cleanup never compares against the base; only the shape of the
        // shared handle requires this value.
        baseRef: "HEAD",
      },
      orphan: true,
    });
  }

  let dirEntries: Dirent<string>[] = [];
  try {
    dirEntries = await readdir(worktreesDir, { withFileTypes: true });
  } catch {
    // No worktree was ever created under this repository.
  }
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreesDir, entry.name);
    const key = await canonical(path);
    if (byPath.has(key)) continue;
    byPath.set(key, {
      id: entry.name,
      handle: { path, branch: `caesar/${entry.name}`, baseRef: "HEAD" },
      orphan: true,
    });
  }

  const recordedPaths = new Set(await Promise.all(recorded.map((candidate) => canonical(candidate.handle.path))));
  const candidates: Candidate[] = [];
  for (const [key, candidate] of byPath) {
    if (!recordedPaths.has(key)) candidates.push(candidate);
  }
  return candidates;
}

/** Is `path` `dir` itself or one of its descendants? Compared via resolved paths, never by string prefix. */
function isUnderDir(path: string, dir: string): boolean {
  const relative = relative_(resolve(dir), resolve(path));
  return relative !== "" && !relative.startsWith("..") && !isAbsolute(relative);
}

/**
 * Canonical form of a path, symlinks resolved — the only one on which two
 * paths of different provenance can be compared.
 *
 * `git worktree list` yields real paths, whereas the store recorded the one
 * the caller gave it: on macOS, `/var/folders/…` on one side and
 * `/private/var/folders/…` on the other name the same directory, and
 * `resolve` alone does not see it. Without this normalization, every
 * recorded worktree also reappeared as an orphan.
 *
 * Falls back to `resolve` when the path no longer exists: that is precisely
 * the case of a worktree whose tree was erased by hand, which `git worktree
 * list` still reports.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Does the worktree of an applied task carry exactly what was applied?
 * True only when the record testifies to an application (`applied_at` +
 * digest) and the recomputed patch — via the same `diffWorktree` as the
 * apply, the only way to make the digests comparable — still carries the
 * same digest. Any failure of the verification (task.json gone, git
 * failing) answers no: we never delete on a doubt.
 *
 * `diffWorktree` puts an `add --intent-to-add` in the candidate worktree's
 * index, including under `--dry-run`: it is the index of a disposable
 * worktree, already traversed by the apply itself, and the gesture is
 * necessary — without it, untracked files would be missing from the patch
 * and the digest would never match. The real workspace and the store, for
 * their part, remain untouched under `--dry-run`.
 */
async function appliedAndUnchanged(record: TaskRecord | undefined): Promise<boolean> {
  if (!record?.applied_at || !record.applied_patch_digest) return false;
  try {
    const handle = await loadWorktreeHandle(record);
    if (!handle) return false;
    const diff = await diffWorktree(handle);
    return patchDigest(diff.patch) === record.applied_patch_digest;
  } catch {
    return false;
  }
}

/**
 * Cleans up eligible worktrees and yields an entry for each worktree still
 * present at the start of the operation. With `dryRun`, the same decision is
 * computed but no removal is performed.
 */
export async function garbageCollectWorktrees(root: string, options: WorktreeGcOptions = {}): Promise<WorktreeGcResult> {
  // Git commands run from the repository root, not from the caesar root:
  // the two diverge as soon as `.caesar/` lives in a subdirectory of a
  // repository (see `orphanCandidates`), and `git worktree remove` launched
  // outside the repository would fail on every candidate.
  const repo = (await repoRoot(root)) ?? root;

  // Abandoned tasks first, and before any read of the store: their
  // "running" status protects their worktree (`kept: active`) while no one
  // is holding it anymore. Without this pass, a killed orchestrator doomed
  // its worktree — and its branch, and the `node_modules` just cloned into
  // it — to never be collected again. It is also here, and nowhere else,
  // that the stale marker of a task without a worktree finally gets
  // reclaimed: the orphan sweep only visits what git or `.caesar/wt` knows.
  const abandoned = await collectAbandoned(root, fileTaskStore(root), !(options.dryRun ?? false));
  // Under `dryRun`, the store has not moved: their records still say
  // "running" and would cause them to be kept. The preview must show what
  // the real pass would do, not what inaction produces.
  const abandonedIds = new Set(abandoned.map((task) => task.id));

  const recorded = await recordedCandidates(root);
  const orphans = await orphanCandidates(root, recorded);
  const candidates = [...recorded, ...orphans].sort((a, b) => a.id.localeCompare(b.id));
  const entries: WorktreeGcEntry[] = [];

  for (const candidate of candidates) {
    const common = {
      id: candidate.id,
      path: candidate.handle.path,
      branch: candidate.handle.branch,
      orphan: candidate.orphan,
      status: candidate.status,
      ...(candidate.record?.applied_at ? { applied_at: candidate.record.applied_at } : {}),
    };

    // Re-read at the last moment: the worktree may have appeared after the
    // store's first snapshot. The runner sets the marker before its creation
    // and keeps it until the end, closing this race without an arbitrary
    // delay or an assumption about the directory's age.
    if (candidate.orphan) {
      const marker = await inspectWorktreeMarker(root, candidate.id);
      if (marker.state === "active") {
        entries.push({ ...common, action: "kept", reason: "active" });
        continue;
      }
      if (marker.state === "unknown") {
        entries.push({ ...common, action: "kept", reason: "inspection_failed", error: marker.error });
        continue;
      }
      if (marker.state === "stale" && !options.dryRun && !(await purgeLease(marker))) {
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: "another operation is cleaning up the stale marker",
        });
        continue;
      }
    }

    if (isActive(candidate.status) && !abandonedIds.has(candidate.id)) {
      entries.push({ ...common, action: "kept", reason: "active" });
      continue;
    }

    let modified: boolean;
    try {
      modified = await worktreeHasChanges(candidate.handle.path);
    } catch (error) {
      entries.push({
        ...common,
        action: "kept",
        reason: "inspection_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let reason: WorktreeGcReason = "clean";
    if (modified) {
      if (await appliedAndUnchanged(candidate.record)) {
        // The current patch is the one that was applied: the worktree no
        // longer carries anything unique, it is collectable like a clean one.
        reason = "applied";
      } else if (!options.force) {
        entries.push({ ...common, action: "kept", reason: "modified" });
        continue;
      } else {
        reason = "modified";
      }
    }

    const action: WorktreeGcAction = options.dryRun ? "would_remove" : "removed";
    if (!options.dryRun) {
      try {
        await removeWorktree(repo, candidate.handle);
      } catch (error) {
        // A residue git does not know about (creation interrupted before it
        // was registered): say it, rather than failing the whole cleanup on
        // a directory git refuses to take back.
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    entries.push({ ...common, action, reason });
  }

  return {
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    abandoned,
    entries,
    removed: entries.filter((entry) => entry.action === "removed").length,
    wouldRemove: entries.filter((entry) => entry.action === "would_remove").length,
    kept: entries.filter((entry) => entry.action === "kept").length,
  };
}
