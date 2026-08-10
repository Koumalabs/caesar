/**
 * Mise en forme partagée par toutes les sous-commandes : tableaux, couleurs,
 * `--json`, et la séparation stdout/stderr.
 *
 * Chaque commande reçoit un `Io` plutôt que d'écrire directement sur
 * `process.stdout`/`process.stderr` : c'est ce qui permet aux tests
 * d'appeler les fonctions de commande directement, avec une sortie
 * capturée, sans jamais lancer de sous-processus (voir le brief de la
 * tâche 6).
 *
 * `--json` n'est pas une décoration : c'est le canal par lequel un agent
 * consomme ce CLI. Une sortie `--json` ne doit donc jamais porter de
 * séquence ANSI ni de ligne parasite sur `stdout` — les erreurs et les
 * avertissements vont systématiquement sur `stderr`.
 */
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

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

type AnsiCode = keyof typeof ANSI;

/** Un flux Node avec `isTTY` — vrai pour `process.stdout`/`process.stderr`, jamais pour un flux de capture de test. */
interface MaybeTty extends Writable {
  isTTY?: boolean;
}

function colorEnabled(stream: Writable): boolean {
  if (process.env["NO_COLOR"]) return false;
  return Boolean((stream as MaybeTty).isTTY);
}

/** Colore `text` avec `code`, seulement si `stream` est un terminal et que `NO_COLOR` n'est pas défini. */
export function colorize(text: string, code: AnsiCode, stream: Writable): string {
  if (!colorEnabled(stream)) return text;
  return `${ANSI[code]}${text}${ANSI.reset}`;
}

export function writeLine(stream: Writable, text = ""): void {
  stream.write(text + "\n");
}

/** Sortie `--json` : uniquement le JSON, rien d'autre, jamais de couleur. */
export function printJson(io: Io, data: unknown): void {
  writeLine(io.stdout, JSON.stringify(data, null, 2));
}

export function printError(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "red", io.stderr));
}

export function printWarning(io: Io, message: string): void {
  writeLine(io.stderr, colorize(message, "yellow", io.stderr));
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

/** Deux espaces entre colonnes, comme la mise en forme d'origine. */
const COLUMN_GAP = 2;

/**
 * En dessous, une colonne ne porte plus d'information : on cesse de la
 * rétrécir et on laisse le tableau dépasser plutôt que de rendre chaque
 * cellule illisible.
 */
const MIN_COLUMN_WIDTH = 6;

/** Largeur du terminal, ou 80 quand la sortie n'en est pas un (redirection, `--json` d'un script, tests). */
export function terminalWidth(stream?: Writable): number {
  const columns = (stream as { columns?: number } | undefined)?.columns ?? process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : 80;
}

/** Tronque à `width` en marquant la coupe, pour qu'une cellule rognée se voie. */
function fitCell(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return "…".repeat(Math.max(0, width));
  return text.slice(0, width - 1) + "…";
}

/**
 * Rabote les colonnes les plus larges jusqu'à tenir dans `budget`.
 *
 * La plus large paie en premier : une colonne étroite porte en général une
 * valeur courte et entière (un identifiant, un statut), là où une colonne
 * large porte une énumération dont la fin se devine. On s'arrête dès que
 * toutes ont atteint `MIN_COLUMN_WIDTH` — mieux vaut un tableau qui déborde
 * qu'un tableau réduit à des points de suspension.
 */
function shrinkColumns(widths: number[], budget: number): number[] {
  const out = [...widths];
  const total = (): number => out.reduce((sum, w) => sum + w, 0) + COLUMN_GAP * Math.max(0, out.length - 1);
  while (total() > budget) {
    let widest = 0;
    for (let i = 1; i < out.length; i += 1) if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i;
    if ((out[widest] ?? 0) <= MIN_COLUMN_WIDTH) break;
    out[widest] = (out[widest] ?? 0) - 1;
  }
  return out;
}

/**
 * Tableau texte simple, colonnes alignées par des espaces. Aucune dépendance.
 *
 * Les colonnes prennent la largeur de leur contenu, **plafonnée à celle du
 * terminal** : sans ce plafond, une seule cellule longue — l'énumération des
 * capacités dans `orch doctor`, un chemin de binaire — poussait la dernière
 * colonne au-delà du bord, où le terminal la repliait sur la ligne suivante.
 * Le tableau devenait alors illisible précisément là où il devait renseigner.
 */
export function renderTable(headers: string[], rows: string[][], maxWidth = terminalWidth()): string {
  const natural = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const widths = shrinkColumns(natural, maxWidth);
  const renderRow = (cols: string[]): string =>
    cols.map((col, i) => fitCell(col ?? "", widths[i] ?? 0).padEnd(widths[i] ?? 0)).join(" ".repeat(COLUMN_GAP));
  const separator = widths.map((width) => "-".repeat(width)).join(" ".repeat(COLUMN_GAP));
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}
