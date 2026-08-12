/**
 * `orch run` : résout la racine → charge la config → résout la délégation
 * (rôle/agent/mode/isolation/politique/timeout/contexte, via
 * `resolveDelegation` d'`@orch/core`) → `runTask`. Voir le brief pour
 * l'enchaînement d'origine.
 *
 * La résolution rôle → agent → politique elle-même n'est plus dupliquée ici :
 * `resolveDelegation` est le point d'assemblage partagé avec `orch_delegate`
 * (serveur MCP), voir son en-tête (`packages/core/src/delegation.ts`) et le
 * rapport de correction de la tâche 7. Ce qui reste propre à ce fichier :
 * valider la *forme* de `--mode`/`--isolation` (chaînes brutes issues de
 * commander) et résoudre `--context @fichier` — deux affinages purement
 * CLI, qui n'ont pas leur place dans une fonction partagée avec le serveur
 * MCP (dont les entrées sont déjà typées par son schéma zod).
 *
 * `Ctrl-C` interrompt proprement : un `AbortController` créé ici est transmis
 * à `runTask` (`RunTaskInput.signal`, relayé jusqu'à `runAgentProcess`, qui
 * sait déjà l'honorer — SIGTERM puis, à défaut de réponse, SIGKILL). Le
 * sous-processus est donc explicitement signalé, sans dépendre du
 * regroupement de processus POSIX. L'avancement, en mode humain, est affiché
 * au fil de l'eau via `RunTaskInput.onEvent` plutôt que relu après coup.
 * `taskId` est généré ici (plutôt que par le moteur) pour que le répertoire
 * de la tâche soit connu dès l'appel — pas strictement nécessaire à
 * l'affichage en direct (qui passe par `onEvent`), mais c'est le même
 * contrat que celui dont le serveur MCP a besoin (`orch_delegate`
 * asynchrone, rendant un identifiant immédiatement).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Isolation, OrchEvent, TaskMode } from "@orch/protocol";
import type { NetworkRequest, TaskOutcome } from "@orch/core";
import { createSlotQueue, fileTaskStore, generateTaskId, loadConfig, nextDelegationDepth, readableMessage, resolveDelegation, runTask } from "@orch/core";
import { ISOLATIONS, NETWORK_REQUEST_VALUES, TASK_MODES } from "../flags.js";
import type { Glyphs } from "@orch/theme";
import type { Io, ThemeToken } from "../output.js";
import {
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  activeGlyphs,
  colorize,
  printError,
  printJson,
  printWarning,
  sectionHeader,
  writeLine,
} from "../output.js";

export interface RunOptions {
  role?: string;
  agent?: string;
  mode?: string;
  isolation?: string;
  network?: string;
  timeout?: string;
  model?: string;
  context?: string;
  json?: boolean;
  channel?: boolean;
  /**
   * Arguments bruts transmis tels quels au CLI de l'agent, saisis après
   * « -- ». Échappatoire assumée pour ce qu'orch n'expose pas encore : le
   * moteur les portait déjà de bout en bout, aucune façade ne les ouvrait.
   *
   * Volontairement absent du tool MCP `orch_delegate` : c'est un geste que
   * l'utilisateur tape, pas une latitude qu'on laisse à l'orchestrateur, qui
   * pourrait sinon élever seul les privilèges d'un sous-agent.
   */
  extraArgs?: string[];
}

async function resolveContext(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw.startsWith("@")) {
    const path = resolve(process.cwd(), raw.slice(1));
    return await readFile(path, "utf8");
  }
  return raw;
}

/** Une ligne d'avancement, décomposée pour que seule la marque porte la couleur. */
export interface EventLine {
  /** La marque, tirée du jeu de glyphes courant. */
  glyph: string;
  /** Ce dont il s'agit, en un mot — aligné en colonne d'une ligne à l'autre. */
  label: string;
  /** Le rôle du thème pour la marque et le libellé. */
  token: ThemeToken;
  text: string;
  /** Le rôle du thème pour le texte lui-même. Absent : le texte reste neutre. */
  textToken?: ThemeToken;
}

/** Largeur de la colonne des libellés, pour que les textes s'alignent. */
const LABEL_WIDTH = 10;

