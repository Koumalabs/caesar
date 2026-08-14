/**
 * The palette, single source for the command line **and** for the TUI.
 *
 * It lived in `packages/tui/src/ui/theme.ts` and was known only to it: the
 * CLI, for its part, picked case by case from seven base ANSI codes
 * (`red`, `green`, `cyan`…). The two halves of the same tool thus did not
 * look alike on screen. This file is the TUI's palette, moved and then
 * retuned around the brand gold (#EAA52E): the accent and the neutrals
 * left blue for warm tones, at equivalent luminance and contrast — every
 * role keeps exactly the place it had. The semantics (`OK`/`WARN`/`BAD`),
 * for their part, did not move: their hue is a reading contract, not a
 * decoration, and the 16-color fallback (`toAnsi16`, which classifies by
 * hue) counts on `WARN` staying on the yellow side — a `WARN` pushed
 * toward orange would fall back to red and blur into `BAD`.
 *
 * The two rules that hold it together, inherited from the TUI:
 *
 *  1. **Primary text never carries a color.** It inherits the terminal's
 *     foreground, so it stays readable whatever the user's theme. Only the
 *     secondary (`DIM`), the tertiary (`FAINT`) and the semantic
 *     (`OK`/`WARN`/`BAD`) are colored — half-tones that work on light and
 *     dark backgrounds alike.
 *
 *  2. **Anything that sets a background also sets its foreground.** A
 *     background without an explicit foreground borrows the terminal's and
 *     becomes unreadable as soon as the theme flips. The only accepted
 *     exception is `SELECTED_BG` (see below).
 */

/** Accent gold — the brand color: focus, selection, active tab. Saturated enough to cut through, light enough to carry a dark ink. */
export const ACCENT = "#EAA52E";

/** Text set on `ACCENT` — a golden background calls for a dark ink, warm like it. */
export const ACCENT_INK = "#1A1206";

/**
 * Background of the selected row. Deliberately without an imposed
 * foreground: the row's semantic colors ("allowed" in green, "denied" in
 * red) must survive selection — it is precisely on the row being looked at
 * that they must be readable. The price is a dark-terminal assumption, the
 * same one the Agents screen already made; the "›" cursor and the bold
 * weight stay readable even if this background renders as nothing.
 */
export const SELECTED_BG = "#4A3714";

/** Background of the selected row in a panel that does *not* have focus — present, but not demanding the eye. */
export const SELECTED_BG_IDLE = "#332714";

/** Secondary text: column headers, default values, explanations. Readable, unlike the terminal's "gray". */
export const DIM = "#9E9284";

/** Tertiary text: inactive borders, inheritance marks, what should be read only when looked for. */
export const FAINT = "#6B6252";

export const OK = "#7DCE82";
export const WARN = "#E0AF68";
export const BAD = "#E88388";

/** Background of the keys in the contextual help bar, with its ink. */
export const KEY_BG = "#473C26";
export const KEY_FG = "#F0EAD9";

/**
 * The strokes of the frames. A border describes a structure, it does not
 * comment on it: it must be seen without being read, thus step back one
 * notch from the table's most discreet text (`DIM`, which carries the
 * headers).
 */
export const BORDER = FAINT;

/**
 * The wordmark's gradient, top to bottom.
 *
 * Deliberately **narrow**, and toward the dark rather than toward the
 * light: a gradient climbing toward white disappears on a light-background
 * terminal, where a good half of users work. The six shades keep a usable
 * contrast on white and black backgrounds alike — the same requirement as
 * rule 1 above, applied to the tool's only decoration. One entry per
 * wordmark line, in a regular per-channel progression (R −0x0F, G −0x0B,
 * B −0x03 at each step), starting from the brand gold.
 */
export const ACCENT_RAMP: readonly string[] = [
  "#EAA52E",
  "#DB9A2B",
  "#CC8F28",
  "#BD8425",
  "#AE7922",
  "#9F6E1F",
];
