/**
 * `caesar ps|logs|cancel|diff|apply`.
 */
import { readFile } from "node:fs/promises";
import type { CaesarEvent } from "@caesar/protocol";
import { EventSchema, readEvents, taskPaths } from "@caesar/protocol";
import type { TaskRecord, TaskStatus, TaskStore } from "@caesar/core";
import { applyRecordedWorktree, diffWorktree, fileTaskStore, formatDuration, loadWorktreeHandle, sweepAbandonedTasks } from "@caesar/core";
import type { Cell, Io, ThemeToken } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  activeGlyphs,
  printError,
  printJson,
  printTable,
  printWarning,
  sectionHeader,
  writeLine,
} from "../output.js";
import { createFileTail } from "../tail.js";

const KNOWN_STATUSES: readonly TaskStatus[] = ["pending", "running", "succeeded", "failed", "cancelled", "timed_out"];
const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];
const DEFAULT_RECENT_LIMIT = 10;
/** Intervalle de scrutation en mode `--follow` : pas d'API de notification de fichier ici, on relit à intervalle court. */
const FOLLOW_POLL_MS = 150;

function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** L'issue du processus, dite par la couleur autant que par le mot. */
function statusToken(status: TaskStatus): ThemeToken {
  if (status === "running") return "accent";
  if (status === "pending") return "dim";
  if (status === "succeeded") return "ok";
  return "bad";
}

/** L'issue déclarée par l'agent — `partial` et `blocked` appellent l'œil sans être des échecs. */
function reportToken(report: string): ThemeToken {
  if (report === "success") return "ok";
  if (report === "partial" || report === "blocked") return "warn";
  if (report === "failed") return "bad";
  return "dim";
}

/**
 * L'âge d'une tâche, plutôt que sa date de création.
 *
 * Un horodatage ISO occupe vingt-quatre colonnes pour dire ce qu'« il y a
 * 2m14s » dit en onze, et il oblige à faire la soustraction de tête. La date
 * exacte reste dans `--json`, où elle a un lecteur qui en a l'usage.
 */
function age(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "-";
  return `il y a ${formatDuration(now - at)}`;
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

export interface PsOptions {
  status?: string;
  json?: boolean;
}

export async function runPs(root: string, options: PsOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);

  // `ps` est le premier endroit où se voit une tâche dont l'orchestrateur est
  // mort sans la conclure — elle y reste "running" à vie, en tête de liste,
  // sans que rien ne dise que plus personne ne la conduit. C'est donc aussi le
  // premier endroit où cet état doit se réparer, comme les autres verrous du
  // dépôt se réparent à la lecture (`reclaimDead`, `purgeLease`).
  //
  // Une lecture qui écrit demande à être justifiée : le balayage n'agit que
  // sur une preuve positive — le marqueur de la tâche nomme un processus qui
  // n'existe plus — et n'inscrit qu'un fait déjà vrai. Il ne doit pour autant
  // jamais empêcher la liste de s'afficher : un `.caesar/state/` illisible est
  // un ennui à signaler, pas une raison de ne plus rien montrer.
  try {
    await sweepAbandonedTasks(root, store);
  } catch (error) {
    printWarning(io, `Tâches abandonnées non réconciliées : ${error instanceof Error ? error.message : String(error)}`);
  }

  let records: TaskRecord[];
  if (options.status) {
    const statuses = options.status.split(",").map((s) => s.trim());
    const invalid = statuses.filter((s) => !KNOWN_STATUSES.includes(s as TaskStatus));
    if (invalid.length > 0) {
      printError(io, `Statut(s) inconnu(s) : ${invalid.join(", ")} (attendu l'un de : ${KNOWN_STATUSES.join(", ")}).`);
      return EXIT_USAGE;
    }
    records = await store.list({ status: statuses as TaskStatus[] });
  } else {
    const all = await store.list();
    const active = all.filter((r) => isActive(r.status));
    const finished = all
      .filter((r) => !isActive(r.status))
      .sort((a, b) => (b.ended_at ?? b.created_at).localeCompare(a.ended_at ?? a.created_at))
      .slice(0, DEFAULT_RECENT_LIMIT);
    records = [...active, ...finished];
  }

  records = [...records].sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (options.json) {
    printJson(io, { tasks: records });
    return EXIT_OK;
  }

  sectionHeader(io, "ps");
  if (records.length === 0) {
    writeLine(io.stdout, "Aucune tâche.");
    return EXIT_OK;
  }

  // Six colonnes, et non huit. L'agent porte son rôle, le mode porte son
  // isolation : ces couples se lisent ensemble et se cherchent ensemble, et
  // les séparer coûtait deux colonnes qu'un cadre à 80 caractères n'a pas.
  //
  // "rapport" reste en revanche distinct de "statut" (I3 de la revue finale) :
  // "statut" ne reflète que l'issue du processus, jamais ce que l'agent a
  // déclaré dans son rapport — une tâche "succeeded" au niveau processus peut
  // porter un rapport "failed"/"partial"/"blocked", et c'est précisément
  // l'écart entre les deux qu'on vient lire ici.
  const bullet = activeGlyphs().status.bullet;
  const now = Date.now();
  const rows: Cell[][] = records.map((r) => [
    r.id,
    r.role ? `${r.agent} ${bullet} ${r.role}` : r.agent,
    { text: r.status, token: statusToken(r.status) },
    r.report_status ? { text: r.report_status, token: reportToken(r.report_status) } : "-",
    `${r.isolation} ${bullet} ${r.mode}`,
    { text: age(r.created_at, now), token: "dim" },
  ]);
  printTable(io, ["id", "agent", "statut", "rapport", "exécution", "âge"], rows);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export interface LogsOptions {
  raw?: boolean;
  follow?: boolean;
  json?: boolean;
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Transmet à `onChunk` chaque nouveau segment de `path`, jusqu'à ce que la
 * tâche `id` ne soit plus active.
 *
 * Le suivi par décalage lui-même vit dans `../tail.js` : `caesar watch` en a
 * besoin aussi, avec une condition d'arrêt différente (plusieurs tâches, et
 * une fenêtre qui reste ouverte après leur fin).
 */
async function tailFile(store: TaskStore, id: string, path: string, onChunk: (chunk: string) => void): Promise<void> {
  const tail = createFileTail(path);
  const emitNew = async (): Promise<void> => {
    const chunk = await tail.read();
    if (chunk !== "") onChunk(chunk);
  };

  for (;;) {
    await emitNew();
    const record = await store.get(id);
    if (!record || !isActive(record.status)) {
      await emitNew();
      return;
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, FOLLOW_POLL_MS));
  }
}

