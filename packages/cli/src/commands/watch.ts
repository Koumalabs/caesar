/**
 * `caesar watch`: watching the sub-agents work.
 *
 * `caesar ps` is a snapshot, `caesar logs --follow` follows one task whose
 * identifier one must already know. When three delegations run in parallel,
 * nothing showed them together.
 *
 * Nothing daemon-like is needed for that: the engine writes `events.jsonl`
 * line by line **during** execution (`spawn.ts`) and publishes task state
 * via atomic `rename`/`link` (`store.ts`). This command only reads what
 * other processes write — the same property that makes `caesar cancel` by
 * pid and the `max_parallel` slots work.
 *
 * Two renderings, depending on the destination:
 *
 * - **terminal** — alternate screen, redrawn frame, an overview;
 * - **outside a terminal** (redirected, `| tee`, tests) — one line per
 *   event, without ANSI or redraw. It is the rule `colorEnabled` already
 *   applies to colors, extended to redrawing: captured output must stay
 *   readable and diffable.
 *
 * Watching modifies nothing: no interaction beyond `q`/Ctrl-C to exit.
 */
import type { PendingQuestion } from "@caesar/mcp-channel";
import { listPendingQuestions } from "@caesar/mcp-channel";
import type { CaesarEvent } from "@caesar/protocol";
import { EventSchema, taskPaths } from "@caesar/protocol";
import type { ActivityState, TaskRecord, TaskStatus } from "@caesar/core";
import { describeActivity, emptyActivity, fileTaskStore, foldActivity, formatDuration, loadConfig, readableMessage } from "@caesar/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, activeGlyphs, colorize, printError, terminalWidth, writeLine } from "../output.js";
import { createLineTail } from "../tail.js";
import type { LineTail } from "../tail.js";

/** Redraw cadence. Short enough to feel alive, long enough to cost nothing. */
const POLL_MS = 200;

/** How long a finished task stays displayed, and how many we keep. */
const RECENT_MS = 5 * 60_000;
const RECENT_MAX = 5;

const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];

function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Enough to designate a task without occupying half the line. */
function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (width <= 1) return "";
  return flat.length <= width ? flat : flat.slice(0, width - 1) + "…";
}

export interface WatchOptions {
  json?: boolean;
  /** A single frame, then exit — for a script or a test. */
  once?: boolean;
}

interface Tracked {
  record: TaskRecord;
  state: ActivityState;
  tail: LineTail;
  questions: readonly PendingQuestion[];
  /** Instant when the end was observed, to make it disappear after a while. */
  endedSeenAt?: number;
  /** Journal lines we could not re-read: counted rather than silenced. */
  unreadable: number;
}

/**
 * Reads a task's new journal lines and folds them.
 *
 * An unreadable line is counted, not reported on screen: a monitor that
 * yells on every line becomes unusable. The total, however, is displayed in
 * the frame's footer — a mismatch between what the engine writes and what
 * this CLI knows how to read must not get lost in silence.
 */
async function pump(tracked: Tracked): Promise<CaesarEvent[]> {
  const fresh: CaesarEvent[] = [];
  for (const line of await tracked.tail.read()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      tracked.unreadable += 1;
      continue;
    }
    const result = EventSchema.safeParse(parsed);
    if (!result.success) {
      tracked.unreadable += 1;
      continue;
    }
    fresh.push(result.data);
    tracked.state = foldActivity(tracked.state, result.data);
  }
  return fresh;
}

/** One line per event, for the outside-a-terminal rendering. */
function describeEventLine(record: TaskRecord, event: CaesarEvent): string | undefined {
  const prefix = `${shortId(record.id)} ${record.agent}`;
  switch (event.type) {
    case "started":
      return `${prefix}  started`;
    case "tool_use":
      return `${prefix}  ${event.status === "started" ? "▸" : event.status === "succeeded" ? "✓" : "✗"} ${event.tool || "tool"}${event.input_summary ? ` ${event.input_summary}` : ""}`;
    case "file_changed":
      return `${prefix}  ~ ${event.action} ${event.path}`;
    case "message":
      // Same treatment as the overview and as `caesar run`: codex's
      // `agent_message` are serialized JSON reports.
      return `${prefix}  “${readableMessage(event.text).replace(/\s+/g, " ").trim()}”`;
    case "thinking":
      return `${prefix}  … ${event.text.replace(/\s+/g, " ").trim()}`;
    case "progress":
      return `${prefix}  · ${event.message}`;
    case "question":
      return `${prefix}  ? ${event.question}`;
    case "answer":
      return `${prefix}  ! ${event.answer}`;
    case "error":
      return `${prefix}  ⚠ ${event.message}`;
    case "finished":
      return `${prefix}  finished — ${event.status}`;
  }
}

