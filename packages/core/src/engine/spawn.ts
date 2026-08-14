/**
 * Launching a sub-agent's process and normalizing its output stream
 * into the common vocabulary of `@caesar/protocol`.
 *
 * Here, and only here, does a child process exist: the rest of the
 * engine only knows `SpawnPlan` as input and `RunResult` as
 * output.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { CaesarEvent, TaskPaths } from "@caesar/protocol";
import { appendEvent, makeEvent } from "@caesar/protocol";
import type { AgentDefinition, PartialEvent, PreparedFile, SpawnPlan } from "../registry/types.js";

/** Grace period between SIGTERM and SIGKILL, when there is no exit. */
const KILL_GRACE_MS = 5000;

export interface RunOptions {
  agent: AgentDefinition;
  plan: SpawnPlan;
  paths: TaskPaths;
  taskId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: CaesarEvent) => void;
  /**
   * Called as soon as the sub-process pid is known, before any processing
   * of its output. Serves only `runner.ts` to record `TaskRecord.pid`
   * as early as possible (see the task 6 brief, `caesar cancel` extension); ignored
   * if the process fails to start (no pid in that case).
   */
  onSpawn?: (pid: number) => void | Promise<void>;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  finalText?: string;
  eventCount: number;
  durationMs: number;
}

export async function runAgentProcess(options: RunOptions): Promise<RunResult> {
  const { agent, plan, paths, taskId, timeoutMs, signal, onEvent, onSpawn } = options;
  const startedAt = Date.now();

  // A signal already triggered at entry (cancellation that occurred during an
  // earlier, slower step — isolation preparation, for example)
  // must never lead to a launch: an `abort` listener attached after
  // the fact, further down this function, would never fire for a
  // signal already aborted.
  if (signal?.aborted) {
    return { exitCode: null, signal: null, timedOut: false, aborted: true, eventCount: 0, durationMs: Date.now() - startedAt };
  }

  const fileBackups = await prepareFiles(plan.files);
  try {
    return await runWithFiles(options, startedAt);
  } finally {
    await restoreFiles(fileBackups);
  }
}

interface FileBackup {
  path: string;
  existed: boolean;
  content: string;
}

/** Writes each file of the plan; first backs up the previous content of those marked `restoreAfter` (see `PreparedFile`, C5 of the final review). */
async function prepareFiles(files: readonly PreparedFile[]): Promise<FileBackup[]> {
  const backups: FileBackup[] = [];
  for (const file of files) {
    if (file.restoreAfter) {
      try {
        backups.push({ path: file.path, existed: true, content: await readFile(file.path, "utf8") });
      } catch {
        backups.push({ path: file.path, existed: false, content: "" });
      }
    }
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }
  return backups;
}

/** Restores the previous content of each backed-up file, or deletes it if it did not exist before. Best-effort: a restoration failure must never fail the end of the task. */
async function restoreFiles(backups: readonly FileBackup[]): Promise<void> {
  for (const backup of backups) {
    try {
      if (backup.existed) await writeFile(backup.path, backup.content, "utf8");
      else await unlink(backup.path);
    } catch {
      // Deliberately ignored: see the function's documentation.
    }
  }
}

