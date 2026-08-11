/**
 * `orch watch` : regarder les sous-agents travailler.
 *
 * `orch ps` est un instantané, `orch logs --follow` suit une tâche dont il
 * faut déjà connaître l'identifiant. Quand trois délégations tournent en
 * parallèle, rien ne les montrait ensemble.
 *
 * Rien d'un démon n'est nécessaire pour cela : le moteur écrit `events.jsonl`
 * ligne à ligne **pendant** l'exécution (`spawn.ts`) et publie l'état des
 * tâches par `rename`/`link` atomiques (`store.ts`). Cette commande ne fait
 * que lire ce que d'autres processus écrivent — la même propriété qui fait
 * marcher `orch cancel` par pid et les créneaux de `max_parallel`.
 *
 * Deux rendus, selon la destination :
 *
 * - **terminal** — écran alterné, image redessinée, une vue d'ensemble ;
 * - **hors terminal** (redirigé, `| tee`, tests) — une ligne par événement,
 *   sans ANSI ni redessin. C'est la règle que `colorEnabled` applique déjà
 *   aux couleurs, étendue au redessin : une sortie capturée doit rester
 *   lisible et diffable.
 *
 * Regarder ne modifie rien : aucune interaction hors `q`/Ctrl-C pour sortir.
 */
import type { PendingQuestion } from "@orch/mcp-channel";
import { listPendingQuestions } from "@orch/mcp-channel";
import type { OrchEvent } from "@orch/protocol";
import { EventSchema, taskPaths } from "@orch/protocol";
import type { ActivityState, TaskRecord, TaskStatus } from "@orch/core";
import { describeActivity, emptyActivity, fileTaskStore, foldActivity, formatDuration, loadConfig, readableMessage } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, activeGlyphs, colorize, printError, terminalWidth, writeLine } from "../output.js";
import { createLineTail } from "../tail.js";
import type { LineTail } from "../tail.js";

/** Cadence de redessin. Assez court pour paraître vivant, assez long pour ne rien coûter. */
const POLL_MS = 200;

/** Combien de temps une tâche terminée reste affichée, et combien on en garde. */
const RECENT_MS = 5 * 60_000;
const RECENT_MAX = 5;

const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];

function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Assez pour désigner une tâche sans occuper la moitié de la ligne. */
function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10);
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (width <= 1) return "";
  return flat.length <= width ? flat : flat.slice(0, width - 1) + "…";
}

export interface WatchOptions {
  json?: boolean;
  /** Une seule image, puis sortie — pour un script ou un test. */
  once?: boolean;
}

interface Tracked {
  record: TaskRecord;
  state: ActivityState;
  tail: LineTail;
  questions: readonly PendingQuestion[];
  /** Instant où l'on a constaté la fin, pour la faire disparaître au bout d'un moment. */
  endedSeenAt?: number;
  /** Lignes du journal qu'on n'a pas su relire : comptées plutôt que tues. */
  unreadable: number;
}

/**
 * Lit les nouvelles lignes du journal d'une tâche et les replie.
 *
 * Une ligne illisible est comptée, pas signalée à l'écran : un moniteur qui
 * crie à chaque ligne devient inutilisable. Le total, lui, s'affiche en pied
 * d'image — un désalignement entre ce que le moteur écrit et ce que ce CLI
 * sait lire ne doit pas se perdre en silence.
 */
async function pump(tracked: Tracked): Promise<OrchEvent[]> {
  const fresh: OrchEvent[] = [];
  for (const line of await tracked.tail.read()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      tracked.unreadable += 1;
      continue;
    }
    const result = EventSchema.safeParse(parsed);
    if (!result.success) {
      tracked.unreadable += 1;
      continue;
    }
    fresh.push(result.data);
    tracked.state = foldActivity(tracked.state, result.data);
  }
  return fresh;
}

/** Une ligne par événement, pour le rendu hors terminal. */
function describeEventLine(record: TaskRecord, event: OrchEvent): string | undefined {
  const prefix = `${shortId(record.id)} ${record.agent}`;
  switch (event.type) {
    case "started":
      return `${prefix}  démarré`;
    case "tool_use":
      return `${prefix}  ${event.status === "started" ? "▸" : event.status === "succeeded" ? "✓" : "✗"} ${event.tool || "outil"}${event.input_summary ? ` ${event.input_summary}` : ""}`;
    case "file_changed":
      return `${prefix}  ~ ${event.action} ${event.path}`;
    case "message":
      // Même traitement que la vue d'ensemble et qu'`orch run` : les
      // `agent_message` de codex sont des rapports JSON sérialisés.
      return `${prefix}  « ${readableMessage(event.text).replace(/\s+/g, " ").trim()} »`;
    case "thinking":
      return `${prefix}  … ${event.text.replace(/\s+/g, " ").trim()}`;
    case "progress":
      return `${prefix}  · ${event.message}`;
    case "question":
      return `${prefix}  ? ${event.question}`;
    case "answer":
      return `${prefix}  ! ${event.answer}`;
    case "error":
      return `${prefix}  ⚠ ${event.message}`;
    case "finished":
      return `${prefix}  terminé — ${event.status}`;
  }
}