/**
 * L'avancement, une ligne par événement.
 *
 * `message` et `thinking` étaient absents : ce que le sous-agent *dit* était
 * écrit dans `events.jsonl` depuis toujours et affiché nulle part. Sur une
 * tâche qui réfléchit longtemps entre deux outils, c'était la seule chose à
 * voir, et on ne la voyait pas.
 *
 * Chaque ligne est mise à plat : antigravity émet un `message` par bribe de
 * texte, retours à la ligne compris, et une bribe par ligne d'affichage
 * déroulerait l'écran sans rien apprendre.
 *
 * Le libellé remplace les crochets d'origine (`[outil]`, `[agent]`) : à
 * largeur fixe, les textes s'alignent d'une ligne à l'autre, et la colonne
 * ainsi formée se parcourt d'un coup d'œil là où des crochets de longueur
 * variable obligeaient à lire chaque début de ligne.
 *
 * Exportée pour être éprouvée directement : l'agent factice des tests n'émet
 * pas de lignes au format d'un CLI réel, aucun test de bout en bout ne
 * passerait donc par ces branches.
 */
export function describeEvent(event: OrchEvent, glyphs: Glyphs = activeGlyphs()): EventLine | undefined {
  const g = glyphs.status;
  switch (event.type) {
    case "started":
      return { glyph: g.running, label: "départ", token: "accent", text: `agent "${event.agent}"` };
    case "tool_use":
      // Le nom est vide quand l'agent ne le porte pas sur la fermeture (le
      // `tool_result` de claude n'a que l'identifiant d'appel).
      return {
        glyph: g.tool,
        label: "outil",
        token: "accent",
        text: `${event.tool || "(fin)"}${event.input_summary ? ` — ${event.input_summary}` : ""} (${event.status})`,
      };
    case "file_changed":
      return { glyph: g.file, label: "fichier", token: "warn", text: `${event.action} ${event.path}` };
    case "progress":
      return { glyph: g.bullet, label: "avancement", token: "dim", text: event.message, textToken: "dim" };
    case "message":
      // `readableMessage` plutôt que le texte brut : les `agent_message` de
      // codex sont des rapports JSON sérialisés, illisibles tels quels.
      return { glyph: g.speech, label: "agent", token: "dim", text: flatten(readableMessage(event.text)) };
    case "thinking":
      return { glyph: g.bullet, label: "réflexion", token: "dim", text: flatten(event.text), textToken: "dim" };
    case "error":
      return { glyph: g.warn, label: "erreur", token: "bad", text: event.message, textToken: "bad" };
    default:
      return undefined;
  }
}

/**
 * Assemble une ligne d'avancement.
 *
 * La marque et le libellé portent la couleur ; **le texte de l'agent reste
 * neutre**. C'est ce que dit la palette : le texte principal hérite de
 * l'avant-plan du terminal, seul ce qui le classe est coloré. Teinter la
 * parole de l'agent la rendrait moins lisible qu'elle ne l'est, sans rien
 * apprendre — elle est déjà nommée par son libellé.
 */
export function formatEventLine(line: EventLine, io: Io): string {
  const marque = colorize(`${line.glyph} ${line.label.padEnd(LABEL_WIDTH)}`, line.token, io.stdout);
  const texte = line.textToken ? colorize(line.text, line.textToken, io.stdout) : line.text;
  return `  ${marque} ${texte}`;
}

