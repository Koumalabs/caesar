/**
 * Titled frame whose border says whether it has focus — the answer to
 * "where am I?", which the old screen gave nowhere: two "›" cursors could
 * be visible at the same time (the roles list and the fields list) with
 * nothing distinguishing the one receiving the keys.
 *
 * `note` is displayed at the top of the content rather than in the title:
 * OpenTUI only aligns a title left, center or right, and a composite
 * title ("implementer — inherited ← global") overflows the frame as soon
 * as the name gets long.
 */
import type { ReactNode } from "react";
import { ACCENT, DIM, FAINT } from "./theme";

export interface PanelProps {
  title: string;
  /** True when this panel receives the keys — its border and title light up. */
  focused?: boolean;
  /** Clarification shown on the first line, indented (provenance, rule reminder…). */
  note?: string;
  width?: number;
  flexGrow?: number;
  children?: ReactNode;
}

export function Panel({ title, focused = false, note, width, flexGrow, children }: PanelProps) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? ACCENT : FAINT}
      title={` ${title} `}
      titleColor={focused ? ACCENT : DIM}
      paddingLeft={1}
      paddingRight={1}
      // A panel taller than the remaining room overflowed onto its
      // neighbors — the characters overlapped and the frame became
      // unreadable. On a too-short terminal, better to cut cleanly than to
      // blur.
      overflow="hidden"
      // A panel never lets itself be squeezed: deprived of its height,
      // yoga collapses its lines onto one another and the text overlaps,
      // unreadable. So it keeps the height of its content, and it is the
      // screen body (`overflow: hidden`) that cuts what sticks out.
      flexShrink={0}
      {...(width !== undefined ? { width } : {})}
      {...(flexGrow !== undefined ? { flexGrow } : {})}
    >
      {note ? <text fg={DIM}>{note}</text> : null}
      {children}
    </box>
  );
}
