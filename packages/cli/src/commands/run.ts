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
import { createQueue, fileTaskStore, generateTaskId, loadConfig, nextDelegationDepth, resolveDelegation, runTask } from "@orch/core";
import { ISOLATIONS, TASK_MODES } from "../flags.js";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, printJson, writeLine } from "../output.js";

export interface RunOptions {
  role?: string;
  agent?: string;
  mode?: string;
  isolation?: string;
  timeout?: string;
  model?: string;
  context?: string;
  json?: boolean;
  channel?: boolean;
}

async function resolveContext(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw.startsWith("@")) {
    const path = resolve(process.cwd(), raw.slice(1));
    return await readFile(path, "utf8");
  }
  return raw;
}

function describeEvent(event: OrchEvent): string | undefined {
  switch (event.type) {
    case "started":
      return `  [démarrage] agent "${event.agent}"`;
    case "tool_use":
      return `  [outil] ${event.tool}${event.input_summary ? ` — ${event.input_summary}` : ""} (${event.status})`;
    case "file_changed":
      return `  [fichier] ${event.action} ${event.path}`;
    case "progress":
      return `  [progression] ${event.message}`;
    case "error":
      return `  [erreur] ${event.message}`;
    default:
      return undefined;
  }
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
    context,
    timeout: options.timeout,
    depth,
  });
  if ("error" in resolved) {
    printError(io, resolved.error);
    return EXIT_USAGE;
  }
  const { agentId, mode, isolation, timeoutMs, context: resolvedContext } = resolved;

  const store = fileTaskStore(root);
  // Une `Queue` par appel : `orch run` ne lance qu'une seule tâche à la fois,
  // mais la câbler explicitement (plutôt que de laisser `RunnerDeps.queue` à
  // `undefined`) tient la promesse de `policy.max_parallel` — voir C4 de la
  // revue finale, et le durcissement de typage qui rend ce champ obligatoire.
  const queue = createQueue(config.policy.max_parallel);
  const taskId = generateTaskId();
  const controller = new AbortController();

  const onSigint = (): void => {
    printError(io, `Interruption demandée : arrêt de la tâche "${taskId}" (SIGTERM au sous-processus, SIGKILL s'il ne répond pas)…`);
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  // En --json, la consigne du brief ("n'écrire que le résultat final sur
  // stdout") exclut tout affichage en direct : `onEvent` reste alors
  // silencieux, les événements ne sont utiles qu'au fil de l'eau en mode
  // humain.
  const onEvent = options.json
    ? undefined
    : (event: OrchEvent): void => {
        const line = describeEvent(event);
        if (line) writeLine(io.stdout, line);
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
        workspace: root,
        ...(options.role ? { role: options.role } : {}),
        ...(options.model ? { model: options.model } : {}),
        timeoutMs,
        depth,
        extraAgents: config.agents,
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
    return outcome.record.status === "succeeded" ? EXIT_OK : EXIT_RUNTIME;
  }

  writeLine(io.stdout);
  writeLine(io.stdout, `Tâche ${outcome.record.id} — statut : ${outcome.record.status} (rapport via "${outcome.source}")`);
  writeLine(io.stdout, outcome.report.summary);

  if (outcome.diff && !outcome.diff.isEmpty) {
    writeLine(io.stdout, "Fichiers modifiés (d'après git) :");
    for (const change of outcome.diff.files) writeLine(io.stdout, `  - ${change.action} ${change.path}`);
  }
  if (outcome.report.findings.length > 0) {
    writeLine(io.stdout, "Constats :");
    for (const finding of outcome.report.findings) {
      writeLine(io.stdout, `  - [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file})` : ""}`);
    }
  }
  if (outcome.record.isolation === "worktree") {
    writeLine(
      io.stdout,
      `Isolée dans un worktree : "orch diff ${outcome.record.id}" pour voir le diff, "orch apply ${outcome.record.id}" pour l'intégrer.`,
    );
  }

  return outcome.record.status === "succeeded" ? EXIT_OK : EXIT_RUNTIME;
}