/** Une seule ligne, sans blancs superflus. Vide si le texte n'en portait aucun. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function runRun(root: string, objective: string, options: RunOptions, io: Io): Promise<number> {
  const { config } = await loadConfig(root);

  // Précédence délibérée, fixée par un test (voir run.test.ts) : toute
  // validation de *forme*, propre au CLI (chaînes brutes issues de
  // commander, aucune E/S ni lecture de configuration nécessaire) sort
  // avant même de tenter de résoudre rôle/agent via `resolveDelegation`. Un
  // `--mode bogus` est une erreur d'usage immédiate ; elle ne doit pas
  // attendre la résolution d'un `--role` par ailleurs invalide pour être
  // signalée. C'était différent avant l'extraction de `resolveDelegation`
  // (tâche 7) — le repli sur ces mêmes vérifications, alors postérieures à
  // la résolution du rôle/agent, est resté sans effet observable jusqu'à ce
  // que la revue le relève.
  if (options.mode && !TASK_MODES.includes(options.mode as TaskMode)) {
    printError(io, `--mode invalide (attendu l'une de : ${TASK_MODES.join(", ")}).`);
    return EXIT_USAGE;
  }
  if (options.isolation && !ISOLATIONS.includes(options.isolation as Isolation | "auto")) {
    printError(io, `--isolation invalide (attendu l'une de : ${ISOLATIONS.join(", ")}).`);
    return EXIT_USAGE;
  }
  if (options.network && !NETWORK_REQUEST_VALUES.includes(options.network as NetworkRequest)) {
    printError(io, `--network invalide (attendu l'une de : ${NETWORK_REQUEST_VALUES.join(", ")}).`);
    return EXIT_USAGE;
  }
  // Même logique : la présence d'un agent ou d'un rôle est une condition de
  // forme, vérifiable sans résoudre quoi que ce soit. `resolveDelegation`
  // porte sa propre garde pour ses autres appelants (le serveur MCP,
  // notamment, dont les paramètres se nomment "agent"/"role") avec un motif
  // générique ; ici, on la précède pour rendre le message historique du CLI,
  // qui nomme les flags exacts à taper — perdu sans bruit lors de
  // l'extraction, restauré par la revue.
  if (!options.agent && !options.role) {
    printError(io, "Précisez --agent <id> ou --role <name>.");
    return EXIT_USAGE;
  }

  let context: string | undefined;
  try {
    context = await resolveContext(options.context);
  } catch (error) {
    printError(io, `Impossible de lire --context : ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  // Profondeur héritée de `$ORCH_DEPTH` (+1) : voir C4 de la revue finale.
  // `orch run` peut lui-même tourner comme sous-agent d'une délégation
  // précédente — c'est le seul moyen pour `max_depth`/le garde-fou anti-
  // récursion de s'appliquer au-delà du premier niveau.
  const depth = nextDelegationDepth();

  const resolved = await resolveDelegation(config, root, {
    role: options.role,
    agent: options.agent,
    mode: options.mode as TaskMode | undefined,
    isolation: options.isolation as Isolation | "auto" | undefined,
    network: options.network as NetworkRequest | undefined,
    context,
    timeout: options.timeout,
    depth,
  });
  if ("error" in resolved) {
    printError(io, resolved.error);
    return EXIT_USAGE;
  }
  const { agentId, mode, isolation, allowInplaceWrite, network, networkWarning, timeoutMs, context: resolvedContext } = resolved;

  // Après la branche d'erreur, et seulement en mode humain : `--json` ne doit
  // porter que le résultat final sur stdout.
  if (!options.json) sectionHeader(io, "run");

  const store = fileTaskStore(root);
  const taskId = generateTaskId();
  // Le contrôleur précède la file : l'attente d'un créneau se produit *avant*
  // que `runTask` ne soit appelé, et Ctrl-C doit pouvoir l'interrompre aussi —
  // pas seulement la tâche une fois lancée.
  const controller = new AbortController();

  // Créneaux sur disque plutôt que sémaphore en mémoire : chaque `orch run`
  // est un processus distinct, et une file par processus laissait six
  // terminaux lancer six agents quel que soit `max_parallel`. Les créneaux
  // sont partagés par tout ce qui délègue sous cette racine, session MCP
  // comprise.
  const queue = createSlotQueue({
    root,
    limit: config.policy.max_parallel,
    label: `orch run — ${objective.slice(0, 60)}`,
    signal: controller.signal,
    onWait: (holders) => {
      // Une attente muette se lit comme un blocage. Nommer qui occupe la
      // place, et combien il y en a, la rend compréhensible — et montre du
      // même geste quel réglage la gouverne.
      printWarning(
        io,
        `${holders.length} tâche(s) déjà en cours sous ce projet (max_parallel = ${config.policy.max_parallel}) — en attente d'un créneau. Ctrl-C pour renoncer.`,
      );
      for (const holder of holders) {
        printWarning(io, `  · pid ${holder.pid}${holder.label ? ` — ${holder.label}` : ""} (depuis ${holder.startedAt})`);
      }
    },
  });

  const onSigint = (): void => {
    printError(io, `Interruption demandée : arrêt de la tâche "${taskId}" (SIGTERM au sous-processus, SIGKILL s'il ne répond pas)…`);
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  // En --json, la consigne du brief ("n'écrire que le résultat final sur
  // stdout") exclut tout affichage en direct : `onEvent` reste alors
  // silencieux, les événements ne sont utiles qu'au fil de l'eau en mode
  // humain.
  const glyphs = activeGlyphs();
  const onEvent = options.json
    ? undefined
    : (event: OrchEvent): void => {
        const line = describeEvent(event, glyphs);
        if (line) writeLine(io.stdout, formatEventLine(line, io));
      };

  let outcome;
  try {
    outcome = await runTask(
      { store, root, queue },
      {
        agentId,
        objective,
        ...(resolvedContext !== undefined ? { context: resolvedContext } : {}),
        mode,
        isolation,
        allowInplaceWrite,
        network,
        ...(networkWarning !== undefined ? { networkWarning } : {}),
        workspace: root,
        ...(options.role ? { role: options.role } : {}),
        ...(options.model ? { model: options.model } : {}),
        timeoutMs,
        depth,
        extraAgents: config.agents,
        worktreeSetup: config.worktree,
        ...(options.extraArgs && options.extraArgs.length > 0 ? { extraArgs: options.extraArgs } : {}),
        taskId,
        signal: controller.signal,
        ...(onEvent ? { onEvent } : {}),
        ...(options.channel ? { channel: true } : {}),
      },
    );
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_RUNTIME;
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (options.json) {
    printJson(io, {
      task_id: outcome.record.id,
      status: outcome.record.status,
      report: outcome.report,
      report_source: outcome.source,
      changes_verified_by: outcome.record.changes_verified_by,
      diff: outcome.diff ? { files: outcome.diff.files, is_empty: outcome.diff.isEmpty } : undefined,
    });
    return exitCodeFor(outcome);
  }

  const g = glyphs.status;
  const réussi = outcome.record.status === "succeeded" && outcome.report.status === "success";
  writeLine(io.stdout);
  writeLine(
    io.stdout,
    `${colorize(réussi ? g.done : g.failed, réussi ? "ok" : "bad", io.stdout)} ` +
      `Tâche ${outcome.record.id} — statut : ${colorize(outcome.record.status, réussi ? "ok" : "bad", io.stdout)} ` +
      colorize(`(rapport "${outcome.report.status}" via "${outcome.source}")`, "dim", io.stdout),
  );
  writeLine(io.stdout, `  ${outcome.report.summary}`);

  if (outcome.diff && !outcome.diff.isEmpty) {
    writeLine(io.stdout);
    writeLine(io.stdout, colorize("Fichiers modifiés (d'après git)", "dim", io.stdout));
    for (const change of outcome.diff.files) {
      writeLine(io.stdout, `  ${colorize(g.file, "warn", io.stdout)} ${change.action} ${change.path}`);
    }
  }
  if (outcome.report.findings.length > 0) {
    writeLine(io.stdout);
    writeLine(io.stdout, colorize("Constats", "dim", io.stdout));
    for (const finding of outcome.report.findings) {
      const grave = finding.severity === "high" || finding.severity === "critical";
      writeLine(
        io.stdout,
        `  ${colorize(g.warn, grave ? "bad" : "warn", io.stdout)} ` +
          `${colorize(`[${finding.severity}]`, grave ? "bad" : "warn", io.stdout)} ` +
          `${finding.title}${finding.file ? colorize(` (${finding.file})`, "dim", io.stdout) : ""}`,
      );
    }
  }
  if (outcome.record.isolation === "worktree") {
    writeLine(io.stdout);
    writeLine(
      io.stdout,
      colorize(
        `Isolée dans un worktree : "orch diff ${outcome.record.id}" pour voir le diff, "orch apply ${outcome.record.id}" pour l'intégrer.`,
        "dim",
        io.stdout,
      ),
    );
  }

  return exitCodeFor(outcome);
}

/**
 * Croise le statut du processus (`record.status`) et celui déclaré par
 * l'agent dans son rapport (`report.status`) — voir I3 de la revue finale :
 * `record.status === "succeeded"` seul ne dit que "le processus est sorti
 * en code 0", pas "l'agent a réussi sa mission". Un agent qui écrit
 * `{"status":"failed"}` puis sort en code 0 rendait jusqu'ici un exit code
 * 0 à une automatisation qui enchaîne sur `orch run` — conclusion de succès
 * sur une tâche que l'agent lui-même déclare `failed`/`partial`/`blocked`.
 */
function exitCodeFor(outcome: TaskOutcome): number {
  return outcome.record.status === "succeeded" && outcome.report.status === "success" ? EXIT_OK : EXIT_RUNTIME;
}
