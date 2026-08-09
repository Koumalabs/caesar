/**
 * Assemblage d'une exécution complète : résout l'agent, prépare l'isolation,
 * choisit le palier de rapport, lance le processus, recoupe le rapport avec
 * git, et met à jour le store. C'est la pièce qui transforme le registre en
 * orchestrateur.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Channel, Finding, Isolation, OrchEvent, Report, ReportChannel, Task, TaskMode, TaskPaths } from "@orch/protocol";
import {
  REPORT_PROTOCOL,
  ReportSchema,
  TASK_PROTOCOL,
  TaskSchema,
  renderTaskPrompt,
  strictReportJsonSchema,
  taskEnv,
  taskPaths,
  writeTask,
} from "@orch/protocol";
import { resolveAgentDefinition } from "../registry/index.js";
import type { AgentDefinition, SpawnPlan } from "../registry/types.js";
import type { ReportSource, TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { resolveReport, reconcileChanges } from "./report.js";
import { runAgentProcess } from "./spawn.js";
import type { RunResult } from "./spawn.js";
import { createWorktree, diffWorktree, repoRoot } from "./worktree.js";
import type { Queue } from "./queue.js";
import type { WorktreeDiff, WorktreeHandle } from "./worktree.js";

const DEFAULT_TIMEOUT_MS = 600_000;

/** Nom sous lequel le canal retour est déclaré côté agent (voir `Channel.server_name`). */
const CHANNEL_SERVER_NAME = "orch";

/**
 * Chemin absolu de `dist/bin.js` dans `@orch/mcp-channel`, résolu via la
 * résolution de module Node plutôt que supposé à un chemin relatif fixe —
 * voir le brief de la tâche 9 ("résous son chemin dynamiquement plutôt que
 * de le supposer"). Cette résolution survit à une installation en dehors de
 * ce dépôt (npm, un lien global…), tant que `@orch/mcp-channel` reste une
 * dépendance déclarée de `@orch/core` (voir son `package.json`) : c'est la
 * même méthode que `resolveTuiEntry` dans
 * `packages/cli/src/commands/config.ts` pour `@orch/tui`.
 *
 * `@orch/mcp-channel` restreint son `"exports"` à `"."` (contrairement à
 * `@orch/tui`, dépourvu d'`"exports"`, que `resolveTuiEntry` peut donc
 * résoudre jusqu'à `package.json` directement) : demander la résolution de
 * `"@orch/mcp-channel/package.json"` échouerait (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 * On résout donc l'entrée principale (`"."` → `dist/index.js`) et on
 * descend vers son voisin `dist/bin.js`, toujours émis dans le même
 * répertoire par `tsc` puisque `src/index.ts` et `src/bin.ts` sont tous deux
 * à la racine de `src/`, sans sous-répertoire.
 */
function resolveChannelEntry(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@orch/mcp-channel");
  return join(dirname(indexPath), "bin.js");
}

/**
 * Construit les coordonnées du canal retour pour une tâche. `command` est le
 * binaire Node lui-même (`process.execPath`), jamais `orch-channel` par son
 * nom ni le fichier résolu directement : ni l'un ni l'autre ne peuvent être
 * supposés exécutables ou présents dans le `PATH` du sous-agent qui le
 * lancera — voir le brief.
 *
 * Ne lève jamais : une résolution en échec (installation cassée, paquet
 * introuvable…) rend `undefined` plutôt que de faire échouer toute la
 * tâche — le canal n'est jamais un point de défaillance.
 */
function buildChannel(taskDir: string): Channel | undefined {
  try {
    const entry = resolveChannelEntry();
    return { transport: "mcp-stdio", command: process.execPath, args: [entry, taskDir], server_name: CHANNEL_SERVER_NAME };
  } catch {
    return undefined;
  }
}

/**
 * Nom du fichier où un CLI capable de `finalMessageFile` dépose son dernier
 * message, sous le répertoire de la tâche. Chemin fixe et prévisible : un
 * agent qui connaît son répertoire de tâche (`$ORCH_TASK_DIR`) peut le
 * retrouver sans qu'aucun jeton dédié n'existe dans le gabarit générique
 * d'arguments (`GenericAgentSpec`, tâche 3) — c'est ce que fait l'agent
 * factice dans les tests.
 */
