/**
 * Répartition de la largeur entre les colonnes d'un tableau, et découpe du
 * texte — la partie calculatoire de l'affichage, isolée du rendu pour être
 * testable seule.
 *
 * Le défaut que ce module existe pour corriger : les tableaux du TUI
 * complétaient chaque cellule à une largeur *conventionnelle* écrite en dur
 * (`fitColumn(path, 26)`), sans gouttière et sans regarder la largeur réelle
 * du terminal. Deux conséquences, toutes deux visibles à l'usage :
 *
 *  - une valeur tronquée collait à la cellule suivante — l'élision et la
 *    valeur voisine se lisaient comme un seul mot
 *    (`/Users/…/bin…codex-cli 0.1…7 notable(s)`) ;
 *  - sur un terminal large, le tableau restait tassé sur 80 colonnes pendant
 *    que les chemins, eux, étaient coupés faute de place.
 *
 * Ici, les largeurs se déduisent de la place disponible : chaque colonne
 * annonce un minimum et une part de l'excédent (`flex`), et la gouttière est
 * garantie parce qu'elle est retirée avant tout partage.
 */

export interface ColumnWidthSpec {
  /** Largeur minimale. À défaut, la longueur de l'en-tête : une colonne n'est jamais plus étroite que son titre. */
  min?: number;
  /** Part de l'excédent de largeur. 0 (le défaut) : la colonne reste à son minimum. */
  flex?: number;
  /**
   * Largeur au-delà de laquelle la colonne cesse de grandir. Sans plafond, une
   * colonne flexible sur un terminal large s'étire bien au-delà de ce qu'elle
   * a à montrer — quarante caractères pour afficher « 0.1.7 » — et éloigne
   * inutilement ses voisines l'une de l'autre.
   */
  max?: number;
  /** Longueur de l'en-tête, plancher implicite du minimum. */
  header: string;
}

/** En deçà, une cellule ne porte plus que l'élision : on ne rétrécit jamais une colonne à moins que ça. */
const MIN_CELL = 4;

/**
 * Largeur de chaque colonne pour `available` colonnes de terminal, gouttières
 * comprises. Le total rendu, augmenté des `(n - 1) * gutter` séparateurs,
 * n'excède jamais `available` — c'est la propriété qui empêche le terminal de
 * replier une ligne de tableau sur la suivante, ce qui rendait la vue
 * illisible précisément là où elle devait renseigner.
 *
 * Quand la place manque, les colonnes rétrécissent proportionnellement à leur
 * minimum plutôt qu'en sacrifiant la dernière : une colonne « autorisation »
 * amputée en bout de ligne est aussi inutile qu'un chemin amputé.
 */
export function layoutColumns(specs: readonly ColumnWidthSpec[], available: number, gutter = 2): number[] {
  if (specs.length === 0) return [];

  const gutters = (specs.length - 1) * gutter;
  const room = Math.max(specs.length * MIN_CELL, available - gutters);
  const widths = specs.map((spec) => Math.max(MIN_CELL, spec.min ?? spec.header.length));
  const total = widths.reduce((sum, width) => sum + width, 0);

  if (total <= room) {
    // Distribution par tours : chaque tour donne `flex` caractères à chaque
    // colonne encore sous son plafond. Le rapport entre colonnes flexibles est
    // ainsi respecté exactement, et une colonne qui atteint son plafond sort
    // du partage sans bloquer les autres. La place qu'aucune colonne ne peut
    // plus prendre reste inutilisée — un bord droit irrégulier vaut mieux
    // qu'une colonne étirée pour rien.
    let slack = room - total;
    while (slack > 0) {
      let given = 0;
      for (const [index, spec] of specs.entries()) {
        const flex = spec.flex ?? 0;
        if (flex === 0 || slack === 0) continue;
        const step = Math.min(flex, slack, (spec.max ?? Number.POSITIVE_INFINITY) - widths[index]!);
        if (step <= 0) continue;
        widths[index] = widths[index]! + step;
        slack -= step;
        given += step;
      }
      if (given === 0) break;
    }
    return widths;
  }

  // Trop étroit : on rabote proportionnellement, sans jamais passer sous
  // `MIN_CELL`. La boucle redistribue ce que ce plancher a empêché de retirer.
  let excess = total - room;
  while (excess > 0) {
    const shrinkable = widths.map((width, index) => (width > MIN_CELL ? index : -1)).filter((index) => index >= 0);
    if (shrinkable.length === 0) break;
    for (const index of shrinkable) {
      if (excess === 0) break;
      widths[index] = widths[index]! - 1;
      excess -= 1;
    }
  }
  return widths;
}

/**
 * `text` complété ou tronqué à exactement `width` caractères. Une valeur trop
 * longue perd sa fin au profit d'une élision — jamais au profit de la colonne
 * voisine.
 */
export function cell(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/**
 * `text` raccourci **par la gauche** à `width` caractères. Pour un chemin,
 * c'est la fin qui renseigne (`…/mon-projet/.orch/config.toml`) : le tronquer
 * par la droite comme une valeur ordinaire laisserait le préfixe commun à
 * tous les chemins de la machine, c'est-à-dire rien.
 */
export function elideLeft(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `…${text.slice(text.length - (width - 1))}`;
}

/**
 * Découpe `text` en lignes d'au plus `width` caractères, sur les espaces. Un
 * mot plus long que la largeur est coupé plutôt que de déborder — un chemin
 * ou une commande n'a pas d'espace où se replier.
 *
 * Utilisé par les panneaux de détail, où les phrases longues (le motif d'un
 * refus de politique, en particulier) partaient jusqu'ici hors de l'écran.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      let piece = word;
      // Un mot plus long que la ligne entière : on le débite par tranches
      // pleines avant de reprendre l'accumulation normale.
      while (piece.length > width) {
        if (current.length > 0) {
          lines.push(current);
          current = "";
        }
        lines.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      if (current.length === 0) current = piece;
      else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
    lines.push(current);
  }

  return lines;
}
