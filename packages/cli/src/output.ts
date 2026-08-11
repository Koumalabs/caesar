/**
 * Mise en forme partagée par toutes les sous-commandes : bandeaux, tableaux,
 * couleurs, `--json`, et la séparation stdout/stderr.
 *
 * Chaque commande reçoit un `Io` plutôt que d'écrire directement sur
 * `process.stdout`/`process.stderr` : c'est ce qui permet aux tests
 * d'appeler les fonctions de commande directement, avec une sortie
 * capturée, sans jamais lancer de sous-processus (voir le brief de la
 * tâche 6).
 *
 * ## Les trois canaux
 *
 * Une même commande écrit vers trois destinataires très différents, et ce
 * module est l'endroit où la distinction se fait une fois pour toutes :
 *
 *  1. **`--json`** — un agent, ou un script. Le JSON, rien d'autre : jamais
 *     de séquence ANSI, jamais de bandeau, jamais une ligne parasite sur
 *     `stdout`. Les erreurs et les avertissements partent sur `stderr`.
 *  2. **Hors terminal** (tuyau, redirection, tests) — un humain qui lira
 *     plus tard, ou un test. La **structure** est rendue (bandeaux,
 *     encadrés, entêtes), la **couleur** ne l'est pas : elle n'aurait aucun
 *     destinataire, et elle rendrait la sortie impossible à comparer.
 *  3. **Terminal** — structure et couleur.
 *
 * La règle 2 est ce qui rend le thème testable : un test capture un flux
 * sans `isTTY`, donc voit exactement la structure et jamais les couleurs.
 * Pour éprouver les couleurs elles-mêmes, il pose `isTTY = true` sur le flux
 * capturé.
 */
import type { ColorDepth, Glyphs } from "@orch/theme";
import {
  ACCENT,
  BAD,
  BORDER,
  DIM,
  FAINT,
  OK,
  WARN,
  detectColorDepth,
  glyphsFor,
  paint,
  renderSectionRule,
  renderWordmark,
} from "@orch/theme";
import { homedir } from "node:os";
import type { Writable } from "node:stream";

/** Flux de sortie d'une commande. `process.stdout`/`process.stderr` en usage réel, capturés en test. */
export interface Io {
  stdout: Writable;
  stderr: Writable;
}

/** Le `Io` réel du process courant, utilisé par `bin.ts`. */
export const processIo: Io = { stdout: process.stdout, stderr: process.stderr };

/** Codes de sortie, valables pour toutes les commandes (voir le brief). */
export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/**
 * Les rôles que le texte peut jouer — jamais une couleur nommée.
 *
 * C'est le point du thème : `colorize(x, "green")` est une décision prise sur
 * place, que rien ne relie aux autres ; `colorize(x, "ok")` est une décision
 * prise une fois, dans la palette. La ligne de commande choisissait
 * jusqu'ici parmi sept codes ANSI, au cas par cas, ce qui revenait à n'avoir
 * aucun thème.
 *
 * `strong` ne porte volontairement pas de couleur : le texte principal hérite
 * de l'avant-plan du terminal, donc reste lisible sur fond clair comme sur
 * fond sombre (règle 1 de la palette).
 */
const TOKENS = {
  accent: { hex: ACCENT },
  title: { hex: ACCENT, bold: true },
  strong: { bold: true },
  dim: { hex: DIM },
  faint: { hex: FAINT },
  border: { hex: BORDER },
  ok: { hex: OK },
  warn: { hex: WARN },
  bad: { hex: BAD },
} as const satisfies Record<string, { hex?: string; bold?: boolean }>;

export type ThemeToken = keyof typeof TOKENS;

/** Un flux Node avec `isTTY` — vrai pour `process.stdout`/`process.stderr`, jamais pour un flux de capture de test. */
interface MaybeTty extends Writable {
  isTTY?: boolean;
}

/**
 * Ce que ce flux-ci sait rendre.
 *
 * La décision est **par flux** et non par processus : `stdout` peut être
 * redirigé vers un fichier pendant que `stderr` reste attaché au terminal.
 * Colorer les deux de la même façon écrirait des séquences ANSI dans le
 * fichier, ou en priverait le terminal.
 */
