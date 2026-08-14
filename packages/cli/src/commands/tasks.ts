/**
 * `caesar ps|logs|cancel|diff|apply`.
 */
import { readFile } from "node:fs/promises";
import type { CaesarEvent } from "@caesar/protocol";
import { EventSchema, readEvents, taskPaths } from "@caesar/protocol";
import type { TaskRecord, TaskStatus, TaskStore } from "@caesar/core";
import { applyRecordedWorktree, diffWorktree, fileTaskStore, formatDuration, loadWorktreeHandle, sweepAbandonedTasks } from "@caesar/core";
import type { Cell, Io, ThemeToken } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  activeGlyphs,
  printError,
  printJson,
  printTable,
  printWarning,
  sectionHeader,
  writeLine,
} from "../output.js";
import { createFileTail } from "../tail.js";

const KNOWN_STATUSES: readonly TaskStatus[] = ["pending", "running", "succeeded", "failed", "cancelled", "timed_out"];
const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];
const DEFAULT_RECENT_LIMIT = 10;
/** Poll interval in `--follow` mode: no file notification API here, we re-read at a short interval. */
const FOLLOW_POLL_MS = 150;

function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** The process outcome, told by color as much as by word. */
function statusToken(status: TaskStatus): ThemeToken {
  if (status === "running") return "accent";
  if (status === "pending") return "dim";
  if (status === "succeeded") return "ok";
  return "bad";
}

/** The outcome declared by the agent — `partial` and `blocked` call the eye without being failures. */
function reportToken(report: string): ThemeToken {
  if (report === "success") return "ok";
  if (report === "partial" || report === "blocked") return "warn";
  if (report === "failed") return "bad";
  return "dim";
}

/**
 * A task's age, rather than its creation date.
 *
 * An ISO timestamp occupies twenty-four columns to say what "2m14s ago"
 * says in nine, and it forces the subtraction to be done in one's head. The
 * exact date stays in `--json`, where it has a reader with a use for it.
 */
