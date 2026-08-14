/**
 * Ce qu'une tâche est en train de faire, replié depuis son journal
 * d'événements.
 *
 * Fonction pure, dans l'esprit de `policy.ts` et `network.ts` : aucune E/S,
 * et chaque sortie porte une phrase lisible plutôt qu'un état brut à
 * interpréter par l'appelant.
 *
 * **Un pli, pas une relecture.** L'appelant garde un `ActivityState` par
 * tâche et y pousse les événements au fur et à mesure qu'ils arrivent :
 * `caesar watch` relit `events.jsonl` par décalage et n'analyse que les
 * lignes neuves. Relire tout le journal à chaque image coûterait, pour une
 * tâche bavarde suivie pendant dix minutes, de reparser des milliers de
 * lignes cinq fois par seconde.
 */
import type { CaesarEvent, ReportStatus } from "@caesar/protocol";

/** Au-delà, un silence mérite d'être signalé plutôt que simplement compté. */
export const STALL_MS = 30_000;

/**
 * Longueur maximale de la parole conservée. Les fragments s'accumulent —
 * antigravity émet un `message` par bribe — et seule la fin intéresse.
 */
const SPEECH_MAX = 400;

/**
 * Plafond du nombre d'outils tenus pour ouverts. Un adaptateur qui
 * annoncerait des départs sans jamais les fermer ferait sinon croître cette
 * liste indéfiniment ; le plus ancien cède la place.
 */
const RUNNING_TOOLS_MAX = 8;

export interface RunningTool {
  /** Identifiant d'appel donné par l'agent, vide s'il n'en fournit pas. */
  id: string;
  tool: string;
  summary: string;
  /** Horodatage ISO de l'ouverture. */
  since: string;
}

export interface ActivityState {
  eventCount: number;
  /** Horodatage ISO du dernier événement, quel qu'en soit le type. */
  lastAt?: string;
  /** Départ d'exécution effectif, tel que le journal le date. */
  startedAt?: string;
  runningTools: readonly RunningTool[];
  /** Chemins touchés, dans l'ordre d'apparition, sans doublon. */
  filesTouched: readonly string[];
  /** Le dernier outil refermé, pour dire ce qui vient de se terminer. */
  lastTool?: { tool: string; summary: string; ok: boolean };
  /** La parole de l'agent, fragments consécutifs recollés. */
  speech: string;
  /**
   * Le dernier événement replié était-il un `message` ? Sert au seul
   * recollage de `speech` : deux fragments qui se suivent forment une phrase,
   * deux fragments séparés par un outil sont deux phrases.
   */
  lastEventWasMessage?: boolean;
  lastProgress?: string;
  lastError?: string;
  /** Renseigné dès que l'agent annonce sa fin, avec le statut qu'il déclare. */
  finished?: ReportStatus;
}

export function emptyActivity(): ActivityState {
  return { eventCount: 0, runningTools: [], filesTouched: [], speech: "" };
}

/**
 * Le texte qu'un humain veut lire d'un `message`.
 *
 * codex n'envoie pas de prose : chacun de ses `agent_message` est un rapport
 * `caesar.report/v1` sérialisé. Affiché tel quel, c'est un mur de JSON là où
 * l'on attend une phrase. Quand le message est un objet JSON portant un
 * `summary`, c'est celui-ci qui parle.
 *
 * Exportée parce que `caesar run` affiche les mêmes messages au fil de l'eau et
 * souffrait exactement du même mur de JSON : un seul traitement, pas deux qui
 * dériveraient.
 */
export function readableMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const summary = (parsed as Record<string, unknown>)["summary"];
      if (typeof summary === "string" && summary !== "") return summary;
    }
  } catch {
    // Pas du JSON malgré l'accolade : c'est de la prose, on la garde telle quelle.
  }
  return text;
}

/** Garde la fin de `text`, seule partie encore fraîche, sous `SPEECH_MAX`. */
function clampSpeech(text: string): string {
  return text.length <= SPEECH_MAX ? text : `…${text.slice(-SPEECH_MAX)}`;
}

/**
 * Retire de `running` l'appel que ferme cet événement.
 *
 * Trois recoupements, du plus sûr au plus approximatif. L'identifiant
 * d'abord : c'est le seul qui distingue deux exécutions successives de la
 * même commande, et le seul disponible pour claude, dont la fermeture ne
 * porte pas le nom de l'outil (voir `CaesarEvent.id`). À défaut, le couple
 * (nom, résumé). À défaut encore, le plus ancien appel du même outil.
 */
function closeTool(running: readonly RunningTool[], id: string, tool: string, summary: string): RunningTool[] {
  const byId = id !== "" ? running.findIndex((t) => t.id === id) : -1;
  const byPair = byId >= 0 ? byId : running.findIndex((t) => t.tool === tool && t.summary === summary);
  const index = byPair >= 0 ? byPair : running.findIndex((t) => t.tool === tool);
  if (index < 0) return [...running];
  return [...running.slice(0, index), ...running.slice(index + 1)];
}

