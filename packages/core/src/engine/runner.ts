/**
 * Assemblage d'une exécution complète : résout l'agent, prépare l'isolation,
 * choisit le palier de rapport, lance le processus, recoupe le rapport avec
 * git, et met à jour le store. C'est la pièce qui transforme le registre en
 * orchestrateur.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, Finding, Isolation, OrchEvent, Report, ReportChannel, Task, TaskMode } from "@orch/protocol";
import { TASK_PROTOCOL, TaskSchema, renderTaskPrompt, strictReportJsonSchema, taskEnv, taskPaths, writeTask } from "@orch/protocol";
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
  channel?: Channel | null;
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

  const { isolation, warning, handle } = await prepareIsolation(deps.root, id, input, agentDef);
  const workspace = handle ? handle.path : input.workspace;

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
    channel: input.channel ?? undefined,
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

function generateTaskId(): string {
  return `t_${randomUUID().replace(/-/g, "")}`;
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
