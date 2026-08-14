/**
 * What a task is currently doing, folded from its event log.
 *
 * A pure function, in the spirit of `policy.ts` and `network.ts`: no I/O,
 * and every output carries a readable sentence rather than a raw state for
 * the caller to interpret.
 *
 * **A fold, not a re-read.** The caller keeps one `ActivityState` per task
 * and pushes events into it as they arrive: `caesar watch` re-reads
 * `events.jsonl` by offset and only parses the new lines. Re-reading the
 * whole log on every frame would cost, for a chatty task followed for ten
 * minutes, re-parsing thousands of lines five times per second.
 */
import type { CaesarEvent, ReportStatus } from "@caesar/protocol";

/** Beyond this, a silence deserves to be flagged rather than merely counted. */
export const STALL_MS = 30_000;

/**
 * Maximum length of the speech kept. Fragments accumulate — antigravity
 * emits one `message` per snippet — and only the end is of interest.
 */
const SPEECH_MAX = 400;

/**
 * Cap on the number of tools considered open. An adapter that announced
 * starts without ever closing them would otherwise grow this list
 * indefinitely; the oldest one gives up its place.
 */
const RUNNING_TOOLS_MAX = 8;

export interface RunningTool {
  /** Call identifier given by the agent, empty if it provides none. */
  id: string;
  tool: string;
  summary: string;
  /** ISO timestamp of the opening. */
  since: string;
}

export interface ActivityState {
  eventCount: number;
  /** ISO timestamp of the last event, whatever its type. */
  lastAt?: string;
  /** Actual execution start, as the log dates it. */
  startedAt?: string;
  runningTools: readonly RunningTool[];
  /** Paths touched, in order of appearance, without duplicates. */
  filesTouched: readonly string[];
  /** The last tool closed, to say what just finished. */
  lastTool?: { tool: string; summary: string; ok: boolean };
  /** The agent's speech, consecutive fragments glued back together. */
  speech: string;
  /**
   * Was the last folded event a `message`? Serves only the gluing of
   * `speech`: two fragments that follow each other form one sentence, two
   * fragments separated by a tool are two sentences.
   */
  lastEventWasMessage?: boolean;
  lastProgress?: string;
  lastError?: string;
  /** Set as soon as the agent announces its end, with the status it declares. */
  finished?: ReportStatus;
}

export function emptyActivity(): ActivityState {
  return { eventCount: 0, runningTools: [], filesTouched: [], speech: "" };
}

/**
 * The text a human wants to read from a `message`.
 *
 * codex does not send prose: each of its `agent_message` is a serialized
 * `caesar.report/v1` report. Displayed as-is, it is a wall of JSON where a
 * sentence is expected. When the message is a JSON object carrying a
 * `summary`, that is what speaks.
 *
 * Exported because `caesar run` displays the same messages as they stream
 * and suffered exactly the same wall of JSON: one treatment, not two that
 * would drift apart.
 */
export function readableMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const summary = (parsed as Record<string, unknown>)["summary"];
      if (typeof summary === "string" && summary !== "") return summary;
    }
  } catch {
    // Not JSON despite the brace: it is prose, we keep it as-is.
  }
  return text;
}

/** Keeps the end of `text`, the only part still fresh, under `SPEECH_MAX`. */
function clampSpeech(text: string): string {
  return text.length <= SPEECH_MAX ? text : `…${text.slice(-SPEECH_MAX)}`;
}

/**
 * Removes from `running` the call that this event closes.
 *
 * Three matches, from surest to most approximate. The identifier first: it
 * is the only one that distinguishes two successive executions of the same
 * command, and the only one available for claude, whose closing does not
 * carry the tool name (see `CaesarEvent.id`). Failing that, the (name,
 * summary) pair. Failing that again, the oldest call of the same tool.
 */
function closeTool(running: readonly RunningTool[], id: string, tool: string, summary: string): RunningTool[] {
  const byId = id !== "" ? running.findIndex((t) => t.id === id) : -1;
  const byPair = byId >= 0 ? byId : running.findIndex((t) => t.tool === tool && t.summary === summary);
  const index = byPair >= 0 ? byPair : running.findIndex((t) => t.tool === tool);
  if (index < 0) return [...running];
  return [...running.slice(0, index), ...running.slice(index + 1)];
}

