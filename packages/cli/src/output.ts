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

/** Tableau texte simple, colonnes alignées par des espaces. Aucune dépendance. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const renderRow = (cols: string[]): string => cols.map((col, i) => (col ?? "").padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}