export function colorDepth(stream: Writable): ColorDepth {
  if (!(stream as MaybeTty).isTTY) return "none";
  return detectColorDepth(process.env);
}

/** Le jeu de caractères de dessin adapté à la locale courante. */
export function activeGlyphs(): Glyphs {
  return glyphsFor(process.env);
}

/** Habille `text` du rôle `token`, seulement si `stream` sait le rendre. */
export function colorize(text: string, token: ThemeToken, stream: Writable): string {
  return paint(text, TOKENS[token], colorDepth(stream));
}

export function writeLine(stream: Writable, text = ""): void {
  stream.write(text + "\n");
}

/** Sortie `--json` : uniquement le JSON, rien d'autre, jamais de couleur. */
export function printJson(io: Io, data: unknown): void {
  writeLine(io.stdout, JSON.stringify(data, null, 2));
}

export function printError(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "bad", io.stderr));
}

export function printWarning(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "warn", io.stderr));
}

/**
 * Le bandeau qui ouvre une commande, suivi d'une ligne vide.
 *
 * Il sépare une invocation de la précédente dans le défilement du terminal —
 * c'est l'endroit où l'œil revient quand on remonte, et rien ne le marquait.
 * À n'appeler qu'**après** la branche `--json`, jamais avant : une ligne de
 * décoration sur `stdout` casserait la sortie machine.
 */
export function sectionHeader(io: Io, label: string): void {
  writeLine(io.stdout, renderSectionRule(label, terminalWidth(io.stdout), activeGlyphs(), colorDepth(io.stdout)));
  writeLine(io.stdout);
}

/**
 * Une ligne de confirmation : ce qui vient d'être fait, marqué comme tel.
 *
 * Une commande qui écrit un fichier rendait jusqu'ici une phrase nue,
 * impossible à distinguer d'un avertissement ou d'un rappel dans le
 * défilement. La marque la classe avant qu'elle ne soit lue.
 */
export function printDone(io: Io, message: string): void {
  writeLine(io.stdout, `${colorize(activeGlyphs().status.done, "ok", io.stdout)} ${message}`);
}

/**
 * Une précision qui accompagne, sans être ce qu'on est venu lire.
 *
 * Repliée sur la largeur du terminal : ces phrases sont des phrases entières,
 * et elles débordaient sur un terminal étroit — le repli laissé au terminal
 * ramène la suite en colonne zéro, où elle se confond avec ce qui suit.
 */
export function printNote(io: Io, message: string): void {
  for (const line of wrapText(message, terminalWidth(io.stdout))) {
    writeLine(io.stdout, colorize(line, "dim", io.stdout));
  }
}

/**
 * L'intertitre d'une rubrique, dans le même dessin que les sections de
 * `orch --help` : capitale et demi-ton, jamais de ponctuation finale.
 *
 * Ce qui expliquait la rubrique passe en note dessous. Les deux étaient
 * jusqu'ici fondus dans une seule phrase — « Refusés par la politique — état
 * voulu, sauf si vous en décidez autrement : », soixante-quatorze
 * caractères — donc à la fois trop long pour un titre et trop court pour se
 * replier proprement.
 */
export function printHeading(io: Io, title: string): void {
  writeLine(io.stdout, colorize(title.toUpperCase(), "faint", io.stdout));
}

/** Un couple libellé/valeur aligné, pour les vues en bloc plutôt qu'en tableau. */
export function printField(io: Io, label: string, value: string, width: number): void {
  writeLine(io.stdout, `${colorize(label.padEnd(width), "dim", io.stdout)}  ${value}`);
}

/**
 * Le logotype, réservé à la porte d'entrée : `orch --help` et la fin de
 * `orch init`. Nulle part ailleurs — un logotype réimprimé à chaque
 * invocation cesse d'être une identité pour devenir du bruit.
 */
export function bannerLines(stream: Writable, tagline?: string): string[] {
  return renderWordmark(activeGlyphs(), colorDepth(stream), tagline);
}