function formatEvent(event: CaesarEvent): string {
  switch (event.type) {
    case "started":
      return `[${event.seq}] démarré — ${event.command}`;
    case "thinking":
      return `[${event.seq}] réflexion : ${event.text}`;
    case "message":
      return `[${event.seq}] message : ${event.text}`;
    case "tool_use":
      return `[${event.seq}] outil ${event.tool} (${event.status})${event.input_summary ? ` — ${event.input_summary}` : ""}`;
    case "file_changed":
      return `[${event.seq}] fichier ${event.action} : ${event.path}`;
    case "progress":
      return `[${event.seq}] progression : ${event.message}${event.pct !== undefined ? ` (${event.pct}%)` : ""}`;
    case "question":
      return `[${event.seq}] question : ${event.question}`;
    case "answer":
      return `[${event.seq}] réponse : ${event.answer}`;
    case "error":
      return `[${event.seq}] erreur : ${event.message}`;
    case "finished":
      return `[${event.seq}] terminé — statut ${event.status}`;
  }
}

/**
 * Traite une ligne de `events.jsonl` pendant le suivi (`--follow`). Une ligne
 * JSON invalide ou ne validant pas `EventSchema` est abandonnée — le suivi ne
 * doit pas s'interrompre pour un événement isolé — mais signalée sur
 * `stderr` : un abandon muet masquerait un désalignement de schéma entre ce
 * qu'écrit le moteur et ce que ce CLI sait lire. `stdout` reste réservé au
 * NDJSON exploitable (`--json`) ou à l'affichage formaté : jamais de
 * diagnostic dessus.
 */
function printFollowedLine(io: Io, rawLine: string, json: boolean | undefined): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    printWarning(io, `Ligne ignorée (JSON invalide) : ${rawLine}`);
    return;
  }
  const result = EventSchema.safeParse(parsed);
  if (!result.success) {
    printWarning(io, `Ligne ignorée (ne respecte pas le schéma d'événement) : ${rawLine}`);
    return;
  }
  if (json) printJson(io, result.data);
  else writeLine(io.stdout, formatEvent(result.data));
}

