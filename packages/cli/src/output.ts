/**
 * Formatting shared by all the subcommands: banners, tables, colors,
 * `--json`, and the stdout/stderr separation.
 *
 * Each command receives an `Io` rather than writing directly to
 * `process.stdout`/`process.stderr`: that is what lets the tests call the
 * command functions directly, with captured output, without ever spawning a
 * subprocess (see the task 6 brief).
 *
 * ## The three channels
 *
 * A single command writes to three very different recipients, and this
 * module is where the distinction is made once and for all:
 *
 *  1. **`--json`** — an agent, or a script. The JSON, nothing else: never
 *     an ANSI sequence, never a banner, never a stray line on `stdout`.
 *     Errors and warnings go to `stderr`.
 *  2. **Outside a terminal** (pipe, redirection, tests) — a human who will
 *     read later, or a test. The **structure** is rendered (banners, boxes,
 *     headers), the **color** is not: it would have no recipient, and it
 *     would make the output impossible to compare.
 *  3. **Terminal** — structure and color.
 *
 * Rule 2 is what makes the theme testable: a test captures a stream without
 * `isTTY`, so it sees exactly the structure and never the colors. To
 * exercise the colors themselves, it sets `isTTY = true` on the captured
 * stream.
 */
import type { ColorDepth, Glyphs } from "@caesar/theme";
import {
  ACCENT,
  BAD,
  BORDER,
  DIM,
  FAINT,
  OK,
  WARN,
  detectColorDepth,
  glyphsFor,
  paint,
  renderSectionRule,
  renderWordmark,
} from "@caesar/theme";
import { homedir } from "node:os";
import type { Writable } from "node:stream";

/** Output streams of a command. `process.stdout`/`process.stderr` in real use, captured in tests. */
export interface Io {
  stdout: Writable;
  stderr: Writable;
}

/** The real `Io` of the current process, used by `bin.ts`. */
export const processIo: Io = { stdout: process.stdout, stderr: process.stderr };

/** Exit codes, valid for all commands (see the brief). */
export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/**
 * The roles text can play — never a named color.
 *
 * That is the point of the theme: `colorize(x, "green")` is a decision made
 * on the spot, tied to nothing else; `colorize(x, "ok")` is a decision made
 * once, in the palette. The command line used to pick from seven ANSI
 * codes, case by case, which amounted to having no theme at all.
 *
 * `strong` deliberately carries no color: main text inherits the terminal's
 * foreground, so it stays readable on light and dark backgrounds alike
 * (rule 1 of the palette).
 */
const TOKENS = {
  accent: { hex: ACCENT },
  title: { hex: ACCENT, bold: true },
  strong: { bold: true },
  dim: { hex: DIM },
  faint: { hex: FAINT },
  border: { hex: BORDER },
  ok: { hex: OK },
  warn: { hex: WARN },
  bad: { hex: BAD },
} as const satisfies Record<string, { hex?: string; bold?: boolean }>;

export type ThemeToken = keyof typeof TOKENS;

/** A Node stream with `isTTY` — true for `process.stdout`/`process.stderr`, never for a test capture stream. */
interface MaybeTty extends Writable {
  isTTY?: boolean;
}

/**
 * What this particular stream is able to render.
 *
 * The decision is **per stream**, not per process: `stdout` may be
 * redirected to a file while `stderr` stays attached to the terminal.
 * Coloring both the same way would write ANSI sequences into the file, or
 * deprive the terminal of them.
 */
export function colorDepth(stream: Writable): ColorDepth {
  if (!(stream as MaybeTty).isTTY) return "none";
  return detectColorDepth(process.env);
}

/** The drawing character set suited to the current locale. */
export function activeGlyphs(): Glyphs {
  return glyphsFor(process.env);
}

/** Dresses `text` in the role `token`, only if `stream` can render it. */
export function colorize(text: string, token: ThemeToken, stream: Writable): string {
  return paint(text, TOKENS[token], colorDepth(stream));
}

export function writeLine(stream: Writable, text = ""): void {
  stream.write(text + "\n");
}

/** `--json` output: only the JSON, nothing else, never any color. */
export function printJson(io: Io, data: unknown): void {
  writeLine(io.stdout, JSON.stringify(data, null, 2));
}

export function printError(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "bad", io.stderr));
}

export function printWarning(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "warn", io.stderr));
}

/**
 * The banner that opens a command, followed by a blank line.
 *
 * It separates one invocation from the previous one in the terminal
 * scrollback — it is where the eye returns when scrolling up, and nothing
 * used to mark it. To be called only **after** the `--json` branch, never
 * before: a decoration line on `stdout` would break the machine output.
 */