/**
 * Remplace le répertoire personnel par `~`.
 *
 * Dix caractères rendus à la colonne « binaire » d'`orch agents list`, qui
 * affichait jusqu'ici `/Users/prénom/.…` — un chemin tronqué à dix-sept
 * caractères, donc inutilisable. Le préfixe est ce que toutes les lignes ont
 * en commun : c'est exactement ce qui n'apprend rien.
 */
export function homePath(path: string): string {
  const home = homedir();
  if (home !== "" && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

/**
 * Replie un texte sur la largeur donnée, en coupant entre les mots.
 *
 * Les phrases de diagnostic — un remède, la raison d'un refus — sont longues
 * par nature. Laissées telles quelles, le terminal les replie lui-même, mais
 * sans indentation : la suite d'une puce revient en colonne zéro et se confond
 * avec l'élément suivant.
 *
 * Les préfixes sont appliqués **après** le découpage : `firstPrefix` ouvre la
 * première ligne, `nextPrefix` les suivantes, et `width` les compte. Les passer
 * ainsi plutôt que collés au texte évite le piège où le découpage sur les
 * blancs les avalerait.
 *
 * Un mot plus long que la largeur (un chemin, une URL) n'est pas coupé : le
 * tronquer le rendrait inutilisable, et le terminal saura le replier.
 */
export function wrapText(text: string, width: number, firstPrefix = "", nextPrefix = firstPrefix): string[] {
  const lines: string[] = [];
  const room = (): number => Math.max(1, width - (lines.length === 0 ? firstPrefix.length : nextPrefix.length));
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= room()) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line, i) => (i === 0 ? firstPrefix : nextPrefix) + line);
}

/** Deux espaces entre colonnes, dans la mise en page sans encadré. */
const PLAIN_GAP = 2;

/**
 * Ce qu'un encadré consomme **entre** deux colonnes : ` │ `. Les deux bords
 * extérieurs (`│ ` et ` │`) sont comptés à part, dans `BOX_EDGES`.
 */
const BOX_GAP = 3;
const BOX_EDGES = 4;

/**
 * En dessous, une colonne ne porte plus d'information : on cesse de la
 * rétrécir. Ce qui suit dépend alors de la mise en page — voir `printTable`.
 */
const MIN_COLUMN_WIDTH = 6;

/** Largeur du terminal, ou 80 quand la sortie n'en est pas un (redirection, `--json` d'un script, tests). */
export function terminalWidth(stream?: Writable): number {
  const columns = (stream as { columns?: number } | undefined)?.columns ?? process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : 80;
}

/** Tronque à `width` en marquant la coupe, pour qu'une cellule rognée se voie. */
function fitCell(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text;
  if (width <= 1) return ellipsis.repeat(Math.max(0, width));
  return text.slice(0, width - 1) + ellipsis;
}

/**
 * Rabote les colonnes les plus larges jusqu'à tenir dans `budget`.
 *
 * La plus large paie en premier : une colonne étroite porte en général une
 * valeur courte et entière (un identifiant, un statut), là où une colonne
 * large porte une énumération dont la fin se devine. On s'arrête dès que
 * toutes ont atteint `MIN_COLUMN_WIDTH`, sans garantir d'avoir tenu le
 * budget — c'est l'appelant qui décide quoi faire de cet échec.
 */
function shrinkColumns(widths: readonly number[], budget: number, gap: number): number[] {
  const out = [...widths];
  const total = (): number => out.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, out.length - 1);
  while (total() > budget) {
    let widest = 0;
    for (let i = 1; i < out.length; i += 1) if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i;
    if ((out[widest] ?? 0) <= MIN_COLUMN_WIDTH) break;
    out[widest] = (out[widest] ?? 0) - 1;
  }
  return out;
}

/**
 * Une cellule : un texte nu, ou un texte qui porte un rôle du thème.
 *
 * C'est ce qui permet à « autorisé » d'être vert et à « refusé » d'être rouge
 * sans que `printTable` ait à connaître le domaine, ni la commande à savoir
 * mettre en forme.
 */
export type Cell = string | { text: string; token: ThemeToken };

function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