/** The full frame, as lines ready to write. */
function renderFrame(tracked: readonly Tracked[], maxParallel: number, now: number, width: number, io: Io): string[] {
  const active = tracked.filter((t) => isActive(t.record.status));
  const recent = tracked.filter((t) => !isActive(t.record.status)).slice(-RECENT_MAX);
  const lines: string[] = [];

  const g = activeGlyphs().status;
  const time = new Date(now).toTimeString().slice(0, 8);
  const title = `${g.mark} caesar ${g.bullet} watch`;
  const count = `${active.length} active ${g.bullet} max_parallel ${maxParallel}`;
  const left = `${title}   ${count}`;
  lines.push(
    colorize(title, "title", io.stdout) +
      "   " +
      colorize(count, "dim", io.stdout) +
      " ".repeat(Math.max(1, width - left.length - time.length)) +
      colorize(time, "faint", io.stdout),
  );
  lines.push("");

  if (active.length === 0) {
    lines.push(colorize("No task in progress. The window stays open.", "dim", io.stdout));
    lines.push("");
  }

  for (const t of active) {
    const { headline, silentMs, stalled } = describeActivity(t.state, now);
    const age = t.record.started_at ? formatDuration(now - Date.parse(t.record.started_at)) : "—";
    const bullet = stalled ? colorize(g.stalled, "warn", io.stdout) : colorize(g.running, "accent", io.stdout);

    const header = `${shortId(t.record.id)}  ${t.record.agent.padEnd(12)} ${(t.record.role ?? "—").padEnd(12)} ${age.padStart(6)}  ${t.record.isolation} ${g.bullet} ${t.record.mode}`;
    lines.push(`${bullet} ${clip(header, width - 2)}`);
    lines.push(`  ${colorize(clip(t.record.objective, width - 2), "dim", io.stdout)}`);

    // A pending question takes precedence over everything: a sub-agent
    // waiting for an answer looks exactly like a stuck sub-agent, and is
    // not at all the same thing.
    if (t.questions.length > 0) {
      const q = t.questions[0];
      const rest = t.questions.length > 1 ? ` (+${t.questions.length - 1})` : "";
      lines.push(`  ${colorize(clip(`${g.question} ${q?.question ?? ""}${rest}`, width - 2), "warn", io.stdout)}`);
      // No CLI command answers today: `caesar_answer` is an MCP tool, so
      // the gesture belongs to the main agent. Say it rather than suggest a
      // `caesar answer` that does not exist.
      lines.push(`  ${colorize(`waiting for an answer — the main agent answers via caesar_answer (id ${q?.id ?? ""})`, "dim", io.stdout)}`);
    } else {
      lines.push(`  ${clip(headline, width - 2)}`);
    }

    const counters: string[] = [];
    if (t.state.filesTouched.length > 0) counters.push(`${g.file} ${t.state.filesTouched.length} file(s)`);
    counters.push(`${t.state.eventCount} event(s)`);
    if (t.unreadable > 0) counters.push(`${t.unreadable} unreadable line(s)`);
    if (stalled) counters.push(colorize(`silence ${formatDuration(silentMs)}`, "warn", io.stdout));
    lines.push(`  ${colorize(counters.join(`  ${g.bullet}  `), "dim", io.stdout)}`);
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push(colorize("Recently finished", "dim", io.stdout));
    for (const t of recent) {
      const ended = t.record.ended_at ? `${formatDuration(now - Date.parse(t.record.ended_at))} ago` : "";
      const ok = t.record.status === "succeeded" && t.record.report_status === "success";
      const mark = colorize(ok ? g.done : g.failed, ok ? "ok" : "bad", io.stdout);
      lines.push(
        `  ${mark} ${clip(`${shortId(t.record.id)}  ${t.record.agent}  ${t.record.status} / report ${t.record.report_status ?? "—"}   ${ended}`, width - 4)}`,
      );
    }
    lines.push("");
  }

  lines.push(colorize("q or Ctrl-C to quit — watching modifies nothing.", "dim", io.stdout));
  return lines;
}

/** True when the output is a real terminal: the only case where redrawing makes sense. */
function isTty(io: Io): boolean {
  return Boolean((io.stdout as { isTTY?: boolean }).isTTY);
}