const FINAL_MESSAGE_FILE_NAME = "final-message.txt";

export interface RunnerDeps {
  store: TaskStore;
  root: string;
  queue?: Queue;
}

export interface RunTaskInput {
  agentId: string;
  objective: string;
  context?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
  mode: TaskMode;
  isolation?: Isolation | "auto";
  workspace: string;
  role?: string;
  model?: string;
  timeoutMs?: number;
  depth?: number;
  extraArgs?: string[];
  /**
   * Active le canal retour MCP bidirectionnel pour cette tâche, si l'agent
   * cible sait charger un serveur MCP (`capabilities.mcpInjection !==
   * "none"`) : le runner construit alors lui-même les coordonnées du
   * `Channel` (voir `buildChannel`/`resolveChannelEntry` plus bas) — binaire
   * `orch-channel` résolu dynamiquement, argument `taskDir`, nom de serveur
   * `"orch"` — aucun appelant n'a besoin d'en connaître le détail. Absent ou
   * faux (défaut) : comportement inchangé, aucun canal proposé — voir le
   * brief de la tâche 9 : le canal ajoute un processus et une injection de
   * configuration à chaque délégation, cela se choisit explicitement.
   *
   * Sans effet, jamais une erreur, si l'agent ne sait pas charger de serveur
   * MCP ou si la résolution du binaire échoue (installation cassée…) : le
   * canal n'est jamais un point de défaillance, la tâche retombe alors sur
   * le palier de rapport suivant (`defaultPreferredReportChannel`).
   */
  channel?: boolean;
  /**
   * Identifiant à utiliser pour cette tâche, plutôt que d'en générer un.
   * Permet à l'appelant de connaître à l'avance le répertoire de la tâche
   * (`<root>/.orch/tasks/<taskId>`) — donc de la suivre (`events.jsonl`)
   * pendant qu'elle tourne, ou de la référencer avant même que `runTask` ne
   * résolve. Absent : comportement inchangé, un identifiant est généré ici
   * comme avant. Sert notamment le CLI (`orch run`, avancement en direct) et,
   * à terme, le serveur MCP (`orch_delegate`, qui doit rendre un identifiant
   * immédiatement pour permettre plusieurs délégations en parallèle).
   */
  taskId?: string;
  /**
   * Transmis tel quel à `runAgentProcess`, qui le supporte déjà : permet à
   * l'appelant d'annuler une tâche en cours sans attendre sa résolution, en
   * garantissant qu'aucun sous-processus n'est laissé derrière (SIGTERM puis,
   * à défaut de réponse, SIGKILL — voir `spawn.ts`).
   */
  signal?: AbortSignal;
  /**
   * Transmis tel quel à `runAgentProcess`, qui le supporte déjà : permet à
   * l'appelant d'observer les événements normalisés au fil de l'eau, plutôt
   * que de devoir relire `events.jsonl` après coup.
   */
  onEvent?: (event: OrchEvent) => void;
}

export interface TaskOutcome {
  record: TaskRecord;
  report: Report;
  source: ReportSource;
  diff?: WorktreeDiff;
}

