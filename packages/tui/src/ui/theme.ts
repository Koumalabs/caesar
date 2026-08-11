/**
 * La palette du TUI — désormais celle de tout l'outil.
 *
 * Ces constantes vivaient ici, et n'étaient connues que d'ici : la ligne de
 * commande choisissait ses couleurs de son côté, parmi sept codes ANSI de
 * base. Les deux moitiés du même outil ne se ressemblaient donc pas à
 * l'écran. Elles ont été déplacées dans `@orch/theme`, **sans qu'aucune
 * valeur ne change**, et ce fichier les ré-exporte : les écrans du TUI
 * continuent d'importer `../ui/theme.js` et rendent exactement la même image.
 *
 * Les deux règles qui la tiennent sont documentées à la source
 * (`packages/theme/src/palette.ts`) : le texte principal ne porte jamais de
 * couleur, et tout ce qui pose un fond pose aussi son avant-plan.
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
} from "@orch/theme";