async function runWithFiles(options: RunOptions, startedAt: number): Promise<RunResult> {
  const { agent, plan, paths, taskId, timeoutMs, signal, onEvent, onSpawn } = options;

  await mkdir(dirname(paths.rawLog), { recursive: true });
  const rawLog = createWriteStream(paths.rawLog, { flags: "w" });

  let seq = 0;
  let finalText: string | undefined;
  let eventCount = 0;

  async function emit(partial: PartialEvent): Promise<void> {
    const event = toCaesarEvent(taskId, seq++, partial);
    eventCount++;
    await appendEvent(paths, event);
    safeOnEvent(onEvent, event);
  }

  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  if (child.pid !== undefined) await safeOnSpawn(onSpawn, child.pid);

  await emit({ type: "started", agent: agent.id, command: [plan.command, ...plan.args].join(" ") });

  if (plan.stdin !== undefined) child.stdin?.write(plan.stdin);
  child.stdin?.end();

  // Each output line triggers asynchronous processing (translation +
  // journal write): they are serialized onto a promise chain so as to
  // never reorder events nor leave in-flight processing behind
  // when the stream ends.
  let chain: Promise<void> = Promise.resolve();

  const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const stdoutClosed = new Promise<void>((resolve) => {
    stdoutRl.on("line", (line) => {
      chain = chain.then(async () => {
        rawLog.write(line + "\n");
        const { events, finalText: text } = agent.translate(line);
        if (text !== undefined && text.trim() !== "") finalText = text;
        for (const partial of events) await emit(partial);
      });
    });
    stdoutRl.once("close", () => resolve());
  });

  const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  const stderrClosed = new Promise<void>((resolve) => {
    stderrRl.on("line", (line) => {
      chain = chain.then(async () => {
        rawLog.write(line + "\n");
      });
    });
    stderrRl.once("close", () => resolve());
  });

  let timedOut = false;
  let aborted = false;
  let hardKillTimer: NodeJS.Timeout | undefined;

  function terminate(): void {
    child.kill("SIGTERM");
    hardKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  function onAbort(): void {
    aborted = true;
    terminate();
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, sig) => resolve({ code, signal: sig }));
  });

  // The child has exited: no more orphan risk from here on. We can
  // disarm the timers and wait for the processing of the last
  // lines already emitted by the streams to finish.
  clearTimeout(timeoutTimer);
  clearTimeout(hardKillTimer);
  signal?.removeEventListener("abort", onAbort);

  await Promise.all([stdoutClosed, stderrClosed]);
  await chain;

  await new Promise<void>((resolve) => rawLog.end(resolve));

  if (spawnError) {
    await emit({ type: "error", message: spawnError.message, fatal: true });
  } else if (aborted) {
    await emit({ type: "error", message: "Task cancelled before execution finished.", fatal: true });
  } else if (timedOut) {
    await emit({ type: "error", message: `Timeout exceeded (${timeoutMs} ms).`, fatal: true });
  } else {
    await emit({
      type: "finished",
      status: closed.code === 0 ? "success" : "failed",
      summary: "",
      exit_code: closed.code,
    });
  }

  return {
    exitCode: closed.code,
    signal: closed.signal,
    timedOut,
    aborted,
    finalText,
    eventCount,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Invokes `onEvent` without ever letting an exception it throws bubble
 * up to the caller: the very first event (`started`) is emitted before
 * the timeout timer and the abort listener are even in place —
 * a display callback breaking at that instant must not turn a
 * presentation problem into an orphan sub-process.
 */
function safeOnEvent(onEvent: RunOptions["onEvent"], event: CaesarEvent): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    // Deliberately ignored: see the function's documentation.
  }
}

/**
 * Invokes `onSpawn` without ever letting an exception (synchronous or in the
 * promise it returns) bubble up to the caller — same risk profile
 * as `safeOnEvent`: a callback broken at that precise instant
 * would otherwise leave the already-launched sub-process orphaned, unable to
 * reach the rest of the function that drives it.
 */
async function safeOnSpawn(onSpawn: RunOptions["onSpawn"], pid: number): Promise<void> {
  if (!onSpawn) return;
  try {
    await onSpawn(pid);
  } catch {
    // Deliberately ignored: see the function's documentation.
  }
}

/** Completes a partial event with the common fields (protocol, seq, timestamp, task). */
function toCaesarEvent(taskId: string, seq: number, partial: PartialEvent): CaesarEvent {
  const { type, ...fields } = partial;
  // `makeEvent` is generic over one precise type of the union; `partial`
  // carries a type already narrowed to that same union without the common
  // fields (`PartialEvent`, distributed variant by variant on the registry
  // side). Casting it here to `never` shifts the correspondence guarantee
  // onto the typing of `PartialEvent` itself rather than losing it again in
  // a generic inference that cannot be made from a value of
  // union type.
  return makeEvent(taskId, seq, type, fields as never);
}
