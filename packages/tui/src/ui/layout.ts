/**
 * Distribution of the width among a table's columns, and text splitting —
 * the computational part of the display, isolated from rendering to be
 * testable on its own.
 *
 * The defect this module exists to fix: the TUI's tables padded each cell
 * to a *conventional* hard-coded width (`fitColumn(path, 26)`), with no
 * gutter and without looking at the terminal's real width. Two
 * consequences, both visible in use:
 *
 *  - a truncated value stuck to the next cell — the elision and the
 *    neighboring value read as a single word
 *    (`/Users/…/bin…codex-cli 0.1…7 notable(s)`);
 *  - on a wide terminal, the table stayed crammed into 80 columns while
 *    the paths, for their part, were cut for lack of room.
 *
 * Here, widths are derived from the available room: each column announces
 * a minimum and a share of the surplus (`flex`), and the gutter is
 * guaranteed because it is subtracted before any sharing.
 */

export interface ColumnWidthSpec {
  /** Minimum width. Defaults to the header's length: a column is never narrower than its title. */
  min?: number;
  /** Share of the width surplus. 0 (the default): the column stays at its minimum. */
  flex?: number;
  /**
   * Width beyond which the column stops growing. Without a cap, a flexible
   * column on a wide terminal stretches far beyond what it has to show —
   * forty characters to display "0.1.7" — and needlessly pushes its
   * neighbors apart.
   */
  max?: number;
  /** Length of the header, implicit floor of the minimum. */
  header: string;
}

/** Below this, a cell carries nothing but the elision: a column is never shrunk to less. */
const MIN_CELL = 4;

/**
 * Width of each column for `available` terminal columns, gutters included.
 * The rendered total, augmented by the `(n - 1) * gutter` separators,
 * never exceeds `available` — that is the property that keeps the
 * terminal from wrapping a table line onto the next one, which made the
 * view unreadable precisely where it was supposed to inform.
 *
 * When room runs out, the columns shrink proportionally to their minimum
 * rather than by sacrificing the last one: a "permission" column amputated
 * at the end of the line is as useless as an amputated path.
 */
export function layoutColumns(specs: readonly ColumnWidthSpec[], available: number, gutter = 2): number[] {
  if (specs.length === 0) return [];

  const gutters = (specs.length - 1) * gutter;
  const room = Math.max(specs.length * MIN_CELL, available - gutters);
  const widths = specs.map((spec) => Math.max(MIN_CELL, spec.min ?? spec.header.length));
  const total = widths.reduce((sum, width) => sum + width, 0);

  if (total <= room) {
    // Distribution by rounds: each round gives `flex` characters to each
    // column still under its cap. The ratio between flexible columns is
    // thus respected exactly, and a column that reaches its cap leaves the
    // sharing without blocking the others. The room no column can take
    // anymore stays unused — a ragged right edge is better than a column
    // stretched for nothing.
    let slack = room - total;
    while (slack > 0) {
      let given = 0;
      for (const [index, spec] of specs.entries()) {
        const flex = spec.flex ?? 0;
        if (flex === 0 || slack === 0) continue;
        const step = Math.min(flex, slack, (spec.max ?? Number.POSITIVE_INFINITY) - widths[index]!);
        if (step <= 0) continue;
        widths[index] = widths[index]! + step;
        slack -= step;
        given += step;
      }
      if (given === 0) break;
    }
    return widths;
  }

  // Too narrow: we shave proportionally, without ever going below
  // `MIN_CELL`. The loop redistributes what that floor prevented removing.
  let excess = total - room;
  while (excess > 0) {
    const shrinkable = widths.map((width, index) => (width > MIN_CELL ? index : -1)).filter((index) => index >= 0);
    if (shrinkable.length === 0) break;
    for (const index of shrinkable) {
      if (excess === 0) break;
      widths[index] = widths[index]! - 1;
      excess -= 1;
    }
  }
  return widths;
}

/**
 * `text` padded or truncated to exactly `width` characters. A too-long
 * value loses its end to an elision — never to the neighboring column.
 */
export function cell(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/**
 * `text` shortened **from the left** to `width` characters. For a path,
 * it is the end that informs (`…/my-project/.caesar/config.toml`):
 * truncating it from the right like an ordinary value would leave the
 * prefix common to every path on the machine, that is, nothing.
 */
export function elideLeft(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `…${text.slice(text.length - (width - 1))}`;
}

/**
 * Splits `text` into lines of at most `width` characters, on spaces. A
 * word longer than the width is cut rather than overflowing — a path or a
 * command has no space to wrap on.
 *
 * Used by the detail panels, where long sentences (the reason for a
 * policy denial, in particular) until now ran off screen.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      let piece = word;
      // A word longer than the whole line: it is sliced in full chunks
      // before resuming the normal accumulation.
      while (piece.length > width) {
        if (current.length > 0) {
          lines.push(current);
          current = "";
        }
        lines.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      if (current.length === 0) current = piece;
      else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
    lines.push(current);
  }

  return lines;
}