export async function runLogs(root: string, id: string, options: LogsOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Tâche inconnue : "${id}".`);
    return EXIT_USAGE;
  }
  const paths = taskPaths(record.task_dir);

  if (options.raw) {
    if (options.follow) {
      await tailFile(store, id, paths.rawLog, (chunk) => io.stdout.write(chunk));
    } else {
      writeLine(io.stdout, (await readTextSafe(paths.rawLog)).replace(/\n+$/, ""));
    }
    return EXIT_OK;
  }

  if (options.follow) {
    let buffer = "";
    await tailFile(store, id, paths.eventsPath, (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) printFollowedLine(io, line, options.json);
      }
    });
    return EXIT_OK;
  }

  const events = await readEvents(paths);
  if (options.json) {
    printJson(io, { events });
  } else {
    for (const event of events) writeLine(io.stdout, formatEvent(event));
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface CancelOptions {
  json?: boolean;
}

function reportCancel(io: Io, json: boolean | undefined, id: string, cancelled: boolean, message: string): number {
  if (json) printJson(io, { id, cancelled, message });
  else writeLine(io.stdout, message);
  return EXIT_OK;
}

export async function runCancel(root: string, id: string, options: CancelOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Tâche inconnue : "${id}".`);
    return EXIT_USAGE;
  }

  if (!isActive(record.status)) {
    return reportCancel(io, options.json, id, false, `Tâche "${id}" déjà terminée (statut "${record.status}") : rien à annuler.`);
  }

  if (record.pid === undefined) {
    return reportCancel(
      io,
      options.json,
      id,
      false,
      `Tâche "${id}" en cours, mais aucun identifiant de processus n'est enregistré : impossible de l'annuler depuis ce processus.`,
    );
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      await store.update(id, { status: "cancelled", ended_at: new Date().toISOString(), pid: undefined });
      return reportCancel(io, options.json, id, true, `Tâche "${id}" : le processus (pid ${record.pid}) n'existe déjà plus. Marquée annulée.`);
    }
    throw error;
  }

  await store.update(id, { status: "cancelled", ended_at: new Date().toISOString() });
  return reportCancel(io, options.json, id, true, `Tâche "${id}" annulée (SIGTERM envoyé au pid ${record.pid}).`);
}

// ---------------------------------------------------------------------------
// diff / apply
// ---------------------------------------------------------------------------
// `loadWorktreeHandle` vit désormais dans `@caesar/core` (`engine/worktree.ts`)
// — partagée avec le serveur MCP (`caesar_diff`/`caesar_apply`), voir le rapport
// de correction de la tâche 7.

export interface DiffOptions {
  json?: boolean;
}

export async function runDiff(root: string, id: string, options: DiffOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Tâche inconnue : "${id}".`);
    return EXIT_USAGE;
  }

  const handle = await loadWorktreeHandle(record);
  if (!handle) {
    const message = `Tâche "${id}" : isolation "${record.isolation}", pas de worktree à diffuser.`;
    if (options.json) printJson(io, { id, is_empty: true, files: [], patch: "", message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  const diff = await diffWorktree(handle);
  if (options.json) {
    printJson(io, { id, files: diff.files, is_empty: diff.isEmpty, patch: diff.patch });
  } else if (diff.isEmpty) {
    writeLine(io.stdout, "Aucune modification.");
  } else {
    writeLine(io.stdout, diff.patch);
  }
  return EXIT_OK;
}

export interface ApplyOptions {
  json?: boolean;
}

export async function runApply(root: string, id: string, options: ApplyOptions, io: Io): Promise<number> {
  const store = fileTaskStore(root);
  const record = await store.get(id);
  if (!record) {
    printError(io, `Tâche inconnue : "${id}".`);
    return EXIT_USAGE;
  }

  const result = await applyRecordedWorktree(root, store, record);
  if (result.outcome === "no_worktree") {
    const message = `Tâche "${id}" : isolation "${record.isolation}", rien à appliquer.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: [], message });
    else writeLine(io.stdout, message);
    return EXIT_OK;
  }

  if (result.outcome === "conflicts") {
    const message = `Conflits en appliquant la tâche "${id}" : ${result.conflicts.join(", ")}.`;
    if (options.json) printJson(io, { id, applied: false, conflicts: result.conflicts });
    else printError(io, message);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { id, applied: true, conflicts: [] });
  else writeLine(io.stdout, `Tâche "${id}" appliquée au dépôt principal.`);
  return EXIT_OK;
}
