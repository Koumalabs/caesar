/**
 * Palette et conventions visuelles du TUI — une seule source, plutôt qu'une
 * couleur choisie au cas par cas dans chaque écran (c'est ainsi que « tout
 * était gris » : `fg="gray"` posé partout, donc aucune hiérarchie).
 *
 * Deux règles tiennent l'ensemble :
 *
 *  1. **Le texte principal ne porte jamais de couleur.** Il hérite de
 *     l'avant-plan du terminal, donc il est lisible quel que soit le thème de
 *     l'utilisateur. Seuls le secondaire (`DIM`), le tertiaire (`FAINT`) et
 *     le sémantique (`OK`/`WARN`/`BAD`) sont colorés — des demi-tons qui
 *     passent sur fond clair comme sur fond sombre.
 *
 *  2. **Tout ce qui pose un fond pose aussi son avant-plan.** Un fond sans
 *     avant-plan explicite emprunte celui du terminal et devient illisible
 *     dès que le thème s'inverse. La seule exception assumée est
 *     `SELECTED_BG` (voir plus bas).
 */

/** Bleu d'accent : focus, sélection, onglet actif. Assez saturé pour trancher, assez sombre pour porter du texte clair. */
export const ACCENT = "#7AA2F7";

/** Texte posé sur `ACCENT` — un fond clair appelle une encre sombre. */
export const ACCENT_INK = "#0B0E14";

/**
 * Fond de la ligne sélectionnée. Volontairement sans avant-plan imposé : les
 * couleurs sémantiques de la ligne (« autorisé » en vert, « refusé » en
 * rouge) doivent survivre à la sélection — c'est justement sur la ligne qu'on
 * regarde qu'on veut les lire. Le prix est une hypothèse de terminal sombre,
 * la même que faisait déjà l'écran Agents ; le curseur "›" et la graisse
 * restent lisibles même si ce fond ne rend rien.
 */
export const SELECTED_BG = "#31395E";

/** Fond de la ligne sélectionnée dans un panneau qui n'a *pas* le focus — présent, mais qui ne réclame pas l'œil. */
export const SELECTED_BG_IDLE = "#23283A";

/** Texte secondaire : en-têtes de colonnes, valeurs par défaut, explications. Lisible, contrairement au "gray" du terminal. */
export const DIM = "#8992A6";

/** Texte tertiaire : bordures inactives, marques d'héritage, ce qui ne doit se lire que si on le cherche. */
export const FAINT = "#5E6678";

export const OK = "#7DCE82";
export const WARN = "#E0AF68";
export const BAD = "#E88388";

/** Fond des touches dans la barre d'aide contextuelle, avec son encre. */
export const KEY_BG = "#3B4359";
export const KEY_FG = "#E6E9F0";
