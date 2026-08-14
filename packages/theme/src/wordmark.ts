/**
 * The wordmark and the command banner.
 *
 * The wordmark follows the "ANSI Shadow" style: the body of each letter is
 * made of full blocks (`█`), and its right flank and base carry a shadow
 * in double strokes (`╗ ║ ╚ ═`), which gives relief without a second
 * color. Each letter occupies 8 columns, shadow and breathing room
 * included — the glyphs thus join without a separator: 48 columns over 6
 * lines.
 *
 * Without Unicode, neither the full blocks nor the double strokes exist:
 * the fallback does not try to mimic the drawing in `#`, which would give
 * a coarse slab; it renders a single line, and owns it.
 */
import type { ColorDepth } from "./ansi.js";
import { paint } from "./ansi.js";
import type { Glyphs } from "./glyphs.js";
import { ACCENT, ACCENT_RAMP, BORDER, DIM } from "./palette.js";

/**
 * The six lines of the wordmark, uncolored. Each is exactly
 * `WORDMARK_WIDTH` columns — the interior and trailing spaces of each
 * 8-column glyph are significant for the alignment of the following
 * letters.
 */
export const WORDMARK_LINES: readonly string[] = [
  " ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ ",
  "██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
  "██║     ███████║█████╗  ███████╗███████║██████╔╝",
  "██║     ██╔══██║██╔══╝  ╚════██║██╔══██║██╔══██╗",
  "╚██████╗██║  ██║███████╗███████║██║  ██║██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

export const WORDMARK_WIDTH = 48;

/**
 * The wordmark, one ramp color per line — the light comes from above.
 * Without Unicode or without color, what remains is the name itself.
 */
export function renderWordmark(glyphs: Glyphs, depth: ColorDepth, tagline?: string): string[] {
  const unicode = glyphs.box.horizontal === "─";
  const lines = unicode
    ? WORDMARK_LINES.map((line, i) => paint(line, { hex: ACCENT_RAMP[i] ?? ACCENT }, depth))
    : // The wordmark's brand color, not the interface accent: the fallback
      // is still the wordmark, reduced to its simplest expression.
      [paint("CAESAR", { hex: ACCENT_RAMP[0] ?? ACCENT, bold: true }, depth)];
  if (tagline === undefined) return lines;
  // Aligned under the second letter rather than on the edge: the wordmark
  // already has a sharp left edge, and a tagline that steps away from it
  // reads as a caption rather than as a second title line.
  const indent = unicode ? "  " : "";
  return [...lines, indent + paint(tagline, { hex: DIM }, depth)];
}

/**
 * The one-line banner that opens each command:
 * `▞▚ caesar · doctor ─────────────────────`.
 *
 * It occupies the full available width. Its purpose is to separate one
 * invocation from the previous one in the terminal's scrollback — it is
 * the place the eye returns to when scrolling up, and nothing marked it.
 */
export function renderSectionRule(label: string, width: number, glyphs: Glyphs, depth: ColorDepth): string {
  const head = `${glyphs.status.mark} caesar ${glyphs.status.bullet} ${label} `;
  const rule = glyphs.box.horizontal.repeat(Math.max(0, width - head.length));
  return (
    paint(glyphs.status.mark, { hex: ACCENT }, depth) +
    paint(" caesar ", { hex: DIM }, depth) +
    paint(glyphs.status.bullet, { hex: BORDER }, depth) +
    " " +
    paint(label, { hex: ACCENT, bold: true }, depth) +
    " " +
    paint(rule, { hex: BORDER }, depth)
  );
}
