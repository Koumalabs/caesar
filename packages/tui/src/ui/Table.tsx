/**
 * Fluid-column table: widths are derived from the real room
 * (`layoutColumns`), a gutter always separates two cells, and any
 * too-long value is truncated inside its own.
 *
 * It is the replacement for the tables handwritten in each screen, which
 * padded cells to constant widths and without a separator — a truncated
 * value then came to stick to the next one, and the two read as a single
 * word.
 *
 * The selected row carries a background **and** a bold "›" cursor: the
 * background assumes a dark terminal (see `SELECTED_BG`), the cursor does
 * not. That background dims when the table does not have focus, so that a
 * dormant selection does not compete for attention with the one receiving
 * the keys.
 */
import { TextAttributes } from "@opentui/core";
import { cell, layoutColumns } from "./layout";
import { DIM, SELECTED_BG, SELECTED_BG_IDLE } from "./theme";

export interface TableColumn<T> {
  header: string;
  /** Minimum width; defaults to the header's length. */
  min?: number;
  /** Share of the width surplus. 0 (default): the column keeps its minimum. */
  flex?: number;
  /** Width beyond which the column stops growing (see `layoutColumns`). */
  max?: number;
  cell: (row: T) => string;
  /** Color of the cell — for what has meaning (installed, denied…), never to decorate. */
  fg?: (row: T) => string | undefined;
}

export interface TableProps<T> {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: readonly T[];
  keyOf: (row: T, index: number) => string;
  selectedIndex: number;
  /** Whether the table receives the keys — changes the intensity of the selected row. */
  focused?: boolean;
  /** Available width, gutters included. */
  width: number;
  /** Displayed in place of the rows when there are none. */
  emptyText?: string;
}

const GUTTER = 2;

export function Table<T>({ columns, rows, keyOf, selectedIndex, focused = true, width, emptyText }: TableProps<T>) {
  // Two characters are reserved for the cursor at the head of the row:
  // without this subtraction, the last column would stick out of the frame
  // by exactly its width, and the terminal would wrap the line.
  const widths = layoutColumns(columns, Math.max(0, width - 2), GUTTER);
  const gap = " ".repeat(GUTTER);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={DIM}>{"  "}</text>
        {columns.map((column, index) => (
          <text key={column.header} fg={DIM}>
            {(index > 0 ? gap : "") + cell(column.header, widths[index]!)}
          </text>
        ))}
      </box>

      {rows.length === 0 && emptyText ? <text fg={DIM}>{`  ${emptyText}`}</text> : null}

      {rows.map((row, rowIndex) => {
        const isSelected = rowIndex === selectedIndex;
        const bg = isSelected ? (focused ? SELECTED_BG : SELECTED_BG_IDLE) : undefined;
        return (
          <box key={keyOf(row, rowIndex)} flexDirection="row" backgroundColor={bg}>
            <text attributes={isSelected ? TextAttributes.BOLD : undefined}>{isSelected ? "› " : "  "}</text>
            {columns.map((column, index) => (
              <text
                key={column.header}
                fg={column.fg?.(row)}
                attributes={isSelected ? TextAttributes.BOLD : undefined}
              >
                {(index > 0 ? gap : "") + cell(column.cell(row), widths[index]!)}
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}