export interface TableOptions {
  /** Largeur disponible. Défaut : celle du terminal de `io.stdout`. */
  maxWidth?: number;
}

/**
 * Un tableau encadré de traits fins. Aucune dépendance.
 *
 * **Le cadre est compté dans le budget de largeur.** Un encadré à N colonnes
 * consomme `3N+1` caractères de chrome : sans cette soustraction, la bordure
 * droite atterrit sur la ligne suivante, et un cadre rompu est bien moins
 * lisible qu'un tableau sans cadre.
 *
 * **Quand le cadre ne peut pas tenir, on y renonce.** Sur un terminal étroit,
 * aucune répartition ne fait entrer six ou huit colonnes dans un cadre sans
 * réduire chaque cellule à des points de suspension. La mise en page alignée
 * récupère alors le tiers de largeur que le cadre coûtait. Le repli est
 * silencieux et c'est voulu : il n'y a rien à signaler, seulement une largeur
 * à honorer.
 *
 * Reste le cas extrême, hérité et assumé : quand même six caractères par
 * colonne ne tiennent pas, `shrinkColumns` s'arrête et la mise en page
 * déborde. C'est le moindre mal — un tableau que le terminal replie sur deux
 * lignes reste lisible, un tableau dont chaque cellule vaut « … » ne l'est
 * plus.
 *
 * La couleur est appliquée **après** le calage : peindre avant compterait les
 * séquences ANSI comme des colonnes, et tout l'alignement serait faux.
 */
export function printTable(
  io: Io,
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  options: TableOptions = {},
): void {
  const glyphs = activeGlyphs();
  const depth = colorDepth(io.stdout);
  const maxWidth = options.maxWidth ?? terminalWidth(io.stdout);
  const count = headers.length;

  const natural = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cellText(row[i] ?? "").length)),
  );

  const boxBudget = maxWidth - BOX_EDGES;
  const boxWidths = shrinkColumns(natural, boxBudget, BOX_GAP);
  const boxTotal = boxWidths.reduce((sum, w) => sum + w, 0) + BOX_GAP * Math.max(0, count - 1);

  const widths = boxTotal <= boxBudget ? boxWidths : shrinkColumns(natural, maxWidth, PLAIN_GAP);
  const boxed = boxTotal <= boxBudget;

  const cells = (row: readonly Cell[], token?: ThemeToken): string[] =>
    widths.map((width, i) => {
      const cell = row[i] ?? "";
      const padded = fitCell(cellText(cell), width, glyphs.ellipsis).padEnd(width);
      const role = typeof cell === "string" ? token : cell.token;
      return role === undefined ? padded : paint(padded, TOKENS[role], depth);
    });

  if (!boxed) {
    // Mise en page alignée : entête, filet pleine largeur, corps.
    writeLine(io.stdout, cells(headers, "dim").join(" ".repeat(PLAIN_GAP)).trimEnd());
    const ruleWidth = widths.reduce((sum, w) => sum + w, 0) + PLAIN_GAP * Math.max(0, count - 1);
    writeLine(io.stdout, paint(glyphs.box.horizontal.repeat(ruleWidth), TOKENS.border, depth));
    for (const row of rows) writeLine(io.stdout, cells(row).join(" ".repeat(PLAIN_GAP)).trimEnd());
    return;
  }

  const { box } = glyphs;
  const segments = widths.map((width) => box.horizontal.repeat(width + 2));
  const rule = (left: string, middle: string, right: string): string =>
    paint(left + segments.join(middle) + right, TOKENS.border, depth);
  const bar = paint(box.vertical, TOKENS.border, depth);
  const line = (row: readonly Cell[], token?: ThemeToken): string =>
    `${bar} ${cells(row, token).join(` ${bar} `)} ${bar}`;

  writeLine(io.stdout, rule(box.topLeft, box.teeDown, box.topRight));
  writeLine(io.stdout, line(headers, "dim"));
  writeLine(io.stdout, rule(box.teeRight, box.cross, box.teeLeft));
  for (const row of rows) writeLine(io.stdout, line(row));
  writeLine(io.stdout, rule(box.bottomLeft, box.teeUp, box.bottomRight));
}
