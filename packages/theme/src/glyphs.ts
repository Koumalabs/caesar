/**
 * Les caractères qui dessinent : traits d'encadré et marques d'état.
 *
 * Deux jeux, et non un seul. Les traits fins (`─ │ ╭`) et les marques (`● ✓`)
 * sont des caractères Unicode : sur un terminal qui n'est pas en UTF-8, ils
 * n'apparaissent pas en dégradé — ils apparaissent en charabia, et un tableau
 * encadré devient alors moins lisible qu'un tableau sans cadre. Le jeu ASCII
 * n'est donc pas une politesse, c'est la condition pour que l'encadré soit
 * une amélioration partout plutôt qu'une amélioration en moyenne.
 *
 * Les deux jeux ont **la même largeur par caractère** (une colonne), de sorte
 * que tout le calcul de largeur de `renderTable` vaut pour l'un comme pour
 * l'autre.
 */
import type { Environment } from "./ansi.js";

export interface BoxGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeDown: string;
  teeUp: string;
  teeLeft: string;
  teeRight: string;
  cross: string;
}

export interface StatusGlyphs {
  /** La marque de l'outil, en tête du bandeau de chaque commande. */
  mark: string;
  /** Une tâche qui travaille. */
  running: string;
  /** Une tâche silencieuse depuis trop longtemps. */
  stalled: string;
  /** Issue favorable. */
  done: string;
  /** Issue défavorable. */
  failed: string;
  /** Ce qui appelle l'attention sans être un échec. */
  warn: string;
  /** Un outil en cours d'exécution. */
  tool: string;
  /** Un fichier touché. */
  file: string;
  /** Une question en attente. */
  question: string;
  /** Ce que l'agent dit, par opposition à ce qu'il fait. */
  speech: string;
  /** Séparateur entre deux informations d'une même ligne. */
  bullet: string;
}

export interface Glyphs {
  box: BoxGlyphs;
  status: StatusGlyphs;
  /** Marque de troncature d'une cellule trop étroite. */
  ellipsis: string;
}

const UNICODE: Glyphs = {
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
  },
  status: {
    mark: "▞▚",
    running: "●",
    stalled: "◌",
    done: "✓",
    failed: "✗",
    warn: "⚠",
    tool: "▸",
    file: "~",
    question: "?",
    speech: "»",
    bullet: "·",
  },
  ellipsis: "…",
};

const ASCII: Glyphs = {
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    teeDown: "+",
    teeUp: "+",
    teeLeft: "+",
    teeRight: "+",
    cross: "+",
  },
  status: {
    mark: "::",
    running: "*",
    stalled: "o",
    done: "+",
    failed: "x",
    warn: "!",
    tool: ">",
    file: "~",
    question: "?",
    speech: "\"",
    bullet: "-",
  },
  // Un seul point, et non trois : la troncature doit coûter une colonne, la
  // même que "…", sinon toute la largeur calculée par `renderTable` est fausse.
  ellipsis: ".",
};

/**
 * Le terminal sait-il afficher de l'Unicode ?
 *
 * `LC_ALL` l'emporte sur `LC_CTYPE`, qui l'emporte sur `LANG` — c'est l'ordre
 * de la norme POSIX. **Quand aucune des trois n'est posée, on répond oui** :
 * c'est le cas courant sous macOS, où les terminaux sont en UTF-8 sans rien
 * déclarer. Répondre non par prudence priverait la majorité des utilisateurs
 * du thème pour protéger une minorité qui, elle, se signale toujours
 * explicitement (`LC_ALL=C`).
 */
export function supportsUnicode(env: Environment): boolean {
  const locale = env["LC_ALL"] ?? env["LC_CTYPE"] ?? env["LANG"];
  if (locale === undefined || locale === "") return true;
  return /utf-?8/i.test(locale);
}

export function glyphsFor(env: Environment): Glyphs {
  return supportsUnicode(env) ? UNICODE : ASCII;
}

export { UNICODE as UNICODE_GLYPHS, ASCII as ASCII_GLYPHS };
