/**
 * The TUI's palette — now the whole tool's.
 *
 * These constants lived here, and were known only here: the command line
 * chose its colors on its own side, from seven base ANSI codes. The two
 * halves of the same tool thus did not look alike on screen. They were
 * moved into `@caesar/theme`, **without a single value changing**, and
 * this file re-exports them: the TUI screens keep importing
 * `../ui/theme.js` and render exactly the same image.
 *
 * The two rules that hold it together are documented at the source
 * (`packages/theme/src/palette.ts`): primary text never carries a color,
 * and anything that sets a background also sets its foreground.
 */
export {
  ACCENT,
  ACCENT_INK,
  BAD,
  DIM,
  FAINT,
  KEY_BG,
  KEY_FG,
  OK,
  SELECTED_BG,
  SELECTED_BG_IDLE,
  WARN,
} from "@caesar/theme";
