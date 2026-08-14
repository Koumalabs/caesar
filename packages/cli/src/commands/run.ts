/**
 * `caesar run`: resolves the root → loads the config → resolves the
 * delegation (role/agent/mode/isolation/policy/timeout/context, via
 * `resolveDelegation` from `@caesar/core`) → `runTask`. See the brief for
 * the original sequence.
 *
 * The role → agent → policy resolution itself is no longer duplicated here:
 * `resolveDelegation` is the assembly point shared with `caesar_delegate`
 * (MCP server), see its header (`packages/core/src/delegation.ts`) and the
 * task 7 correction report. What remains specific to this file: validating
 * the *shape* of `--mode`/`--isolation` (raw strings coming from commander)
 * and resolving `--context @file` — two purely CLI refinements, which have
 * no place in a function shared with the MCP server (whose inputs are
 * already typed by its zod schema).
 *
 * `Ctrl-C` interrupts cleanly: an `AbortController` created here is passed
 * to `runTask` (`RunTaskInput.signal`, relayed all the way to
 * `runAgentProcess`, which already knows how to honor it — SIGTERM then,
 * absent a response, SIGKILL). The subprocess is thus explicitly signaled,
 * without depending on POSIX process grouping. Progress, in human mode, is
 * displayed as it happens via `RunTaskInput.onEvent` rather than re-read
 * afterwards. `taskId` is generated here (rather than by the engine) so
 * that the task directory is known from the call on — not strictly needed
 * for the live display (which goes through `onEvent`), but it is the same
 * contract the MCP server needs (asynchronous `caesar_delegate`, returning
 * an identifier immediately).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Isolation, CaesarEvent, TaskMode } from "@caesar/protocol";
import type { NetworkRequest, TaskOutcome } from "@caesar/core";
import { createSlotQueue, fileTaskStore, generateTaskId, loadConfig, nextDelegationDepth, readableMessage, resolveDelegation, runTask } from "@caesar/core";
import { ISOLATIONS, NETWORK_REQUEST_VALUES, TASK_MODES } from "../flags.js";
import type { Glyphs } from "@caesar/theme";
import type { Io, ThemeToken } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  activeGlyphs,
  colorize,
  printError,
  printJson,
  printWarning,
  sectionHeader,
  writeLine,
} from "../output.js";

export interface RunOptions {
  role?: string;
  agent?: string;
  mode?: string;
  isolation?: string;
  network?: string;
  timeout?: string;
  model?: string;
  context?: string;
  json?: boolean;
  channel?: boolean;
  /**
   * Raw arguments passed as-is to the agent's CLI, typed after "--". An
   * assumed escape hatch for what caesar does not expose yet: the engine
   * already carried them end to end, no facade opened them up.
   *
   * Deliberately absent from the `caesar_delegate` MCP tool: it is a
   * gesture the user types, not a latitude left to the orchestrator, which
   * could otherwise raise a sub-agent's privileges on its own.
   */
  extraArgs?: string[];
}

async function resolveContext(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw.startsWith("@")) {
    const path = resolve(process.cwd(), raw.slice(1));
    return await readFile(path, "utf8");
  }
  return raw;
}

/** A progress line, decomposed so that only the mark carries the color. */
export interface EventLine {
  /** The mark, taken from the current glyph set. */
  glyph: string;
  /** What it is about, in one word — column-aligned from one line to the next. */
  label: string;
  /** The theme role for the mark and the label. */
  token: ThemeToken;
  text: string;
  /** The theme role for the text itself. Absent: the text stays neutral. */
  textToken?: ThemeToken;
}

/** Width of the label column, so that the texts line up. */
const LABEL_WIDTH = 10;

