/**
 * La palette, source unique pour la ligne de commande **et** pour le TUI.
 *
 * Elle vivait dans `packages/tui/src/ui/theme.ts` et n'était connue que de
 * lui : la CLI, elle, piochait au cas par cas dans sept codes ANSI de base
 * (`red`, `green`, `cyan`…). Les deux moitiés du même outil ne se
 * ressemblaient donc pas à l'écran. Ce fichier est la palette du TUI,
 * déplacée telle quelle — les valeurs n'ont pas bougé d'un chiffre, et
 * `packages/tui/src/ui/theme.ts` la ré-exporte — augmentée de ce que la
 * ligne de commande réclamait en propre.
 *
 * Les deux règles qui la tiennent, héritées du TUI :
 *
 *  1. **Le texte principal ne porte jamais de couleur.** Il hérite de
 *     l'avant-plan du terminal, donc reste lisible quel que soit le thème de
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

/**
 * Les traits des encadrés. Une bordure décrit une structure, elle ne la
 * commente pas : elle doit se voir sans se lire, donc reculer d'un cran par
 * rapport au texte le plus discret du tableau (`DIM`, qui porte les entêtes).
 */
export const BORDER = FAINT;

/**
 * Le dégradé du logotype, du haut vers le bas.
 *
 * Volontairement **étroit**, et vers le sombre plutôt que vers le clair : un
 * dégradé qui monte vers le blanc disparaît sur un terminal à fond clair, où
 * une bonne moitié des utilisateurs travaille. Les six teintes gardent un
 * contraste utilisable sur fond blanc comme sur fond noir — c'est la même
 * exigence que la règle 1 ci-dessus, appliquée à la seule décoration de
 * l'outil. Une entrée par ligne du logotype, en progression régulière par
 * canal (R −0x0F, G −0x0B, B −0x03 à chaque pas), depuis l'or de la marque.
 */
export const ACCENT_RAMP: readonly string[] = [
  "#EAA52E",
  "#DB9A2B",
  "#CC8F28",
  "#BD8425",
  "#AE7922",
  "#9F6E1F",
];
