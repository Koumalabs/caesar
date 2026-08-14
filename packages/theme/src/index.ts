/**
 * `@caesar/theme` — the tool's appearance, in one single place.
 *
 * This package exists so that there is **one** palette and not two. It
 * lived in the TUI; the command line, for its part, picked its colors case
 * by case from seven base ANSI codes. The two halves of the same tool thus
 * did not look alike, and nothing kept the gap from widening.
 *
 * It depends on nothing, not even Node: the environment is always passed
 * to it as a parameter (see `ansi.ts`). Nor does it decide *whether* color
 * applies — that is for the output stream to say, since `stdout` can be a
 * terminal while `stderr` is a file. That decision stays with the caller
 * (`packages/cli/src/output.ts`).
 */
export {
  BOLD,
  RESET,
  detectColorDepth,
  foreground,
  paint,
  parseHex,
  toAnsi16,
  toAnsi256,
} from "./ansi.js";
export type { ColorDepth, Environment } from "./ansi.js";

export {
  ACCENT,
  ACCENT_INK,
  ACCENT_RAMP,
  BAD,
  BORDER,
  DIM,
  FAINT,
  KEY_BG,
  KEY_FG,
  OK,
  SELECTED_BG,
  SELECTED_BG_IDLE,
  WARN,
} from "./palette.js";

export { ASCII_GLYPHS, UNICODE_GLYPHS, glyphsFor, supportsUnicode } from "./glyphs.js";
export type { BoxGlyphs, Glyphs, StatusGlyphs } from "./glyphs.js";

export { WORDMARK_LINES, WORDMARK_WIDTH, renderSectionRule, renderWordmark } from "./wordmark.js";
