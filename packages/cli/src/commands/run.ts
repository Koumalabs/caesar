/**
 * `orch run` : résout la racine → charge la config → résout le rôle s'il y en
 * a un → choisit l'agent (`--agent` l'emporte sur le rôle) → `checkDelegation`
 * → `runTask`. Voir le brief pour l'enchaînement exact.
 *
 * Concession documentée : `RunTaskInput` (`@orch/core`) n'accepte ni
 * `AbortSignal` ni callback d'événements — seule extension autorisée par ce
 * brief hors `packages/cli` : `TaskRecord.pid`, pour `orch cancel`. Un
 * `Ctrl-C` pendant `orch run` s'appuie donc sur le comportement standard de
 * POSIX : le sous-processus, lancé sans `detached`, partage le groupe de
 * processus du CLI et reçoit SIGINT directement du terminal, sans relais
 * explicite nécessaire. `orch run` se contente d'afficher un message plutôt
 * que de couper l'attente du résultat. De même, l'avancement affiché en mode
 * humain provient de la relecture de `events.jsonl` une fois la tâche
 * terminée plutôt que d'un flux en direct, `runTask` ne remontant pas
 * d'événements en cours de route.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Isolation, OrchEvent, TaskMode } from "@orch/protocol";
import { readEvents, taskPaths } from "@orch/protocol";
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

function describeEvent(event: OrchEvent): string | undefined {
  switch (event.type) {
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

  const onSigint = (): void => {
    printError(io, "Interruption demandée : le sous-processus reçoit SIGINT directement du terminal ; en attente de sa fin propre…");
  };
  process.on("SIGINT", onSigint);

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

  const events = await readEvents(taskPaths(outcome.record.task_dir));
  for (const event of events) {
    const line = describeEvent(event);
    if (line) writeLine(io.stdout, line);
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
