/**
 * Contextual key bar: what can be typed **right now**, at the place where
 * one is.
 *
 * The old screen displayed a frozen help line, identical whether one was
 * walking the list or editing a field — thus wrong half the time, and
 * unreadable all the time (all gray, keys and labels blended into the
 * same sentence). Here the key is a contrasted chip and the label
 * secondary text: the eye finds the keys without reading the sentence.
 *
 * Each screen renders this bar itself, according to its current focus
 * level: it is the one that knows what "Enter" does at this instant.
 */
import { DIM, KEY_BG, KEY_FG } from "./theme";

export interface Hint {
  key: string;
  label: string;
}

export function KeyHints({ hints }: { hints: readonly Hint[] }) {
  return (
    <box flexDirection="row" flexWrap="wrap">
      {hints.map((hint) => (
        <box key={`${hint.key}:${hint.label}`} flexDirection="row" marginRight={2}>
          <text bg={KEY_BG} fg={KEY_FG}>{` ${hint.key} `}</text>
          <text fg={DIM}>{` ${hint.label}`}</text>
        </box>
      ))}
    </box>
  );
}