export function sectionHeader(io: Io, label: string): void {
  writeLine(io.stdout, renderSectionRule(label, terminalWidth(io.stdout), activeGlyphs(), colorDepth(io.stdout)));
  writeLine(io.stdout);
}

/**
 * A confirmation line: what has just been done, marked as such.
 *
 * A command that writes a file used to render a bare sentence, impossible
 * to tell apart from a warning or a reminder in the scrollback. The mark
 * classifies it before it is even read.
 */
export function printDone(io: Io, message: string): void {
  writeLine(io.stdout, `${colorize(activeGlyphs().status.done, "ok", io.stdout)} ${message}`);
}

/**
 * A precision that accompanies, without being what one came to read.
 *
 * Wrapped to the terminal width: these sentences are full sentences, and
 * they overflowed on a narrow terminal — the wrap left to the terminal
 * brings the continuation back to column zero, where it blends into what
 * follows.
 */
export function printNote(io: Io, message: string): void {
  for (const line of wrapText(message, terminalWidth(io.stdout))) {
    writeLine(io.stdout, colorize(line, "dim", io.stdout));
  }
}

/**
 * A section's subheading, in the same design as the `caesar --help`
 * sections: uppercase and half-tone, never any trailing punctuation.
 *
 * Whatever explained the section becomes a note underneath. The two used to
 * be fused into one sentence — "Denied by the policy — the intended state,
 * unless you decide otherwise:", seventy-four characters — hence both too
 * long for a heading and too short to wrap cleanly.
 */
export function printHeading(io: Io, title: string): void {
  writeLine(io.stdout, colorize(title.toUpperCase(), "faint", io.stdout));
}

/** An aligned label/value pair, for block views rather than tables. */
export function printField(io: Io, label: string, value: string, width: number): void {
  writeLine(io.stdout, `${colorize(label.padEnd(width), "dim", io.stdout)}  ${value}`);
}

/**
 * The wordmark, reserved for the front door: `caesar --help` and the end of
 * `caesar init`. Nowhere else — a wordmark reprinted on every invocation
 * stops being an identity and becomes noise.
 */
export function bannerLines(stream: Writable, tagline?: string): string[] {
  return renderWordmark(activeGlyphs(), colorDepth(stream), tagline);
}

/**
 * Replaces the home directory with `~`.
 *
 * Ten characters returned to the "binary" column of `caesar agents list`,
 * which used to display `/Users/firstname/.…` — a path truncated at
 * seventeen characters, hence unusable. The prefix is what all the lines
 * have in common: it is exactly what teaches nothing.
 */
export function homePath(path: string): string {
  const home = homedir();
  if (home !== "" && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

/**
 * Wraps a text to the given width, breaking between words.
 *
 * Diagnostic sentences — a remedy, the reason for a refusal — are long by
 * nature. Left as they are, the terminal wraps them itself, but without
 * indentation: the continuation of a bullet comes back to column zero and
 * blends into the next item.
 *
 * The prefixes are applied **after** splitting: `firstPrefix` opens the
 * first line, `nextPrefix` the following ones, and `width` accounts for
 * them. Passing them this way rather than glued to the text avoids the trap
 * where splitting on whitespace would swallow them.
 *
 * A word longer than the width (a path, a URL) is not cut: truncating it
 * would make it unusable, and the terminal will know how to wrap it.
 */
export function wrapText(text: string, width: number, firstPrefix = "", nextPrefix = firstPrefix): string[] {
  const lines: string[] = [];
  const room = (): number => Math.max(1, width - (lines.length === 0 ? firstPrefix.length : nextPrefix.length));
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= room()) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line, i) => (i === 0 ? firstPrefix : nextPrefix) + line);
}

/** Two spaces between columns, in the box-less layout. */
const PLAIN_GAP = 2;

/**
 * What a box consumes **between** two columns: ` │ `. The two outer edges
 * (`│ ` and ` │`) are counted separately, in `BOX_EDGES`.
 */
const BOX_GAP = 3;
const BOX_EDGES = 4;

/**
 * Below this, a column no longer carries information: we stop shrinking it.
 * What happens next depends on the layout — see `printTable`.
 */
const MIN_COLUMN_WIDTH = 6;

/** Terminal width, or 80 when the output is not one (redirection, a script's `--json`, tests). */
export function terminalWidth(stream?: Writable): number {
  const columns = (stream as { columns?: number } | undefined)?.columns ?? process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : 80;
}

/** Truncates to `width` while marking the cut, so that a trimmed cell is visible. */
function fitCell(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text;
  if (width <= 1) return ellipsis.repeat(Math.max(0, width));
  return text.slice(0, width - 1) + ellipsis;
}

