/**
 * Le logotype et le bandeau de commande.
 *
 * Le logotype suit le style « ANSI Shadow » : le corps de chaque lettre est
 * en blocs pleins (`█`), et son flanc droit comme sa base portent une ombre
 * en traits doubles (`╗ ║ ╚ ═`), ce qui donne du relief sans deuxième
 * couleur. Chaque lettre occupe 8 colonnes, ombre et respiration comprises —
 * les glyphes s'accolent donc sans séparateur : 48 colonnes sur 6 lignes.
 *
 * Sans Unicode, ni les blocs pleins ni les traits doubles n'existent : le
 * repli n'essaie pas d'imiter le dessin en `#`, ce qui donnerait un pavé
 * grossier ; il rend une seule ligne, et l'assume.
 */
import type { ColorDepth } from "./ansi.js";
import { paint } from "./ansi.js";
import type { Glyphs } from "./glyphs.js";
import { ACCENT, ACCENT_RAMP, BORDER, DIM } from "./palette.js";

/**
 * Les six lignes du logotype, non colorées. Chacune fait exactement
 * `WORDMARK_WIDTH` colonnes — les espaces intérieurs et de fin de chaque
 * glyphe de 8 colonnes sont significatifs pour l'alignement des lettres
 * suivantes.
 */
export const WORDMARK_LINES: readonly string[] = [
  " ██████╗ █████╗ ███████╗███████╗ █████╗ ██████╗ ",
  "██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗",
  "██║     ███████║█████╗  ███████╗███████║██████╔╝",
  "██║     ██╔══██║██╔══╝  ╚════██║██╔══██║██╔══██╗",
  "╚██████╗██║  ██║███████╗███████║██║  ██║██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

export const WORDMARK_WIDTH = 48;

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
