/**
 * `@orch/theme` — l'apparence de l'outil, en un seul endroit.
 *
 * Ce paquet existe pour qu'il y ait **une** palette et non deux. Elle vivait
 * dans le TUI ; la ligne de commande, elle, choisissait ses couleurs au cas
 * par cas parmi sept codes ANSI de base. Les deux moitiés du même outil ne se
 * ressemblaient donc pas, et rien n'empêchait l'écart de se creuser.
 *
 * Il ne dépend de rien, pas même de Node : l'environnement lui est toujours
 * passé en paramètre (voir `ansi.ts`). Il ne décide pas non plus *si* la
 * couleur s'applique — c'est au flux de sortie de le dire, puisque `stdout`
 * peut être un terminal quand `stderr` est un fichier. Cette décision reste
 * chez l'appelant (`packages/cli/src/output.ts`).
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