export async function runTask(deps: RunnerDeps, input: RunTaskInput): Promise<TaskOutcome> {
  const agentDef = resolveAgentDefinition(input.agentId);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const depth = input.depth ?? 0;

  const id = input.taskId ?? generateTaskId();
  const taskDir = join(deps.root, ".orch", "tasks", id);
  const paths = taskPaths(taskDir);

  // Vérifié ici, avant d'engager l'isolation : la préparation qui suit peut
  // créer un worktree git, une opération qui n'est pas instantanée. Sans ce
  // garde, un signal déjà déclenché à l'entrée serait ignoré jusqu'au bout —
  // `runAgentProcess` (deuxième garde, juste avant de lancer le fils) ne
  // couvre que l'annulation survenue *pendant* cette préparation.
  if (input.signal?.aborted) {
    return abortBeforeStart(deps, input, id, paths, agentDef, depth);
  }

  const { isolation, warning, handle } = await prepareIsolation(deps.root, id, input, agentDef);
  const workspace = handle ? handle.path : input.workspace;

  const channel: Channel | undefined =
    input.channel === true && agentDef.capabilities.mcpInjection !== "none" ? buildChannel(paths.dir) : undefined;

  const task: Task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id,
    created_at: new Date().toISOString(),
    role: input.role,
    agent: agentDef.id,
    objective: input.objective,
    context: input.context ?? "",
    constraints: input.constraints ?? [],
    acceptance_criteria: input.acceptance_criteria ?? [],
    mode: input.mode,
    isolation,
    workspace,
    base_ref: handle?.baseRef,
    deadline_ms: timeoutMs,
    depth,
    report_path: paths.reportPath,
    events_path: paths.eventsPath,
    channel,
  });

  const channelAvailable = task.channel != null;
  const reportVia: ReportChannel = agentDef.preferredReportChannel(task, channelAvailable);

  let schemaFile: string | undefined;
  if (reportVia === "schema") {
    await mkdir(paths.dir, { recursive: true });
    schemaFile = join(paths.dir, "report.schema.json");
    await writeFile(schemaFile, JSON.stringify(strictReportJsonSchema(), null, 2) + "\n", "utf8");
  }

  const prompt = renderTaskPrompt(task, { reportVia, channelServerName: task.channel?.server_name });

  // Quand le CLI sait lui-même déposer son dernier message dans un fichier
  // (Codex avec `-o`, par exemple), c'est plus fiable qu'une reconstitution
  // depuis stdout : `resolveReport` le consulte en priorité au palier 2.
  const finalMessageFile = agentDef.capabilities.finalMessageFile ? join(paths.dir, FINAL_MESSAGE_FILE_NAME) : undefined;

  const plan = agentDef.build({
    task,
    paths,
    prompt,
    reportVia,
    schemaFile,
    finalMessageFile,
    extraArgs: input.extraArgs ?? [],
  });
  // Le contrat minimal d'un agent externe ($ORCH_TASK_FILE, $ORCH_REPORT_PATH…)
  // ne dépend d'aucun adaptateur : c'est le moteur qui le garantit, ici, pour
  // tout agent, générique ou non.
  const finalPlan: SpawnPlan = { ...plan, env: { ...taskEnv(task, paths), ...plan.env } };

  await writeTask(paths, task);

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "running",
    created_at: task.created_at,
    started_at: new Date().toISOString(),
    task_dir: paths.dir,
    workspace,
    isolation,
    mode: input.mode,
    branch: handle?.branch,
    report_via: reportVia,
    depth,
  };
  await deps.store.create(record);

  const execute = (): Promise<RunResult> =>
    runAgentProcess({
      agent: agentDef,
      plan: finalPlan,
      paths,
      taskId: id,
      timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
      // Renseigne le pid dès qu'il est connu, pour qu'un autre processus
      // (typiquement `orch cancel`) puisse retrouver et signaler la tâche
      // pendant qu'elle tourne encore — voir `TaskRecord.pid`.
      onSpawn: async (pid) => {
        await deps.store.update(id, { pid });
      },
    });
  const run = deps.queue ? await deps.queue.run(execute) : await execute();

  const diff = handle ? await diffWorktree(handle) : undefined;

  const resolved = await resolveReport({ task, paths, run, diff, reportVia, finalMessageFile });
  let report = resolved.report;

  if (diff) {
    report = reconcileChanges(report, diff);
  }

  if (task.mode === "read-only" && diff && !diff.isEmpty) {
    report = withFinding(report, {
      severity: "high",
      title: "Écriture détectée pendant une tâche en lecture seule",
      detail: `Fichiers modifiés malgré le mode lecture seule : ${diff.files.map((f) => f.path).join(", ")}`,
    });
  }

  if (warning) {
    report = withFinding(report, { severity: "low", title: "Isolation dégradée", detail: warning });
  }

  const finalStatus = deriveTaskStatus(run);
  const updated = await deps.store.update(id, {
    status: finalStatus,
    ended_at: new Date().toISOString(),
    exit_code: run.exitCode,
    report_source: resolved.source,
    // Le processus n'existe plus : un pid effacé évite à `orch cancel` de
    // signaler un pid réutilisé entre-temps par un tout autre processus.
    pid: undefined,
  });

  return { record: updated, report, source: resolved.source, diff };
}