/**
 * Progress, one line per event.
 *
 * `message` and `thinking` were missing: what the sub-agent *says* had
 * always been written to `events.jsonl` and displayed nowhere. On a task
 * that thinks for a long time between two tools, it was the only thing to
 * see, and it went unseen.
 *
 * Each line is flattened: antigravity emits one `message` per snippet of
 * text, newlines included, and one snippet per display line would scroll
 * the screen without teaching anything.
 *
 * The label replaces the original brackets (`[tool]`, `[agent]`): at fixed
 * width, the texts line up from one line to the next, and the column thus
 * formed scans at a glance where variable-length brackets forced reading
 * every line start.
 *
 * Exported to be exercised directly: the tests' fake agent does not emit
 * lines in a real CLI's format, so no end-to-end test would go through
 * these branches.
 */
export function describeEvent(event: CaesarEvent, glyphs: Glyphs = activeGlyphs()): EventLine | undefined {
  const g = glyphs.status;
  switch (event.type) {
    case "started":
      return { glyph: g.running, label: "start", token: "accent", text: `agent "${event.agent}"` };
    case "tool_use":
      // The name is empty when the agent does not carry it on the closing
      // event (claude's `tool_result` only has the call identifier).
      return {
        glyph: g.tool,
        label: "tool",
        token: "accent",
        text: `${event.tool || "(end)"}${event.input_summary ? ` — ${event.input_summary}` : ""} (${event.status})`,
      };
    case "file_changed":
      return { glyph: g.file, label: "file", token: "warn", text: `${event.action} ${event.path}` };
    case "progress":
      return { glyph: g.bullet, label: "progress", token: "dim", text: event.message, textToken: "dim" };
    case "message":
      // `readableMessage` rather than the raw text: codex's `agent_message`
      // are serialized JSON reports, unreadable as-is.
      return { glyph: g.speech, label: "agent", token: "dim", text: flatten(readableMessage(event.text)) };
    case "thinking":
      return { glyph: g.bullet, label: "thinking", token: "dim", text: flatten(event.text), textToken: "dim" };
    case "error":
      return { glyph: g.warn, label: "error", token: "bad", text: event.message, textToken: "bad" };
    default:
      return undefined;
  }
}

/**
 * Assembles a progress line.
 *
 * The mark and the label carry the color; **the agent's text stays
 * neutral**. That is what the palette says: main text inherits the
 * terminal's foreground, only what classifies it is colored. Tinting the
 * agent's speech would make it less readable than it is, without teaching
 * anything — it is already named by its label.
 */
export function formatEventLine(line: EventLine, io: Io): string {
  const mark = colorize(`${line.glyph} ${line.label.padEnd(LABEL_WIDTH)}`, line.token, io.stdout);
  const text = line.textToken ? colorize(line.text, line.textToken, io.stdout) : line.text;
  return `  ${mark} ${text}`;
}