/**
 * Folds an event into the current state. Never modifies `state`: always
 * returns a new state, so a caller can compare it to the previous one
 * (React, display memoization) without surprise.
 */
export function foldActivity(state: ActivityState, event: CaesarEvent): ActivityState {
  const next: ActivityState = { ...state, eventCount: state.eventCount + 1, lastAt: event.at };

  switch (event.type) {
    case "started":
      next.startedAt = event.at;
      break;

    case "message": {
      const text = readableMessage(event.text);
      // Consecutive `message` events get glued back together — antigravity
      // emits one per snippet of text, and one line per fragment does not
      // read. Any other event type closes the paragraph: speech following a
      // tool is a new sentence, not the continuation of the previous one.
      const glue = state.lastEventWasMessage === true ? state.speech : "";
      next.speech = clampSpeech(glue + text);
      break;
    }

    case "thinking":
      next.speech = clampSpeech(event.text);
      break;

    case "tool_use":
      if (event.status === "started") {
        const opened: RunningTool = { id: event.id, tool: event.tool, summary: event.input_summary, since: event.at };
        const running = [...state.runningTools, opened];
        next.runningTools = running.length > RUNNING_TOOLS_MAX ? running.slice(-RUNNING_TOOLS_MAX) : running;
      } else {
        const closing = state.runningTools.find(
          (t) => (event.id !== "" && t.id === event.id) || (t.tool === event.tool && t.summary === event.input_summary),
        );
        next.runningTools = closeTool(state.runningTools, event.id, event.tool, event.input_summary);
        // The name comes from the opening when the closing does not carry
        // it — the case of claude, whose `tool_result` has only the id.
        next.lastTool = {
          tool: event.tool !== "" ? event.tool : (closing?.tool ?? "tool"),
          summary: event.input_summary !== "" ? event.input_summary : (closing?.summary ?? ""),
          ok: event.status === "succeeded",
        };
      }
      break;

    case "file_changed":
      if (!state.filesTouched.includes(event.path)) next.filesTouched = [...state.filesTouched, event.path];
      break;

    case "progress":
      next.lastProgress = event.message;
      break;

    case "error":
      next.lastError = event.message;
      break;

    case "finished":
      next.finished = event.status;
      next.runningTools = [];
      break;

    case "question":
    case "answer":
      break;
  }

  next.lastEventWasMessage = event.type === "message";
  return next;
}

/** What should be displayed of a task, at this instant. */
export interface ActivityDescription {
  /** One line: what the task is doing now. */
  headline: string;
  /** How long since anything last arrived. */
  silentMs: number;
  /** True when that silence is long enough to deserve being flagged. */
  stalled: boolean;
}

/** "2m14s", "47s" — short duration, without superfluous units. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The sentence describing the present instant.
 *
 * The order of precedence is that of information: a tool still open says
 * more than the agent's last words ("▸ shell npm test, 12s" situates the
 * task, a general sentence does not), and a recent error takes precedence
 * over everything once nothing is running anymore. When there is nothing to
 * say, we say so — the silence and its duration are themselves information,
 * the only thing that distinguishes a stuck task from a working one.
 */
export function describeActivity(state: ActivityState, now: number): ActivityDescription {
  const silentMs = state.lastAt === undefined ? 0 : Math.max(0, now - Date.parse(state.lastAt));
  const stalled = state.lastAt !== undefined && silentMs > STALL_MS;

  const headline = ((): string => {
    if (state.finished !== undefined) return `finished — report "${state.finished}"`;

    const [tool] = state.runningTools;
    if (tool) {
      const age = formatDuration(now - Date.parse(tool.since));
      const others = state.runningTools.length > 1 ? ` (+${state.runningTools.length - 1})` : "";
      return `▸ ${tool.tool}${tool.summary ? ` ${tool.summary}` : ""} — ${age}${others}`;
    }

    if (state.lastError !== undefined) return `⚠ ${state.lastError}`;
    if (state.speech !== "") return `“${state.speech}”`;
    if (state.lastTool) return `${state.lastTool.ok ? "✓" : "✗"} ${state.lastTool.tool} ${state.lastTool.summary}`.trimEnd();
    if (state.lastProgress !== undefined) return state.lastProgress;
    if (state.eventCount === 0) return "no events yet";
    return "no news";
  })();

  return { headline, silentMs, stalled };
}