/** L'image complète, en lignes prêtes à écrire. */
function renderFrame(tracked: readonly Tracked[], maxParallel: number, now: number, width: number, io: Io): string[] {
  const active = tracked.filter((t) => isActive(t.record.status));
  const recent = tracked.filter((t) => !isActive(t.record.status)).slice(-RECENT_MAX);
  const lines: string[] = [];

  const g = activeGlyphs().status;
  const heure = new Date(now).toTimeString().slice(0, 8);
  const titre = `${g.mark} orch ${g.bullet} watch`;
  const compte = `${active.length} active${active.length > 1 ? "s" : ""} ${g.bullet} max_parallel ${maxParallel}`;
  const gauche = `${titre}   ${compte}`;
  lines.push(
    colorize(titre, "title", io.stdout) +
      "   " +
      colorize(compte, "dim", io.stdout) +
      " ".repeat(Math.max(1, width - gauche.length - heure.length)) +
      colorize(heure, "faint", io.stdout),
  );
  lines.push("");

  if (active.length === 0) {
    lines.push(colorize("Aucune tâche en cours. La fenêtre reste ouverte.", "dim", io.stdout));
    lines.push("");
  }

  for (const t of active) {
    const { headline, silentMs, stalled } = describeActivity(t.state, now);
    const age = t.record.started_at ? formatDuration(now - Date.parse(t.record.started_at)) : "—";
    const puce = stalled ? colorize(g.stalled, "warn", io.stdout) : colorize(g.running, "accent", io.stdout);

    const entete = `${shortId(t.record.id)}  ${t.record.agent.padEnd(12)} ${(t.record.role ?? "—").padEnd(12)} ${age.padStart(6)}  ${t.record.isolation} ${g.bullet} ${t.record.mode}`;
    lines.push(`${puce} ${clip(entete, width - 2)}`);
    lines.push(`  ${colorize(clip(t.record.objective, width - 2), "dim", io.stdout)}`);

    // Une question en attente prime sur tout : un sous-agent qui attend une
    // réponse ressemble exactement à un sous-agent bloqué, et n'est pas du
    // tout la même chose.
    if (t.questions.length > 0) {
      const q = t.questions[0];
      const reste = t.questions.length > 1 ? ` (+${t.questions.length - 1})` : "";
      lines.push(`  ${colorize(clip(`${g.question} ${q?.question ?? ""}${reste}`, width - 2), "warn", io.stdout)}`);
      // Aucune commande CLI ne répond aujourd'hui : `orch_answer` est un outil
      // MCP, donc le geste appartient à l'agent principal. Le dire plutôt que
      // de suggérer un `orch answer` qui n'existe pas.
      lines.push(`  ${colorize(`en attente d'une réponse — l'agent principal répond par orch_answer (id ${q?.id ?? ""})`, "dim", io.stdout)}`);
    } else {
      lines.push(`  ${clip(headline, width - 2)}`);
    }

    const compteurs: string[] = [];
    if (t.state.filesTouched.length > 0) compteurs.push(`${g.file} ${t.state.filesTouched.length} fichier(s)`);
    compteurs.push(`${t.state.eventCount} événement(s)`);
    if (t.unreadable > 0) compteurs.push(`${t.unreadable} ligne(s) illisible(s)`);
    if (stalled) compteurs.push(colorize(`silence ${formatDuration(silentMs)}`, "warn", io.stdout));
    lines.push(`  ${colorize(compteurs.join(`  ${g.bullet}  `), "dim", io.stdout)}`);
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push(colorize("Terminées récemment", "dim", io.stdout));
    for (const t of recent) {
      const fin = t.record.ended_at ? `il y a ${formatDuration(now - Date.parse(t.record.ended_at))}` : "";
      const ok = t.record.status === "succeeded" && t.record.report_status === "success";
      const marque = colorize(ok ? g.done : g.failed, ok ? "ok" : "bad", io.stdout);
      lines.push(
        `  ${marque} ${clip(`${shortId(t.record.id)}  ${t.record.agent}  ${t.record.status} / rapport ${t.record.report_status ?? "—"}   ${fin}`, width - 4)}`,
      );
    }
    lines.push("");
  }

  lines.push(colorize("q ou Ctrl-C pour quitter — regarder ne modifie rien.", "dim", io.stdout));
  return lines;
}

/** Vrai quand la sortie est un vrai terminal : seul cas où redessiner a un sens. */
function isTty(io: Io): boolean {
  return Boolean((io.stdout as { isTTY?: boolean }).isTTY);
}

