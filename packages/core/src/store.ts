/**
 * Task state persistence: one JSON file per task, under
 * `<root>/.caesar/state/tasks/<id>.json`.
 *
 * Writing always goes through a temporary file, never directly
 * through the final target — the MCP server and the CLI will read this state
 * while a run is writing into it: a reader must never
 * see a half-written JSON. That temporary file is then published in
 * two distinct ways depending on the operation: `rename` for `update`, which
 * must always replace the existing file; `link` for `create`, which on the
 * contrary must never do so (see the comment on `create` below).
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IsolationSchema, ReportStatusSchema, TaskModeSchema } from "@caesar/protocol";
import type { Isolation, ReportChannel, ReportStatus, TaskMode } from "@caesar/protocol";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** Provenance of the report finally retained, from most reliable to most degraded. */
export type ReportSource = "channel" | "schema" | "file" | "extracted" | "synthesized";

/**
 * Provenance of `report.changes` — see C2 of the final review: "git" when
 * the orchestrator was able to reconcile the agent's declaration with the
 * observed git state of the workspace (isolation `worktree`, or `inplace` in
 * a git repository), "declaration" when no reconciliation was possible
 * (workspace outside a git repository) — in that case only, `changes` remains
 * the agent's word, never presented as anything more.
 */
export type ChangesVerifiedBy = "git" | "declaration";

export interface TaskRecord {
  id: string;
  agent: string;
  role?: string;
  objective: string;
  status: TaskStatus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  task_dir: string;
  workspace: string;
  isolation: Isolation;
  mode: TaskMode;
  branch?: string;
  /**
   * Paths the orchestrator placed in the worktree (`[worktree]
   * copy`/`link`), to be removed from the diff — see `WorktreeHandle.excluded`.
   *
   * Persisted here because `caesar diff` and `caesar apply` recompute the diff
   * long after the task has ended, from the record alone: without this
   * trace, a copied `.env` would become applicable to the main
   * repository again. Absent for any task predating `[worktree]`, or without
   * materialization — the schema is not `.strict()`, the addition is
   * backward-compatible in both directions.
   */
  excluded_paths?: string[];
  exit_code?: number | null;
  report_via: ReportChannel;
  report_source?: ReportSource;
  changes_verified_by?: ChangesVerifiedBy;
  /**
   * The `status` of the resolved report (`report.ts`), distinct from `status`
   * above — see I3 of the final review: `status` only reflects the
   * outcome of the *process* (exit code, timeout, cancellation), never what
   * the agent declared in its report. An agent that writes
   * `{"status":"failed"}` then exits with code 0 produces `status: "succeeded"`
   * and `report_status: "failed"` — both are true, at different
   * levels; neither `caesar ps`, nor the exit code of `caesar run`, nor
   * `caesar_status` may ignore either of the two.
   */
  report_status?: ReportStatus;
  depth: number;
  /**
   * Process identifier of the sub-agent, while it runs. Set
   * by the engine at launch, cleared at the end (see `runner.ts`): this is
   * what allows `caesar cancel` (CLI task) to send SIGTERM to a task
   * launched by another process (the MCP server, for example) with no other
   * way to find its PID.
   */
  pid?: number;
  /**
   * Set by `applyRecordedWorktree` (engine/worktree.ts) when the worktree's
   * diff has been applied to the main repository: the moment of application,
   * and the sha256 (hex) of the applied patch text. A new successful apply
   * overwrites them — the last application is authoritative. `caesar gc` uses
   * them to collect a worktree whose current patch still bears the
   * same fingerprint: a dated, positive fact, never a deduction from the
   * content. Absent for any task never applied, applied empty, or
   * predating this mechanism — the schema not being `.strict()`, the addition
   * is backward-compatible in both directions.
   */
  applied_at?: string;
  applied_patch_digest?: string;
}

export interface TaskStore {
  /**
   * Creates the record of a new task. Throws if `record.id` is already
   * taken — never a silent overwrite: two runs sharing
   * the same identifier (caller bug, `taskId` imposed and reused by
   * mistake) would otherwise write into the same task directory, with a
   * truncated `raw.log` and an interleaved `events.jsonl`. Exclusivity is
   * guaranteed by the filesystem (publication via `link`, which fails
   * if the target already exists), not merely by a prior re-read:
   * two concurrent `create`s on the same identifier cannot both
   * succeed. `update` remains the only way to modify an existing
   * record.
   */
  create(record: TaskRecord): Promise<void>;
  update(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  list(filter?: { status?: TaskStatus[] }): Promise<TaskRecord[]>;
}

const SUFFIX = ".json";

/**
 * Rejects any `id` that could escape from `dir` once composed into
 * a file path — see I9 of the final review, verified by running
 * the code: `fileFor` did `join(dir, \`${id}.json\`)` with no normalization
 * or validation, and `store.get("../../../secret")` returned the content of
 * an arbitrary file outside the store (`{"status":"top-secret-value",...}`).
 * `task_id` is declared `z.string().min(1)` in seven MCP tools driven by
 * the model (`caesar_logs`/`caesar_status`/`caesar_diff`/`caesar_apply`/
 * `caesar_cancel`/`caesar_await`/`caesar_answer`): this guard, single and placed here
 * rather than repeated in each of them, closes the entire category in one
 * move.
 *
 * Does not enforce the format generated by `generateTaskId` (`t_` + 32 hex):
 * readable identifiers ("t_imposed", "t_test"…) are a legitimate, tested
 * use of `RunTaskInput.taskId`, documented as customizable by the
 * caller. Only path separators, null bytes and the special directory
 * names (".", "..") are forbidden.
 */
function assertSafeTaskId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(`Invalid task identifier: "${id}".`);
  }
}