/**
 * Shaves the widest columns down until they fit within `budget`.
 *
 * The widest pays first: a narrow column generally carries a short, whole
 * value (an identifier, a status), where a wide column carries an
 * enumeration whose end can be guessed. We stop as soon as all have reached
 * `MIN_COLUMN_WIDTH`, without guaranteeing the budget was met — the caller
 * decides what to do with that failure.
 */
function shrinkColumns(widths: readonly number[], budget: number, gap: number): number[] {
  const out = [...widths];
  const total = (): number => out.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, out.length - 1);
  while (total() > budget) {
    let widest = 0;
    for (let i = 1; i < out.length; i += 1) if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i;
    if ((out[widest] ?? 0) <= MIN_COLUMN_WIDTH) break;
    out[widest] = (out[widest] ?? 0) - 1;
  }
  return out;
}

/**
 * A cell: a bare text, or a text carrying a theme role.
 *
 * This is what lets "allowed" be green and "denied" be red without
 * `printTable` having to know the domain, or the command having to know how
 * to format.
 */
export type Cell = string | { text: string; token: ThemeToken };

function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

export interface TableOptions {
  /** Available width. Default: that of `io.stdout`'s terminal. */
  maxWidth?: number;
}

/**
 * A table framed with thin rules. No dependency.
 *
 * **The frame counts against the width budget.** An N-column box consumes
 * `3N+1` characters of chrome: without that subtraction, the right border
 * lands on the next line, and a broken frame is far less readable than a
 * frameless table.
 *
 * **When the frame cannot fit, we give it up.** On a narrow terminal, no
 * distribution makes six or eight columns fit inside a frame without
 * reducing each cell to ellipses. The aligned layout then recovers the
 * third of the width the frame used to cost. The fallback is silent, and
 * intentionally so: there is nothing to report, only a width to honor.
 *
 * There remains the extreme case, inherited and accepted: when even six
 * characters per column do not fit, `shrinkColumns` stops and the layout
 * overflows. It is the lesser evil — a table the terminal wraps onto two
 * lines stays readable, a table whose every cell is "…" no longer is.
 *
 * Color is applied **after** padding: painting before would count the ANSI
 * sequences as columns, and all the alignment would be wrong.
 */
export function printTable(
  io: Io,
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  options: TableOptions = {},
): void {
  const glyphs = activeGlyphs();
  const depth = colorDepth(io.stdout);
  const maxWidth = options.maxWidth ?? terminalWidth(io.stdout);
  const count = headers.length;

  const natural = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cellText(row[i] ?? "").length)),
  );

  const boxBudget = maxWidth - BOX_EDGES;
  const boxWidths = shrinkColumns(natural, boxBudget, BOX_GAP);
  const boxTotal = boxWidths.reduce((sum, w) => sum + w, 0) + BOX_GAP * Math.max(0, count - 1);

  const widths = boxTotal <= boxBudget ? boxWidths : shrinkColumns(natural, maxWidth, PLAIN_GAP);
  const boxed = boxTotal <= boxBudget;

  const cells = (row: readonly Cell[], token?: ThemeToken): string[] =>
    widths.map((width, i) => {
      const cell = row[i] ?? "";
      const padded = fitCell(cellText(cell), width, glyphs.ellipsis).padEnd(width);
      const role = typeof cell === "string" ? token : cell.token;
      return role === undefined ? padded : paint(padded, TOKENS[role], depth);
    });

  if (!boxed) {
    // Aligned layout: header, full-width rule, body.
    writeLine(io.stdout, cells(headers, "dim").join(" ".repeat(PLAIN_GAP)).trimEnd());
    const ruleWidth = widths.reduce((sum, w) => sum + w, 0) + PLAIN_GAP * Math.max(0, count - 1);
    writeLine(io.stdout, paint(glyphs.box.horizontal.repeat(ruleWidth), TOKENS.border, depth));
    for (const row of rows) writeLine(io.stdout, cells(row).join(" ".repeat(PLAIN_GAP)).trimEnd());
    return;
  }

  const { box } = glyphs;
  const segments = widths.map((width) => box.horizontal.repeat(width + 2));
  const rule = (left: string, middle: string, right: string): string =>
    paint(left + segments.join(middle) + right, TOKENS.border, depth);
  const bar = paint(box.vertical, TOKENS.border, depth);
  const line = (row: readonly Cell[], token?: ThemeToken): string =>
    `${bar} ${cells(row, token).join(` ${bar} `)} ${bar}`;

  writeLine(io.stdout, rule(box.topLeft, box.teeDown, box.topRight));
  writeLine(io.stdout, line(headers, "dim"));
  writeLine(io.stdout, rule(box.teeRight, box.cross, box.teeLeft));
  for (const row of rows) writeLine(io.stdout, line(row));
  writeLine(io.stdout, rule(box.bottomLeft, box.teeUp, box.bottomRight));
}
