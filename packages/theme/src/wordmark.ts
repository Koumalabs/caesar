/**
 * Le logotype et le bandeau de commande.
 *
 * Le logotype est du pixel art au sens propre : chaque cellule du terminal
 * porte **deux** pixels verticaux, du demi-bloc haut (`▀`) au demi-bloc bas
 * (`▄`) en passant par le bloc plein (`█`). Les lettres sont dessinées sur
 * une grille de 5 × 8 pixels, repliée en 4 lignes de texte — d'où sa densité :
 * 35 colonnes sur 4 lignes, là où un logotype ASCII de même hauteur apparente
 * en demanderait 8.
 *
 * Sans Unicode, il n'y a pas de pixel art possible : les demi-blocs *sont* la
 * technique. Le repli n'essaie donc pas de l'imiter en `#`, ce qui donnerait
 * un dessin grossier et deux fois trop haut ; il rend une seule ligne, et
 * l'assume.
 */
import type { ColorDepth } from "./ansi.js";
import { paint } from "./ansi.js";
import type { Glyphs } from "./glyphs.js";
import { ACCENT, ACCENT_RAMP, BORDER, DIM } from "./palette.js";

/**
 * Les quatre lignes du logotype, non colorées. Chacune fait exactement
 * `WORDMARK_WIDTH` colonnes — les espaces de fin des lettres « C », « E »
 * et « S » sont significatifs pour l'alignement des lettres suivantes.
 */
export const WORDMARK_LINES: readonly string[] = [
  "▄▀▀▀▀ ▄▀▀▀▄ █▀▀▀▀ ▄▀▀▀▀ ▄▀▀▀▄ █▀▀▀▄",
  "█     █▄▄▄█ █▄▄▄  ▀▄▄▄  █▄▄▄█ █▄▄▄▀",
  "█     █   █ █         █ █   █ █  ▀▄",
  " ▀▀▀▀ ▀   ▀ ▀▀▀▀▀ ▀▀▀▀  ▀   ▀ ▀   ▀",
];

export const WORDMARK_WIDTH = 35;

/**
 * Le logotype, une couleur de la rampe par ligne — la lumière vient d'en
 * haut. Sans Unicode ou sans couleur, ce qui reste est le nom lui-même.
 */
export function renderWordmark(glyphs: Glyphs, depth: ColorDepth, tagline?: string): string[] {
  const unicode = glyphs.box.horizontal === "─";
  const lines = unicode
    ? WORDMARK_LINES.map((line, i) => paint(line, { hex: ACCENT_RAMP[i] ?? ACCENT }, depth))
    : [paint("CAESAR", { hex: ACCENT, bold: true }, depth)];
  if (tagline === undefined) return lines;
  // Aligné sous la deuxième lettre plutôt que sur le bord : le logotype a
  // déjà un bord gauche franc, et une accroche qui s'en écarte se lit comme
  // une légende plutôt que comme une deuxième ligne de titre.
  const indent = unicode ? "  " : "";
  return [...lines, indent + paint(tagline, { hex: DIM }, depth)];
}

/**
 * Le bandeau d'une ligne qui ouvre chaque commande :
 * `▞▚ caesar · doctor ─────────────────────`.
 *
 * Il occupe toute la largeur disponible. Sa fonction est de séparer une
 * invocation de la précédente dans le défilement du terminal — c'est
 * l'endroit où l'œil revient quand on remonte, et rien ne le marquait.
 */
export function renderSectionRule(label: string, width: number, glyphs: Glyphs, depth: ColorDepth): string {
  const head = `${glyphs.status.mark} caesar ${glyphs.status.bullet} ${label} `;
  const rule = glyphs.box.horizontal.repeat(Math.max(0, width - head.length));
  return (
    paint(glyphs.status.mark, { hex: ACCENT }, depth) +
    paint(" caesar ", { hex: DIM }, depth) +
    paint(glyphs.status.bullet, { hex: BORDER }, depth) +
    " " +
    paint(label, { hex: ACCENT, bold: true }, depth) +
    " " +
    paint(rule, { hex: BORDER }, depth)
  );
}