/**
 * Validates the shape of a record re-read from disk, rather than a
 * cast `as TaskRecord` — second move of I9 from the final review: without
 * it, a `.json` file of the store whose content was not a real
 * `TaskRecord` (corruption, partial write escaping the usual
 * atomicity, file dropped there by something else) would nevertheless be
 * interpreted as one — notably its `status`/`pid`, which `caesar_cancel` uses
 * to send a signal to a process (`cancel.ts`, pid fallback).
 */
const TaskRecordSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  role: z.string().optional(),
  objective: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  task_dir: z.string(),
  workspace: z.string(),
  isolation: IsolationSchema,
  mode: TaskModeSchema,
  branch: z.string().optional(),
  excluded_paths: z.array(z.string()).optional(),
  exit_code: z.number().int().nullish(),
  report_via: z.enum(["channel", "schema", "file"]),
  report_source: z.enum(["channel", "schema", "file", "extracted", "synthesized"]).optional(),
  changes_verified_by: z.enum(["git", "declaration"]).optional(),
  report_status: ReportStatusSchema.optional(),
  depth: z.number().int().nonnegative(),
  pid: z.number().int().positive().optional(),
  applied_at: z.string().optional(),
  applied_patch_digest: z.string().optional(),
});

export function fileTaskStore(root: string): TaskStore {
  const dir = join(root, ".caesar", "state", "tasks");

  function fileFor(id: string): string {
    assertSafeTaskId(id);
    return join(dir, `${id}${SUFFIX}`);
  }

  async function readRecord(id: string): Promise<TaskRecord | null> {
    try {
      const raw = await readFile(fileFor(id), "utf8");
      const parsed = TaskRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? (parsed.data as TaskRecord) : null;
    } catch {
      return null;
    }
  }

  /**
   * Writes `record` into a temporary file in the same directory (same
   * filesystem, a necessary condition for `rename`/`link` to be
   * atomic right after): at this moment, `record` is not yet
   * visible under any name that `create`/`update` would then publish,
   * each in its own way — see the file header.
   */
  async function writeTemp(record: TaskRecord): Promise<string> {
    // Builds its own path from `record.id`, without going through
    // `fileFor`: validated here separately so as not to depend on the order
    // of calls with `fileFor` further down.
    assertSafeTaskId(record.id);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${record.id}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    return tmp;
  }

  async function writeRecord(record: TaskRecord): Promise<void> {
    const tmp = await writeTemp(record);
    // `rename` always replaces the existing file, unconditionally — exactly
    // what `update` wants: a concurrent reader only ever sees a complete
    // version (the old one or the new one), never a partial file.
    await rename(tmp, fileFor(record.id));
  }

  return {
    async create(record) {
      const tmp = await writeTemp(record);
      try {
        // `link`, not `rename`: creates a new directory entry pointing to
        // the temporary file's inode (already fully written — no
        // partial read ever possible, same safety window as
        // `update`) without ever touching a target that would already exist —
        // fails with EEXIST in that case, guaranteed by the
        // filesystem. `rename` does not offer that guarantee (it always
        // overwrites); that is precisely why `update`, which must on the
        // contrary always replace, keeps using it above.
        await link(tmp, fileFor(record.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Task already exists: "${record.id}" (a record already bears this identifier; use update to modify it).`);
        }
        throw error;
      } finally {
        // `tmp` is no longer needed once published (link creates a second
        // independent link to the same content) or abandoned (failure): never
        // left behind, in either case.
        await unlink(tmp).catch(() => {});
      }
    },

    async update(id, patch) {
      const current = await readRecord(id);
      if (!current) {
        throw new Error(`Unknown task: "${id}"`);
      }
      const updated: TaskRecord = { ...current, ...patch };
      await writeRecord(updated);
      return updated;
    },

    get: (id) => readRecord(id),

    async list(filter) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const ids = entries
        .filter((entry) => entry.endsWith(SUFFIX) && !entry.startsWith("."))
        .map((entry) => entry.slice(0, -SUFFIX.length));
      const records = await Promise.all(ids.map((id) => readRecord(id)));
      const found = records.filter((record): record is TaskRecord => record !== null);
      return filter?.status ? found.filter((record) => filter.status!.includes(record.status)) : found;
    },
  };
}