/** A single line, without superfluous whitespace. Empty if the text carried none. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function runRun(root: string, objective: string, options: RunOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);

  // Deliberate precedence, pinned by a test (see run.test.ts): any *shape*
  // validation specific to the CLI (raw strings coming from commander, no
  // I/O nor configuration read required) exits before even attempting to
  // resolve role/agent via `resolveDelegation`. A `--mode bogus` is an
  // immediate usage error; it must not wait for the resolution of an
  // otherwise invalid `--role` to be reported. It was different before the
  // extraction of `resolveDelegation` (task 7) — the fallback onto these
  // same checks, then posterior to the role/agent resolution, stayed
  // without observable effect until the review flagged it.
  if (options.mode && !TASK_MODES.includes(options.mode as TaskMode)) {
    printError(io, `Invalid --mode (expected one of: ${TASK_MODES.join(", ")}).`);
    return EXIT_USAGE;
  }
  if (options.isolation && !ISOLATIONS.includes(options.isolation as Isolation | "auto")) {
    printError(io, `Invalid --isolation (expected one of: ${ISOLATIONS.join(", ")}).`);
    return EXIT_USAGE;
  }
  if (options.network && !NETWORK_REQUEST_VALUES.includes(options.network as NetworkRequest)) {
    printError(io, `Invalid --network (expected one of: ${NETWORK_REQUEST_VALUES.join(", ")}).`);
    return EXIT_USAGE;
  }
  // Same logic: the presence of an agent or of a role is a shape condition,
  // checkable without resolving anything. `resolveDelegation` carries its
  // own guard for its other callers (the MCP server, notably, whose
  // parameters are named "agent"/"role") with a generic wording; here, we
  // precede it to render the CLI's historical message, which names the
  // exact flags to type — lost silently during the extraction, restored by
  // the review.
  if (!options.agent && !options.role) {
    printError(io, "Specify --agent <id> or --role <name>.");
    return EXIT_USAGE;
  }

  let context: string | undefined;
  try {
    context = await resolveContext(options.context);
  } catch (error) {
    printError(io, `Cannot read --context: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  // Depth inherited from `$CAESAR_DEPTH` (+1): see C4 of the final review.
  // `caesar run` can itself run as the sub-agent of a previous delegation —
  // it is the only way for `max_depth`/the anti-recursion guard to apply
  // beyond the first level.
  const depth = nextDelegationDepth();

  const resolved = await resolveDelegation(config, root, {
    role: options.role,
    agent: options.agent,
    mode: options.mode as TaskMode | undefined,
    isolation: options.isolation as Isolation | "auto" | undefined,
    network: options.network as NetworkRequest | undefined,
    context,
    timeout: options.timeout,
    depth,
  });
  if ("error" in resolved) {
    printError(io, resolved.error);
    return EXIT_USAGE;
  }
  const { agentId, mode, isolation, allowInplaceWrite, network, networkWarning, timeoutMs, context: resolvedContext } = resolved;

  // After the error branch, and only in human mode: `--json` must carry
  // nothing but the final result on stdout.
  if (!options.json) sectionHeader(io, "run");

  const store = fileTaskStore(root);
  const taskId = generateTaskId();
  // The controller precedes the queue: waiting for a slot happens *before*
  // `runTask` is called, and Ctrl-C must be able to interrupt that too —
  // not only the task once launched.
  const controller = new AbortController();

  // Slots on disk rather than an in-memory semaphore: each `caesar run` is
  // a distinct process, and a per-process queue let six terminals launch
  // six agents whatever `max_parallel` said. The slots are shared by
  // everything that delegates under this root, MCP session included.
  const queue = createSlotQueue({
    root,
    limit: config.policy.max_parallel,
    label: `caesar run — ${objective.slice(0, 60)}`,
    signal: controller.signal,
    onWait: (holders) => {
      // A silent wait reads as a hang. Naming who holds the slots, and how
      // many there are, makes it understandable — and shows in the same
      // gesture which setting governs it.
      printWarning(
        io,
        `${holders.length} task(s) already running under this project (max_parallel = ${config.policy.max_parallel}) — waiting for a slot. Ctrl-C to give up.`,
      );
      for (const holder of holders) {
        printWarning(io, `  · pid ${holder.pid}${holder.label ? ` — ${holder.label}` : ""} (since ${holder.startedAt})`);
      }
    },
  });

  const onSigint = (): void => {
    printError(io, `Interruption requested: stopping task "${taskId}" (SIGTERM to the subprocess, SIGKILL if it does not respond)…`);
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  // In --json, the brief's instruction ("write only the final result to
  // stdout") rules out any live display: `onEvent` then stays silent, the
  // events are only useful as they happen in human mode.
  const glyphs = activeGlyphs();
  const onEvent = options.json
    ? undefined
    : (event: CaesarEvent): void => {
        const line = describeEvent(event, glyphs);
        if (line) writeLine(io.stdout, formatEventLine(line, io));
      };

  let outcome;
  try {
    outcome = await runTask(
      { store, root, queue },
      {
        agentId,
        objective,
        ...(resolvedContext !== undefined ? { context: resolvedContext } : {}),
        mode,
        isolation,
        allowInplaceWrite,
        network,
        ...(networkWarning !== undefined ? { networkWarning } : {}),
        workspace: root,
        ...(options.role ? { role: options.role } : {}),
        ...(options.model ? { model: options.model } : {}),
        timeoutMs,
        depth,
        extraAgents: config.agents,
        worktreeSetup: config.worktree,
        ...(options.extraArgs && options.extraArgs.length > 0 ? { extraArgs: options.extraArgs } : {}),
        taskId,
        signal: controller.signal,
        ...(onEvent ? { onEvent } : {}),
        ...(options.channel ? { channel: true } : {}),
      },
    );
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_RUNTIME;
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (options.json) {
    printJson(io, {
      task_id: outcome.record.id,
      status: outcome.record.status,
      report: outcome.report,
      report_source: outcome.source,
      changes_verified_by: outcome.record.changes_verified_by,
      diff: outcome.diff ? { files: outcome.diff.files, is_empty: outcome.diff.isEmpty } : undefined,
    });
    return exitCodeFor(outcome);
  }

  const g = glyphs.status;
  const succeeded = outcome.record.status === "succeeded" && outcome.report.status === "success";
  writeLine(io.stdout);
  writeLine(
    io.stdout,
    `${colorize(succeeded ? g.done : g.failed, succeeded ? "ok" : "bad", io.stdout)} ` +
      `Task ${outcome.record.id} — status: ${colorize(outcome.record.status, succeeded ? "ok" : "bad", io.stdout)} ` +
      colorize(`(report "${outcome.report.status}" via "${outcome.source}")`, "dim", io.stdout),
  );
  writeLine(io.stdout, `  ${outcome.report.summary}`);

  if (outcome.diff && !outcome.diff.isEmpty) {
    writeLine(io.stdout);
    writeLine(io.stdout, colorize("Modified files (according to git)", "dim", io.stdout));
    for (const change of outcome.diff.files) {
      writeLine(io.stdout, `  ${colorize(g.file, "warn", io.stdout)} ${change.action} ${change.path}`);
    }
  }
  if (outcome.report.findings.length > 0) {
    writeLine(io.stdout);
    writeLine(io.stdout, colorize("Findings", "dim", io.stdout));
    for (const finding of outcome.report.findings) {
      const severe = finding.severity === "high" || finding.severity === "critical";
      writeLine(
        io.stdout,
        `  ${colorize(g.warn, severe ? "bad" : "warn", io.stdout)} ` +
          `${colorize(`[${finding.severity}]`, severe ? "bad" : "warn", io.stdout)} ` +
          `${finding.title}${finding.file ? colorize(` (${finding.file})`, "dim", io.stdout) : ""}`,
      );
    }
  }
  if (outcome.record.isolation === "worktree") {
    writeLine(io.stdout);
    writeLine(
      io.stdout,
      colorize(
        `Isolated in a worktree: "caesar diff ${outcome.record.id}" to see the diff, "caesar apply ${outcome.record.id}" to integrate it.`,
        "dim",
        io.stdout,
      ),
    );
  }

  return exitCodeFor(outcome);
}

/**
 * Crosses the process status (`record.status`) with the one the agent
 * declared in its report (`report.status`) — see I3 of the final review:
 * `record.status === "succeeded"` alone only says "the process exited with
 * code 0", not "the agent succeeded at its mission". An agent that writes
 * `{"status":"failed"}` then exits with code 0 used to hand exit code 0 to
 * an automation chaining on `caesar run` — a success conclusion on a task
 * the agent itself declares `failed`/`partial`/`blocked`.
 */
function exitCodeFor(outcome: TaskOutcome): number {
  return outcome.record.status === "succeeded" && outcome.report.status === "success" ? EXIT_OK : EXIT_RUNTIME;
}