export async function runWatch(root: string, ids: readonly string[], options: WatchOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);
  const store = fileTaskStore(root);
  const wanted = new Set(ids);

  if (wanted.size > 0) {
    const inconnus: string[] = [];
    for (const id of wanted) if ((await store.get(id)) === null) inconnus.push(id);
    if (inconnus.length > 0) {
      printError(io, `Tâche(s) inconnue(s) : ${inconnus.join(", ")}.`);
      return EXIT_USAGE;
    }
  }

  const tracked = new Map<string, Tracked>();
  const redraw = isTty(io) && !options.json && !options.once;

  /** Met à jour la liste des tâches suivies, replie les nouveaux événements, et rend ceux-ci. */
  async function step(now: number): Promise<{ tracked: Tracked[]; fresh: { record: TaskRecord; event: OrchEvent }[] }> {
    for (const record of await store.list()) {
      if (wanted.size > 0 && !wanted.has(record.id)) continue;
      const known = tracked.get(record.id);
      if (known) {
        known.record = record;
        if (!isActive(record.status) && known.endedSeenAt === undefined) known.endedSeenAt = now;
        continue;
      }
      // Une tâche déjà terminée avant qu'on regarde n'est reprise que si sa
      // fin est récente : sans cette borne, ouvrir la fenêtre déroulerait
      // l'historique entier du projet.
      const ended = record.ended_at ? Date.parse(record.ended_at) : undefined;
      if (!isActive(record.status) && (ended === undefined || now - ended > RECENT_MS)) continue;
      tracked.set(record.id, {
        record,
        state: emptyActivity(),
        tail: createLineTail(taskPaths(record.task_dir).eventsPath),
        questions: [],
        ...(isActive(record.status) ? {} : { endedSeenAt: now }),
        unreadable: 0,
      });
    }

    // Une tâche terminée depuis assez longtemps cesse d'occuper l'écran.
    for (const [id, t] of tracked) {
      if (t.endedSeenAt !== undefined && now - t.endedSeenAt > RECENT_MS) tracked.delete(id);
    }

    const fresh: { record: TaskRecord; event: OrchEvent }[] = [];
    for (const t of tracked.values()) {
      for (const event of await pump(t)) fresh.push({ record: t.record, event });
      t.questions = isActive(t.record.status) ? await listPendingQuestions(taskPaths(t.record.task_dir).dir) : [];
    }

    const ordered = [...tracked.values()].sort((a, b) => a.record.created_at.localeCompare(b.record.created_at));
    return { tracked: ordered, fresh };
  }

  const restore = redraw ? enterAltScreen(io) : undefined;
  const stop = new AbortController();
  const onSigint = (): void => stop.abort();
  process.on("SIGINT", onSigint);
  const releaseKeys = redraw ? listenForQuit(() => stop.abort()) : undefined;

  try {
    for (;;) {
      const now = Date.now();
      const { tracked: ordered, fresh } = await step(now);

      if (options.json) {
        // NDJSON : un objet par ligne, pas l'indentation de `printJson` —
        // c'est un flux destiné à être consommé au fil de l'eau, pas relu.
        for (const { event } of fresh) writeLine(io.stdout, JSON.stringify(event));
      } else if (redraw) {
        io.stdout.write("\x1b[H\x1b[2J" + renderFrame(ordered, config.policy.max_parallel, now, terminalWidth(io.stdout), io).join("\n") + "\n");
      } else if (options.once) {
        for (const line of renderFrame(ordered, config.policy.max_parallel, now, terminalWidth(io.stdout), io)) writeLine(io.stdout, line);
      } else {
        for (const { record, event } of fresh) {
          const line = describeEventLine(record, event);
          if (line) writeLine(io.stdout, line);
        }
      }

      if (options.once || stop.signal.aborted) return EXIT_OK;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (stop.signal.aborted) return EXIT_OK;
    }
  } finally {
    process.off("SIGINT", onSigint);
    releaseKeys?.();
    restore?.();
  }
}

/**
 * Passe en écran alterné et cache le curseur ; rend de quoi tout remettre en
 * place.
 *
 * La restauration est aussi posée sur `exit` : un moniteur qui laisse le
 * terminal en écran alterné ou sans curseur après un arrêt brutal est pire
 * que pas de moniteur, et un `finally` ne couvre pas tous les chemins de
 * sortie du processus.
 */
function enterAltScreen(io: Io): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    io.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  io.stdout.write("\x1b[?1049h\x1b[?25l");
  process.once("exit", restore);
  return restore;
}

/**
 * Écoute « q » sur l'entrée standard, quand elle est un terminal.
 *
 * Le mode brut est restauré dans tous les cas — c'est le réglage qui, laissé
 * en place, rend le shell inutilisable après coup.
 */
function listenForQuit(onQuit: () => void): () => void {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return () => {};

  const onData = (chunk: Buffer): void => {
    const key = chunk.toString("utf8");
    // Ctrl-C compris : en mode brut, il n'est plus transformé en SIGINT.
    if (key === "q" || key === "\u0003") onQuit();
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    stdin.setRawMode?.(false);
    stdin.pause();
  };
}
