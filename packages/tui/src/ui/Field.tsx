/**
 * Aligned "label — value" line, the building block of the editing panels.
 *
 * The old layout put the value *under* its label, indented by two spaces:
 * six fields occupied eighteen lines, without any column reading
 * vertically. Here the label holds a fixed-width column and the value
 * always starts at the same place — the values are scanned in a single
 * glance.
 *
 * A value longer than the remaining room wraps under itself (`wrap`),
 * aligned on the values column: that is what the reason for a policy
 * denial lacked, which until now ran off screen.
 *
 * The field's explanation does **not** live here: it is displayed at the
 * foot of the panel, at constant height (`Explain`). Rendered inline, it
 * shifted every following field as soon as it appeared — the whole list
 * jumped on every cursor move.
 */
import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { wrap } from "./layout";
import { ACCENT, DIM, FAINT } from "./theme";

export interface FieldProps {
  label: string;
  /** Total width available for the line (label + value). */
  width: number;
  /** Width of the labels column — common to every field of a given panel. */
  labelWidth: number;
  selected?: boolean;
  /** Already formatted inheritance mark ("← global"), displayed at the end of the first line. */
  mark?: string;
  value?: string;
  /** Color of the value, for what carries one (enabled/disabled, picked…). */
  valueFg?: string;
  /** Rendered in place of the value, on the same line — typically an input field. */
  children?: ReactNode;
  /** Rendered under the line, aligned on the values column — typically a sub-list. */
  below?: ReactNode;
}

export function Field({ label, width, labelWidth, selected = false, mark, value, valueFg, children, below }: FieldProps) {
  const valueWidth = Math.max(8, width - labelWidth - 2);
  const lines = value === undefined ? [] : wrap(value, valueWidth);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={selected ? ACCENT : DIM} attributes={selected ? TextAttributes.BOLD : undefined}>
          {(selected ? "› " : "  ") + label.padEnd(labelWidth)}
        </text>
        {children ?? <text fg={valueFg}>{lines[0] ?? ""}</text>}
        {mark ? <text fg={FAINT}>{mark}</text> : null}
      </box>

      {lines.slice(1).map((line, index) => (
        <box key={index} flexDirection="row">
          <text>{" ".repeat(labelWidth + 2)}</text>
          <text fg={valueFg}>{line}</text>
        </box>
      ))}

      {below}
    </box>
  );
}