export async function runWatch(root: string, ids: readonly string[], options: WatchOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const store = fileTaskStore(root);
  const wanted = new Set(ids);

  if (wanted.size > 0) {
    const unknownIds: string[] = [];
    for (const id of wanted) if ((await store.get(id)) === null) unknownIds.push(id);
    if (unknownIds.length > 0) {
      printError(io, `Unknown task(s): ${unknownIds.join(", ")}.`);
      return EXIT_USAGE;
    }
  }

  const tracked = new Map<string, Tracked>();
  const redraw = isTty(io) && !options.json && !options.once;

  /** Updates the list of followed tasks, folds the new events, and returns them. */
  async function step(now: number): Promise<{ tracked: Tracked[]; fresh: { record: TaskRecord; event: CaesarEvent }[] }> {
    for (const record of await store.list()) {
      if (wanted.size > 0 && !wanted.has(record.id)) continue;
      const known = tracked.get(record.id);
      if (known) {
        known.record = record;
        if (!isActive(record.status) && known.endedSeenAt === undefined) known.endedSeenAt = now;
        continue;
      }
      // A task already finished before we started watching is only picked
      // up if its end is recent: without this bound, opening the window
      // would scroll through the project's entire history.
      const ended = record.ended_at ? Date.parse(record.ended_at) : undefined;
      if (!isActive(record.status) && (ended === undefined || now - ended > RECENT_MS)) continue;
      tracked.set(record.id, {
        record,
        state: emptyActivity(),
        tail: createLineTail(taskPaths(record.task_dir).eventsPath),
        questions: [],
        ...(isActive(record.status) ? {} : { endedSeenAt: now }),
        unreadable: 0,
      });
    }

    // A task finished long enough ago stops occupying the screen.
    for (const [id, t] of tracked) {
      if (t.endedSeenAt !== undefined && now - t.endedSeenAt > RECENT_MS) tracked.delete(id);
    }

    const fresh: { record: TaskRecord; event: CaesarEvent }[] = [];
    for (const t of tracked.values()) {
      for (const event of await pump(t)) fresh.push({ record: t.record, event });
      t.questions = isActive(t.record.status) ? await listPendingQuestions(taskPaths(t.record.task_dir).dir) : [];
    }

    const ordered = [...tracked.values()].sort((a, b) => a.record.created_at.localeCompare(b.record.created_at));
    return { tracked: ordered, fresh };
  }

  const restore = redraw ? enterAltScreen(io) : undefined;
  const stop = new AbortController();
  const onSigint = (): void => stop.abort();
  process.on("SIGINT", onSigint);
  const releaseKeys = redraw ? listenForQuit(() => stop.abort()) : undefined;

  try {
    for (;;) {
      const now = Date.now();
      const { tracked: ordered, fresh } = await step(now);

      if (options.json) {
        // NDJSON: one object per line, not `printJson`'s indentation —
        // this is a stream meant to be consumed as it flows, not re-read.
        for (const { event } of fresh) writeLine(io.stdout, JSON.stringify(event));
      } else if (redraw) {
        io.stdout.write("\x1b[H\x1b[2J" + renderFrame(ordered, config.policy.max_parallel, now, terminalWidth(io.stdout), io).join("\n") + "\n");
      } else if (options.once) {
        for (const line of renderFrame(ordered, config.policy.max_parallel, now, terminalWidth(io.stdout), io)) writeLine(io.stdout, line);
      } else {
        for (const { record, event } of fresh) {
          const line = describeEventLine(record, event);
          if (line) writeLine(io.stdout, line);
        }
      }

      if (options.once || stop.signal.aborted) return EXIT_OK;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (stop.signal.aborted) return EXIT_OK;
    }
  } finally {
    process.off("SIGINT", onSigint);
    releaseKeys?.();
    restore?.();
  }
}

/**
 * Switches to the alternate screen and hides the cursor; returns what it
 * takes to put everything back.
 *
 * The restoration is also hooked on `exit`: a monitor that leaves the
 * terminal on the alternate screen or without a cursor after a hard stop is
 * worse than no monitor, and a `finally` does not cover every process exit
 * path.
 */
function enterAltScreen(io: Io): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    io.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  io.stdout.write("\x1b[?1049h\x1b[?25l");
  process.once("exit", restore);
  return restore;
}

/**
 * Listens for "q" on standard input, when it is a terminal.
 *
 * Raw mode is restored in every case — it is the setting that, left in
 * place, makes the shell unusable afterwards.
 */
function listenForQuit(onQuit: () => void): () => void {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return () => {};

  const onData = (chunk: Buffer): void => {
    const key = chunk.toString("utf8");
    // Ctrl-C included: in raw mode, it is no longer turned into SIGINT.
    if (key === "q" || key === "\u0003") onQuit();
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    stdin.setRawMode?.(false);
    stdin.pause();
  };
}