function age(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "-";
  return `${formatDuration(now - at)} ago`;
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

export interface PsOptions {
  status?: string;
  json?: boolean;
}

export async function runPs(root: string, options: PsOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);

  // `ps` is the first place where a task whose orchestrator died without
  // concluding it shows up — it stays "running" there forever, at the top
  // of the list, with nothing saying nobody is driving it anymore. It is
  // therefore also the first place where that state must repair itself,
  // like the repository's other locks repair themselves on read
  // (`reclaimDead`, `purgeLease`).
  //
  // A read that writes calls for justification: the sweep only acts on
  // positive evidence — the task's marker names a process that no longer
  // exists — and only records a fact already true. It must nonetheless
  // never prevent the list from displaying: an unreadable `.caesar/state/`
  // is a nuisance to flag, not a reason to show nothing anymore.
  try {
    await sweepAbandonedTasks(root, store);
  } catch (error) {
    printWarning(io, `Abandoned tasks not reconciled: ${error instanceof Error ? error.message : String(error)}`);
  }

  let records: TaskRecord[];
  if (options.status) {
    const statuses = options.status.split(",").map((s) => s.trim());
    const invalid = statuses.filter((s) => !KNOWN_STATUSES.includes(s as TaskStatus));
    if (invalid.length > 0) {
      printError(io, `Unknown status(es): ${invalid.join(", ")} (expected one of: ${KNOWN_STATUSES.join(", ")}).`);
      return EXIT_USAGE;
    }
    records = await store.list({ status: statuses as TaskStatus[] });
  } else {
    const all = await store.list();
    const active = all.filter((r) => isActive(r.status));
    const finished = all
      .filter((r) => !isActive(r.status))
      .sort((a, b) => (b.ended_at ?? b.created_at).localeCompare(a.ended_at ?? a.created_at))
      .slice(0, DEFAULT_RECENT_LIMIT);
    records = [...active, ...finished];
  }

  records = [...records].sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (options.json) {
    printJson(io, { tasks: records });
    return EXIT_OK;
  }

  sectionHeader(io, "ps");
  if (records.length === 0) {
    writeLine(io.stdout, "No tasks.");
    return EXIT_OK;
  }

  // Six columns, not eight. The agent carries its role, the mode carries
  // its isolation: these pairs are read together and looked up together,
  // and separating them cost two columns an 80-character frame does not
  // have.
  //
  // "report", on the other hand, stays distinct from "status" (I3 of the
  // final review): "status" only reflects the process outcome, never what
  // the agent declared in its report — a task "succeeded" at the process
  // level can carry a "failed"/"partial"/"blocked" report, and it is
  // precisely the gap between the two one comes to read here.
  const bullet = activeGlyphs().status.bullet;
  const now = Date.now();
  const rows: Cell[][] = records.map((r) => [
    r.id,
    r.role ? `${r.agent} ${bullet} ${r.role}` : r.agent,
    { text: r.status, token: statusToken(r.status) },
    r.report_status ? { text: r.report_status, token: reportToken(r.report_status) } : "-",
    `${r.isolation} ${bullet} ${r.mode}`,
    { text: age(r.created_at, now), token: "dim" },
  ]);
  printTable(io, ["id", "agent", "status", "report", "execution", "age"], rows);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export interface LogsOptions {
  raw?: boolean;
  follow?: boolean;
  json?: boolean;
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Hands `onChunk` each new segment of `path`, until the task `id` is no
 * longer active.
 *
 * The offset-based following itself lives in `../tail.js`: `caesar watch`
 * needs it too, with a different stop condition (several tasks, and a
 * window that stays open after they finish).
 */
async function tailFile(store: TaskStore, id: string, path: string, onChunk: (chunk: string) => void): Promise<void> {
  const tail = createFileTail(path);
  const emitNew = async (): Promise<void> => {
    const chunk = await tail.read();
    if (chunk !== "") onChunk(chunk);
  };

  for (;;) {
    await emitNew();
    const record = await store.get(id);
    if (!record || !isActive(record.status)) {
      await emitNew();
      return;
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, FOLLOW_POLL_MS));
  }
}

function formatEvent(event: CaesarEvent): string {
  switch (event.type) {
    case "started":
      return `[${event.seq}] started — ${event.command}`;
    case "thinking":
      return `[${event.seq}] thinking: ${event.text}`;
    case "message":
      return `[${event.seq}] message: ${event.text}`;
    case "tool_use":
      return `[${event.seq}] tool ${event.tool} (${event.status})${event.input_summary ? ` — ${event.input_summary}` : ""}`;
    case "file_changed":
      return `[${event.seq}] file ${event.action}: ${event.path}`;
    case "progress":
      return `[${event.seq}] progress: ${event.message}${event.pct !== undefined ? ` (${event.pct}%)` : ""}`;
    case "question":
      return `[${event.seq}] question: ${event.question}`;
    case "answer":
      return `[${event.seq}] answer: ${event.answer}`;
    case "error":
      return `[${event.seq}] error: ${event.message}`;
    case "finished":
      return `[${event.seq}] finished — status ${event.status}`;
  }
}

/**
 * Processes one line of `events.jsonl` while following (`--follow`). A line
 * with invalid JSON or one failing `EventSchema` is dropped — the follow
 * must not stop over an isolated event — but flagged on `stderr`: a silent
 * drop would mask a schema mismatch between what the engine writes and what
 * this CLI knows how to read. `stdout` stays reserved for the usable NDJSON
 * (`--json`) or the formatted display: never a diagnostic on it.
 */
function printFollowedLine(io: Io, rawLine: string, json: boolean | undefined): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    printWarning(io, `Line dropped (invalid JSON): ${rawLine}`);
    return;
  }
  const result = EventSchema.safeParse(parsed);
  if (!result.success) {
    printWarning(io, `Line dropped (does not match the event schema): ${rawLine}`);
    return;
  }
  if (json) printJson(io, result.data);
  else writeLine(io.stdout, formatEvent(result.data));
}

