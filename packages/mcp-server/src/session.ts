/**
 * État vivant du serveur MCP, pour la durée d'une connexion : la racine du
 * projet, le store de tâches qui en découle, et les tâches lancées par
 * `orch_delegate` — chacune avec son `AbortController` (pour `orch_cancel`)
 * et la promesse de son issue (pour `orch_await`/`orch_status`).
 *
 * Point de vigilance du brief de la tâche 7 : `orch_delegate` lance `runTask`
 * sans l'attendre. Une promesse non attendue qui rejette produirait un rejet
 * non intercepté — `launchTask` s'en protège en interceptant systématiquement
 * l'échec de `runTask` et en le transformant en `TaskOutcome` synthétique,
 * dont la trace est déposée dans le store : c'est `orch_await` qui la
 * rapportera, jamais une exception qui remonte dans le vide.
 */
import type { Queue, RunTaskInput, TaskOutcome, TaskRecord, TaskStore } from "@orch/core";
import { createQueue, fileTaskStore, loadConfig, runTask } from "@orch/core";
import { REPORT_PROTOCOL, ReportSchema } from "@orch/protocol";

export interface SessionTask {
  agentId: string;
  startedAt: string;
  controller: AbortController;
  /** Ne rejette jamais : voir `launchTask`. */
  promise: Promise<TaskOutcome>;
}

export interface McpSession {
  root: string;
  store: TaskStore;
  tasks: Map<string, SessionTask>;
  /**
   * Sémaphore partagé par tous les `orch_delegate` de cette session — voir
   * C4 de la revue finale : `RunnerDeps.queue` n'était câblé par aucune
   * façade, `max_parallel` n'était donc appliqué nulle part alors que
   * `orchDelegateDescription` encourage explicitement le modèle à appeler
   * `orch_delegate` "repeatedly back to back". Sa limite est celle de
   * `policy.max_parallel` au moment de la connexion (`createSession`) :
   * comme la détection d'installation du TUI ("chargée une seule fois, pas à
   * chaque frappe"), une édition ultérieure de la politique en cours de
   * session ne redimensionne pas cette file — limite assumée plutôt que de
   * reconstruire une file qui pourrait avoir des tâches en attente.
   */
  queue: Queue;
}

export async function createSession(root: string): Promise<McpSession> {
  const { config } = await loadConfig(root);
  return { root, store: fileTaskStore(root), tasks: new Map(), queue: createQueue(config.policy.max_parallel) };
}

/**
 * Construit le `TaskOutcome` de repli quand `runTask` rejette avant d'avoir
 * pu produire le sien. Deux cas, selon l'endroit où l'échec est survenu :
 *
 * - avant même `store.create` (p. ex. isolation "worktree" demandée hors
 *   d'un dépôt git) : aucun enregistrement n'existe encore, on en crée un ;
 * - après (p. ex. `diffWorktree` qui échoue de façon inattendue) : on
 *   termine l'enregistrement existant plutôt que de le dupliquer. `pid` est
 *   explicitement effacé : le processus fils, s'il a été lancé, est déjà
 *   sorti par construction (`runAgentProcess` ne résout qu'une fois le fils
 *   terminé), un pid encore renseigné à ce stade serait obsolète.
 */
async function synthesizeFailure(store: TaskStore, taskId: string, agentId: string, error: unknown): Promise<TaskOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();

  const existing = await store.get(taskId);
  let record: TaskRecord;
  if (existing) {
    record = await store.update(taskId, { status: "failed", ended_at: now, pid: undefined });
  } else {
    const fresh: TaskRecord = {
      id: taskId,
      agent: agentId,
      objective: "",
      status: "failed",
      created_at: now,
      started_at: now,
      ended_at: now,
      task_dir: "",
      workspace: "",
      isolation: "inplace",
      mode: "read-only",
      report_via: "file",
      depth: 0,
    };
    await store.create(fresh);
    record = fresh;
  }

  const report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: taskId,
    status: "failed",
    summary: `Tâche interrompue avant son terme : ${message}`,
  });

  return { record, report, source: "synthesized" };
}

/**
 * Dernier filet, sans aucune entrée/sortie : si même `synthesizeFailure` a
 * échoué (le store lui-même en E/S — disque plein, permissions…), on
 * construit tout de même un `TaskOutcome` valide en mémoire pure. Le
 * résultat ne reflète alors plus forcément ce que contient le store sur
 * disque, mais la promesse de la session, elle, ne rejette jamais — c'est la
 * garantie que ce module porte (voir l'en-tête du fichier).
 */
function buildInMemoryFailureOutcome(taskId: string, agentId: string, error: unknown): TaskOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  const record: TaskRecord = {
    id: taskId,
    agent: agentId,
    objective: "",
    status: "failed",
    created_at: now,
    started_at: now,
    ended_at: now,
    task_dir: "",
    workspace: "",
    isolation: "inplace",
    mode: "read-only",
    report_via: "file",
    depth: 0,
  };
  const report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: taskId,
    status: "failed",
    summary: `Tâche interrompue avant son terme, et la trace elle-même n'a pas pu être écrite dans le store : ${message}`,
  });
  return { record, report, source: "synthesized" };
}

/**
 * Lance `runTask` sans l'attendre, et conserve la promesse et son
 * `AbortController` dans la session, indexés par `input.taskId` — l'appelant
 * (voir `tools/delegate.ts`) l'a généré lui-même, justement pour pouvoir le
 * rendre avant que cette promesse ne se résolve.
 */
export function launchTask(session: McpSession, input: RunTaskInput & { taskId: string }, controller: AbortController): SessionTask {
  const promise = runTask({ store: session.store, root: session.root, queue: session.queue }, input).catch(async (error: unknown) => {
    try {
      return await synthesizeFailure(session.store, input.taskId, input.agentId, error);
    } catch (storeError) {
      // Même la trace de repli n'a pas pu être déposée dans le store : on ne
      // laisse jamais cette promesse rejeter pour autant (voir le point de
      // vigilance du brief).
      return buildInMemoryFailureOutcome(input.taskId, input.agentId, storeError);
    }
  });
  const entry: SessionTask = { agentId: input.agentId, startedAt: new Date().toISOString(), controller, promise };
  session.tasks.set(input.taskId, entry);
  return entry;
}
