/**
 * The characters that draw: box strokes and status marks.
 *
 * Two sets, not one. The thin strokes (`─ │ ╭`) and the marks (`● ✓`) are
 * Unicode characters: on a terminal that is not in UTF-8, they do not
 * appear degraded — they appear as gibberish, and a framed table then
 * becomes less readable than an unframed one. The ASCII set is therefore
 * not a courtesy, it is the condition for the frame to be an improvement
 * everywhere rather than an improvement on average.
 *
 * Both sets have **the same width per character** (one column), so that all
 * of `renderTable`'s width arithmetic holds for either one.
 */
import type { Environment } from "./ansi.js";

export interface BoxGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeDown: string;
  teeUp: string;
  teeLeft: string;
  teeRight: string;
  cross: string;
}

export interface StatusGlyphs {
  /** The tool's mark, at the head of every command's banner. */
  mark: string;
  /** A task that is working. */
  running: string;
  /** A task silent for too long. */
  stalled: string;
  /** Favorable outcome. */
  done: string;
  /** Unfavorable outcome. */
  failed: string;
  /** What calls for attention without being a failure. */
  warn: string;
  /** A tool being executed. */
  tool: string;
  /** A touched file. */
  file: string;
  /** A pending question. */
  question: string;
  /** What the agent says, as opposed to what it does. */
  speech: string;
  /** Separator between two pieces of information on the same line. */
  bullet: string;
}

export interface Glyphs {
  box: BoxGlyphs;
  status: StatusGlyphs;
  /** Truncation mark for a cell that is too narrow. */
  ellipsis: string;
}

const UNICODE: Glyphs = {
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
  },
  status: {
    mark: "▞▚",
    running: "●",
    stalled: "◌",
    done: "✓",
    failed: "✗",
    warn: "⚠",
    tool: "▸",
    file: "~",
    question: "?",
    speech: "»",
    bullet: "·",
  },
  ellipsis: "…",
};

const ASCII: Glyphs = {
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    teeDown: "+",
    teeUp: "+",
    teeLeft: "+",
    teeRight: "+",
    cross: "+",
  },
  status: {
    mark: "::",
    running: "*",
    stalled: "o",
    done: "+",
    failed: "x",
    warn: "!",
    tool: ">",
    file: "~",
    question: "?",
    speech: "\"",
    bullet: "-",
  },
  // One dot, not three: truncation must cost one column, the same as "…",
  // otherwise every width `renderTable` computes is wrong.
  ellipsis: ".",
};

/**
 * Can the terminal display Unicode?
 *
 * `LC_ALL` wins over `LC_CTYPE`, which wins over `LANG` — the order the
 * POSIX standard sets. **When none of the three is set, we answer yes**:
 * that is the common case on macOS, where terminals are in UTF-8 without
 * declaring anything. Answering no out of caution would deprive the
 * majority of users of the theme to protect a minority that, for its part,
 * always signals itself explicitly (`LC_ALL=C`).
 */
export function supportsUnicode(env: Environment): boolean {
  const locale = env["LC_ALL"] ?? env["LC_CTYPE"] ?? env["LANG"];
  if (locale === undefined || locale === "") return true;
  return /utf-?8/i.test(locale);
}

export function glyphsFor(env: Environment): Glyphs {
  return supportsUnicode(env) ? UNICODE : ASCII;
}

export { UNICODE as UNICODE_GLYPHS, ASCII as ASCII_GLYPHS };