export async function runLogs(root: string, id: string, options: LogsOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Unknown task: "${id}".`);
    return EXIT_USAGE;
  }
  const paths = taskPaths(record.task_dir);

  if (options.raw) {
    if (options.follow) {
      await tailFile(store, id, paths.rawLog, (chunk) => io.stdout.write(chunk));
    } else {
      writeLine(io.stdout, (await readTextSafe(paths.rawLog)).replace(/\n+$/, ""));
    }
    return EXIT_OK;
  }

  if (options.follow) {
    let buffer = "";
    await tailFile(store, id, paths.eventsPath, (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) printFollowedLine(io, line, options.json);
      }
    });
    return EXIT_OK;
  }

  const events = await readEvents(paths);
  if (options.json) {
    printJson(io, { events });
  } else {
    for (const event of events) writeLine(io.stdout, formatEvent(event));
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface CancelOptions {
  json?: boolean;
}

function reportCancel(io: Io, json: boolean | undefined, id: string, cancelled: boolean, message: string): number {
  if (json) printJson(io, { id, cancelled, message });
  else writeLine(io.stdout, message);
  return EXIT_OK;
}

export async function runCancel(root: string, id: string, options: CancelOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Unknown task: "${id}".`);
    return EXIT_USAGE;
  }

  if (!isActive(record.status)) {
    return reportCancel(io, options.json, id, false, `Task "${id}" already finished (status "${record.status}"): nothing to cancel.`);
  }

  if (record.pid === undefined) {
    return reportCancel(
      io,
      options.json,
      id,
      false,
      `Task "${id}" is running, but no process identifier is recorded: cannot cancel it from this process.`,
    );
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      await store.update(id, { status: "cancelled", ended_at: new Date().toISOString(), pid: undefined });
      return reportCancel(io, options.json, id, true, `Task "${id}": the process (pid ${record.pid}) no longer exists. Marked cancelled.`);
    }
    throw error;
  }

  await store.update(id, { status: "cancelled", ended_at: new Date().toISOString() });
  return reportCancel(io, options.json, id, true, `Task "${id}" cancelled (SIGTERM sent to pid ${record.pid}).`);
}

// ---------------------------------------------------------------------------
// diff / apply
// ---------------------------------------------------------------------------
// `loadWorktreeHandle` now lives in `@caesar/core` (`engine/worktree.ts`) —
// shared with the MCP server (`caesar_diff`/`caesar_apply`), see the task 7
// correction report.

export interface DiffOptions {
  json?: boolean;
}

export async function runDiff(root: string, id: string, options: DiffOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Unknown task: "${id}".`);
    return EXIT_USAGE;
  }

  const handle = await loadWorktreeHandle(record);
  if (!handle) {
    const message = `Task "${id}": isolation "${record.isolation}", no worktree to diff.`;
    if (options.json) printJson(io, { id, is_empty: true, files: [], patch: "", message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  const diff = await diffWorktree(handle);
  if (options.json) {
    printJson(io, { id, files: diff.files, is_empty: diff.isEmpty, patch: diff.patch });
  } else if (diff.isEmpty) {
    writeLine(io.stdout, "No changes.");
  } else {
    writeLine(io.stdout, diff.patch);
  }
  return EXIT_OK;
}

export interface ApplyOptions {
  json?: boolean;
}

export async function runApply(root: string, id: string, options: ApplyOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Unknown task: "${id}".`);
    return EXIT_USAGE;
  }

  const result = await applyRecordedWorktree(root, store, record);
  if (result.outcome === "no_worktree") {
    const message = `Task "${id}": isolation "${record.isolation}", nothing to apply.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: [], message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  if (result.outcome === "conflicts") {
    const message = `Conflicts while applying task "${id}": ${result.conflicts.join(", ")}.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: result.conflicts });
    else printError(io, message);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { id, applied: true, conflicts: [] });
  else writeLine(io.stdout, `Task "${id}" applied to the main repository.`);
  return EXIT_OK;
}
