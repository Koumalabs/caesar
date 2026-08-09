/**
 * `orch run` : résout la racine → charge la config → résout le rôle s'il y en
 * a un → choisit l'agent (`--agent` l'emporte sur le rôle) → `checkDelegation`
 * → `runTask`. Voir le brief pour l'enchaînement exact.
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
 * contrat que celui dont le serveur MCP aura besoin (`orch_delegate`
 * asynchrone, rendant un identifiant immédiatement).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Isolation, OrchEvent, TaskMode } from "@orch/protocol";
import type { ResolvedRole } from "@orch/core";
import { checkDelegation, findAgentDefinition, findBinaryInPath, fileTaskStore, loadConfig, parseDuration, pickAgentForRole, resolveRole, runTask } from "@orch/core";
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
}

const TASK_MODES: readonly TaskMode[] = ["read-only", "write"];
const ISOLATIONS: readonly (Isolation | "auto")[] = ["inplace", "worktree", "auto"];

async function resolveContext(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw.startsWith("@")) {
    const path = resolve(process.cwd(), raw.slice(1));
    return await readFile(path, "utf8");
  }
  return raw;
}

/** Identifiant lisible, dans le même format que celui que `runner.ts` aurait généré. */
function generateTaskId(): string {
  return `t_${randomUUID().replace(/-/g, "")}`;
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

  let role: ResolvedRole | null = null;
  if (options.role) {
    role = await resolveRole(config, root, options.role);
    if (!role) {
      printError(io, `Rôle inconnu : "${options.role}".`);
      return EXIT_USAGE;
    }
  }

  let agentId: string;
  if (options.agent) {
    agentId = options.agent;
  } else if (role) {
    const installed = new Map<string, boolean>();
    await Promise.all(
      role.agents.map(async (id) => {
        const def = findAgentDefinition(id);
        installed.set(id, def ? (await findBinaryInPath(def.bin)) !== null : false);
      }),
    );
    const pick = pickAgentForRole(role, { isInstalled: (id) => installed.get(id) ?? false, policy: config.policy });
    if ("error" in pick) {
      printError(io, pick.error);
      return EXIT_USAGE;
    }
    agentId = pick.agentId;
  } else {
    printError(io, "Précisez --agent <id> ou --role <name>.");
    return EXIT_USAGE;
  }

  if (!findAgentDefinition(agentId)) {
    printError(io, `Agent inconnu : "${agentId}".`);
    return EXIT_USAGE;
  }

  if (options.mode && !TASK_MODES.includes(options.mode as TaskMode)) {
    printError(io, `--mode invalide (attendu l'une de : ${TASK_MODES.join(", ")}).`);
    return EXIT_USAGE;
  }
  if (options.isolation && !ISOLATIONS.includes(options.isolation as Isolation | "auto")) {
    printError(io, `--isolation invalide (attendu l'une de : ${ISOLATIONS.join(", ")}).`);
    return EXIT_USAGE;
  }

  const decision = checkDelegation(config.policy, { agentId, depth: 0 });
  if (!decision.allowed) {
    printError(io, decision.reason);
    return EXIT_USAGE;
  }

  const mode: TaskMode = (options.mode as TaskMode | undefined) ?? role?.mode ?? config.policy.default_mode;
  const isolation: Isolation | "auto" = (options.isolation as Isolation | "auto" | undefined) ?? role?.isolation ?? config.policy.default_isolation;

  let timeoutMs: number;
  try {
    timeoutMs = options.timeout ? parseDuration(options.timeout) : (role?.timeout_ms ?? config.policy.default_timeout_ms);
  } catch (error) {
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  let context: string | undefined;
  try {
    context = await resolveContext(options.context);
  } catch (error) {
    printError(io, `Impossible de lire --context : ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }
  if (role?.systemPrompt) {
    context = [role.systemPrompt, context].filter((part) => part && part.trim() !== "").join("\n\n---\n\n");
  }

  const store = fileTaskStore(root);
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
      { store, root },
      {
        agentId,
        objective,
        ...(context !== undefined ? { context } : {}),
        mode,
        isolation,
        workspace: root,
        ...(options.role ? { role: options.role } : {}),
        ...(options.model ? { model: options.model } : {}),
        timeoutMs,
        taskId,
        signal: controller.signal,
        ...(onEvent ? { onEvent } : {}),
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
