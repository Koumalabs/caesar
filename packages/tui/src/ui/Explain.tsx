/**
 * Constant-height explanation zone, at the foot of a panel: what the
 * selected field does.
 *
 * The fixed height is the whole point. Rendered inline, under the field,
 * this explanation pushed every following field down as soon as it
 * appeared — moving down one notch then made the whole list jump, and the
 * eye lost the line it was following. Here the room is reserved once and
 * for all: the text changes, the layout does not move.
 */
import { wrap } from "./layout";
import { FAINT } from "./theme";

/** Two lines: enough for a full sentence, few enough not to steal the room from the settings. */
const LINES = 2;

export function Explain({ text, width }: { text?: string; width: number }) {
  const lines = text ? wrap(text, Math.max(20, width)).slice(0, LINES) : [];
  return (
    <box flexDirection="column" marginTop={1}>
      {Array.from({ length: LINES }, (_, index) => (
        <text key={index} fg={FAINT}>
          {lines[index] ?? " "}
        </text>
      ))}
    </box>
  );
}