/**
 * Replie un événement dans l'état courant. Ne modifie jamais `state` : rend
 * toujours un nouvel état, pour qu'un appelant puisse le comparer au
 * précédent (React, mémoïsation d'affichage) sans surprise.
 */
export function foldActivity(state: ActivityState, event: CaesarEvent): ActivityState {
  const next: ActivityState = { ...state, eventCount: state.eventCount + 1, lastAt: event.at };

  switch (event.type) {
    case "started":
      next.startedAt = event.at;
      break;

    case "message": {
      const text = readableMessage(event.text);
      // Les `message` consécutifs se recollent — antigravity en émet un par
      // bribe de texte, et une ligne par fragment ne se lit pas. Tout autre
      // type d'événement referme le paragraphe : la parole qui suit un outil
      // est une nouvelle phrase, pas la suite de la précédente.
      const glue = state.lastEventWasMessage === true ? state.speech : "";
      next.speech = clampSpeech(glue + text);
      break;
    }

    case "thinking":
      next.speech = clampSpeech(event.text);
      break;

    case "tool_use":
      if (event.status === "started") {
        const opened: RunningTool = { id: event.id, tool: event.tool, summary: event.input_summary, since: event.at };
        const running = [...state.runningTools, opened];
        next.runningTools = running.length > RUNNING_TOOLS_MAX ? running.slice(-RUNNING_TOOLS_MAX) : running;
      } else {
        const closing = state.runningTools.find(
          (t) => (event.id !== "" && t.id === event.id) || (t.tool === event.tool && t.summary === event.input_summary),
        );
        next.runningTools = closeTool(state.runningTools, event.id, event.tool, event.input_summary);
        // Le nom vient de l'ouverture quand la fermeture ne le porte pas —
        // le cas de claude, dont le `tool_result` n'a que l'identifiant.
        next.lastTool = {
          tool: event.tool !== "" ? event.tool : (closing?.tool ?? "outil"),
          summary: event.input_summary !== "" ? event.input_summary : (closing?.summary ?? ""),
          ok: event.status === "succeeded",
        };
      }
      break;

    case "file_changed":
      if (!state.filesTouched.includes(event.path)) next.filesTouched = [...state.filesTouched, event.path];
      break;

    case "progress":
      next.lastProgress = event.message;
      break;

    case "error":
      next.lastError = event.message;
      break;

    case "finished":
      next.finished = event.status;
      next.runningTools = [];
      break;

    case "question":
    case "answer":
      break;
  }

  next.lastEventWasMessage = event.type === "message";
  return next;
}

/** Ce qu'il faut afficher d'une tâche, à cet instant. */
export interface ActivityDescription {
  /** Une ligne : ce que la tâche fait maintenant. */
  headline: string;
  /** Depuis combien de temps plus rien n'est arrivé. */
  silentMs: number;
  /** Vrai quand ce silence est assez long pour mériter d'être signalé. */
  stalled: boolean;
}

/** « 2m14s », « 47s » — durée courte, sans unité superflue. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * La phrase qui décrit l'instant présent.
 *
 * L'ordre de préséance est celui de l'information : un outil encore ouvert
 * dit davantage que la dernière parole de l'agent (« ▸ shell npm test, 12s »
 * situe la tâche, une phrase générale non), et une erreur récente prime sur
 * tout dès lors que plus rien ne tourne. Quand il n'y a rien à dire, on le
 * dit — le silence et sa durée sont eux-mêmes une information, la seule qui
 * distingue une tâche bloquée d'une tâche qui travaille.
 */
export function describeActivity(state: ActivityState, now: number): ActivityDescription {
  const silentMs = state.lastAt === undefined ? 0 : Math.max(0, now - Date.parse(state.lastAt));
  const stalled = state.lastAt !== undefined && silentMs > STALL_MS;

  const headline = ((): string => {
    if (state.finished !== undefined) return `terminé — rapport « ${state.finished} »`;

    const [tool] = state.runningTools;
    if (tool) {
      const age = formatDuration(now - Date.parse(tool.since));
      const others = state.runningTools.length > 1 ? ` (+${state.runningTools.length - 1})` : "";
      return `▸ ${tool.tool}${tool.summary ? ` ${tool.summary}` : ""} — ${age}${others}`;
    }

    if (state.lastError !== undefined) return `⚠ ${state.lastError}`;
    if (state.speech !== "") return `« ${state.speech} »`;
    if (state.lastTool) return `${state.lastTool.ok ? "✓" : "✗"} ${state.lastTool.tool} ${state.lastTool.summary}`.trimEnd();
    if (state.lastProgress !== undefined) return state.lastProgress;
    if (state.eventCount === 0) return "aucun événement pour l'instant";
    return "sans nouvelle";
  })();

  return { headline, silentMs, stalled };
}
