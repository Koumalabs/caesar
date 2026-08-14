import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENV, PROTOCOL_VERSION, REPORT_PROTOCOL } from "./version.js";
import { TaskSchema, type Task } from "./task.js";
import { ReportSchema, type Report } from "./report.js";
import { EventSchema, type CaesarEvent } from "./event.js";

export interface TaskPaths {
  dir: string;
  taskFile: string;
  reportPath: string;
  eventsPath: string;
  rawLog: string;
}

/** Normalized layout of a task directory. */
export function taskPaths(taskDir: string): TaskPaths {
  return {
    dir: taskDir,
    taskFile: join(taskDir, "task.json"),
    reportPath: join(taskDir, "report.json"),
    eventsPath: join(taskDir, "events.jsonl"),
    rawLog: join(taskDir, "raw.log"),
  };
}

/**
 * A sub-agent's environment variables. This is the minimal contract: an
 * outside agent that can read `$CAESAR_TASK_FILE` and write `$CAESAR_REPORT_PATH`
 * is orchestrable, without knowing anything about this implementation.
 */
export function taskEnv(task: Task, paths: TaskPaths): Record<string, string> {
  return {
    [ENV.taskDir]: paths.dir,
    [ENV.taskFile]: paths.taskFile,
    [ENV.reportPath]: paths.reportPath,
    [ENV.eventsPath]: paths.eventsPath,
    [ENV.taskId]: task.id,
    [ENV.agent]: task.agent,
    [ENV.depth]: String(task.depth),
    [ENV.protocolVersion]: PROTOCOL_VERSION,
  };
}

export async function writeTask(paths: TaskPaths, task: Task): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.taskFile, JSON.stringify(task, null, 2) + "\n", "utf8");
}

export async function readTask(paths: TaskPaths): Promise<Task> {
  const raw = await readFile(paths.taskFile, "utf8");
  return TaskSchema.parse(JSON.parse(raw));
}

export async function appendEvent(paths: TaskPaths, event: CaesarEvent): Promise<void> {
  await mkdir(dirname(paths.eventsPath), { recursive: true });
  await appendFile(paths.eventsPath, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Reads the log back, skipping unreadable lines: a partially corrupted log
 * remains more useful than an error.
 */
export async function readEvents(paths: TaskPaths): Promise<CaesarEvent[]> {
  let raw: string;
  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch {
    return [];
  }
  const events: CaesarEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = EventSchema.safeParse(safeJsonParse(line));
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/**
 * Collapses every `null` back to an absent field, recursively.
 *
 * The standard says "optional = absent", but native structured outputs impose
 * the opposite: their strict mode requires `required` to cover every
 * property, so an optional field is declared nullable there and comes back
 * filled with an explicit `null` (see `strictReportJsonSchema` in
 * `jsonschema.ts`). Without this normalization, a perfectly legitimate
 * `"usage": null` would fail the validation of an otherwise impeccable
 * report, and the orchestrator would fall back to a degraded tier for
 * nothing.
 *
 * Arrays are traversed but their elements kept as-is: a `null` there is a
 * value, not an omitted field.
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    out[key] = dropNulls(item);
  }
  return out;
}

/** Validates a report, whatever its origin. */
export function parseReport(value: unknown): Report {
  return ReportSchema.parse(dropNulls(value));
}

/** Reads `report.json` if it exists and if it conforms. */
export async function readReport(paths: TaskPaths): Promise<Report | null> {
  try {
    const raw = await readFile(paths.reportPath, "utf8");
    const parsed = ReportSchema.safeParse(dropNulls(safeJsonParse(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeReport(paths: TaskPaths, report: Report): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/**
 * Last resort: recovering a report drowned in an agent's text output.
 *
 * We first look for an explicitly fenced block, then, failing that, any JSON
 * object in the text that declares itself a report. The scan follows the
 * braces while accounting for strings and escapes, so as not to be fooled
 * by a brace inside a string.
 */
export function extractReportFromText(text: string): Report | null {
  const candidates: string[] = [];

  // Fenced code blocks: ```json caesar:report, ```caesar:report, ```json …
  const fence = /```[ \t]*(?:json)?[ \t]*(?:caesar:report)?[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1];
    if (body && body.includes(REPORT_PROTOCOL)) candidates.push(body);
  }

  // Raw JSON objects containing the protocol marker.
  for (const start of markerObjectStarts(text)) {
    const obj = readBalancedObject(text, start);
    if (obj) candidates.push(obj);
  }

  // The last valid report wins: an agent that corrects itself has the last word.
  for (const candidate of candidates.reverse()) {
    const parsed = ReportSchema.safeParse(dropNulls(safeJsonParse(candidate)));
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Plausible object-opening positions, walked back from each marker found —
 * see I1 of the final review. Keeping only the first `{` encountered
 * backwards lost a perfectly valid report as soon as a nested object
 * preceded the `protocol` field in the same object (e.g. `changes[0]`
 * before `protocol`, at the end of a report): it was then the brace of
 * that nested object that got picked, never the report's own. All the
 * opening positions before each marker are therefore collected, to be
 * tried from nearest to farthest by `extractReportFromText` — the order of
 * the return value below is deliberately inverted (farthest first):
 * `extractReportFromText` reads its candidates back through `.reverse()`
 * so that the last occurrence of the marker wins (an agent that corrects
 * itself has the last word); stacking them here from farthest to nearest
 * is what makes the candidates of a single occurrence come out from
 * nearest to farthest after that global `reverse()`, without losing the
 * order between occurrences.
 */
function markerObjectStarts(text: string): number[] {
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const marker = text.indexOf(REPORT_PROTOCOL, from);
    if (marker === -1) break;
    from = marker + REPORT_PROTOCOL.length;
    const forThisMarker: number[] = [];
    for (let i = marker; i >= 0; i--) {
      if (text[i] === "{") forThisMarker.push(i);
    }
    starts.push(...forThisMarker.reverse());
  }
  return starts;
}

function readBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