/** Utilisée par `runTask` quand `input.taskId` est absent. Exportée pour que les
 * appelants qui préfèrent imposer leur propre identifiant (voir `RunTaskInput.taskId`)
 * réutilisent le même format plutôt que d'en tenir une seconde implémentation. */
export function generateTaskId(): string {
  return `t_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Court-circuite `runTask` quand `input.signal` est déjà déclenché à l'entrée :
 * aucune isolation n'est préparée (pas de worktree git, potentiellement
 * lent), `agentDef.build` n'est pas appelé, et surtout aucun processus n'est
 * lancé. Le résultat reste un `TaskOutcome` valide, visible par
 * `orch ps`/`orch logs` comme n'importe quelle autre tâche annulée.
 */
async function abortBeforeStart(
  deps: RunnerDeps,
  input: RunTaskInput,
  id: string,
  paths: TaskPaths,
  agentDef: AgentDefinition,
  depth: number,
): Promise<TaskOutcome> {
  const now = new Date().toISOString();
  // Aucune décision d'isolation réelle n'a été prise puisque `prepareIsolation`
  // n'a jamais tourné : "auto" n'a pas de sens ici, "inplace" est la valeur la
  // plus honnête (pas de worktree créé), l'isolation explicitement demandée
  // sinon.
  const isolation: Isolation = input.isolation && input.isolation !== "auto" ? input.isolation : "inplace";

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "cancelled",
    created_at: now,
    started_at: now,
    ended_at: now,
    task_dir: paths.dir,
    workspace: input.workspace,
    isolation,
    mode: input.mode,
    report_via: "file",
    depth,
  };
  await deps.store.create(record);

  const report: Report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: id,
    status: "failed",
    summary: "Tâche annulée avant le lancement : le signal d'abandon était déjà déclenché à l'entrée de runTask.",
  });

  return { record, report, source: "synthesized" };
}

function withFinding(report: Report, finding: Finding): Report {
  return { ...report, findings: [...report.findings, finding] };
}

function deriveTaskStatus(run: RunResult): TaskStatus {
  if (run.aborted) return "cancelled";
  if (run.timedOut) return "timed_out";
  return run.exitCode === 0 ? "succeeded" : "failed";
}

interface IsolationPreparation {
  isolation: Isolation;
  warning?: string;
  handle?: WorktreeHandle;
}

/**
 * Applique la règle d'isolation `"auto"` (voir le brief de la tâche) puis, si
 * le résultat est `"worktree"`, crée effectivement le worktree.
 *
 * Le dernier cas de la table — lecture seule chez un agent dépourvu de mode
 * lecture seule appliqué par son CLI — est délibéré : le worktree jetable
 * transforme une promesse de prompt en garantie constatable.
 */
async function prepareIsolation(
  root: string,
  taskId: string,
  input: RunTaskInput,
  agentDef: AgentDefinition,
): Promise<IsolationPreparation> {
  const requested = input.isolation ?? "auto";
  const base = await repoRoot(input.workspace);

  let isolation: Isolation;
  let warning: string | undefined;

  if (requested !== "auto") {
    isolation = requested;
  } else if (input.mode === "write") {
    if (base) {
      isolation = "worktree";
    } else {
      isolation = "inplace";
      warning = `Le workspace "${input.workspace}" n'est pas un dépôt git : isolation repliée sur "inplace" malgré le mode écriture.`;
    }
  } else if (agentDef.capabilities.nativeReadOnly) {
    isolation = "inplace";
  } else if (base) {
    isolation = "worktree";
  } else {
    isolation = "inplace";
    warning = `Le workspace "${input.workspace}" n'est pas un dépôt git : isolation repliée sur "inplace" malgré l'absence de mode lecture seule natif chez "${agentDef.id}".`;
  }

  if (isolation !== "worktree") {
    return { isolation, warning };
  }

  if (!base) {
    throw new Error(`Isolation "worktree" demandée pour la tâche "${taskId}", mais "${input.workspace}" n'est pas un dépôt git.`);
  }

  const handle = await createWorktree(base, taskId);
  return { isolation, handle };
}
