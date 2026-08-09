/**
 * `orch_await` : attend un ou plusieurs `taskId` lancés par `orch_delegate`,
 * et rend le rapport normalisé de chacun — voir le brief de la tâche 7.
 *
 * N'attend jamais indéfiniment : passé `timeout_ms`, les tâches encore en
 * cours sont rendues telles quelles (`pending: true`), plutôt que de bloquer
 * l'appelant. Un second `orch_await` avec les mêmes identifiants reprend
 * l'attente là où elle s'est arrêtée — la promesse de la session, elle,
 * continue de courir en arrière-plan entre-temps.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskOutcome, TaskRecord } from "@orch/core";
import { listPendingQuestions } from "@orch/mcp-channel";
import { readReport, taskPaths } from "@orch/protocol";
import type { McpSession } from "../session.js";
import { jsonResult } from "./result.js";
import { summarizeReport } from "./report-summary.js";

export const ORCH_AWAIT = "orch_await";

/** Défaut raisonnable : assez court pour rester réactif, assez long pour couvrir la plupart des tâches courtes. */
const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;

export const orchAwaitDescription =
  "Wait for one or more tasks started by orch_delegate to finish, and return their normalized reports (status, " +
  "summary, files changed, findings, questions). changes_verified_by in the report tells you how much to trust " +
  "the files-changed list: \"git\" means it was cross-checked against the actual git state of the workspace " +
  "(true whenever the workspace is a git repository, in both isolations); \"declaration\" means no git check " +
  "was possible and it is only the sub-agent's own claim. Pass every task_id from a batch of parallel " +
  "orch_delegate calls in a single orch_await call to collect all their results together — that is the reason " +
  "orch_delegate does not block on its own. Tasks still running when timeout_ms elapses are reported with " +
  "pending: true instead of a report — and, when the sub-agent has called its ask_orchestrator back-channel " +
  "tool and is still waiting on an answer, with pending_questions listing what it asked: a task waiting on you " +
  "is never indistinguishable from one simply still working. Answer with orch_answer, then call orch_await " +
  "again with the same task_id to keep waiting, or orch_status for a lighter, non-blocking check.";

export const orchAwaitInputShape = {
  task_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe("One or more task_id values previously returned by orch_delegate."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How long to wait for the tasks to finish, in milliseconds. Defaults to ${DEFAULT_AWAIT_TIMEOUT_MS} (30s).`),
};

const OrchAwaitInputSchema = z.object(orchAwaitInputShape);
export type OrchAwaitInput = z.infer<typeof OrchAwaitInputSchema>;

/** Sentinelle distinguable de toute valeur métier (y compris `undefined`) que `Promise.resolve` pourrait produire. */
const TIMED_OUT = Symbol("orch_await:timed_out");

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Ne doit jamais empêcher le processus de se terminer si, par ailleurs,
    // plus rien ne le retient — un `orch_await` en cours n'est pas une raison
    // de bloquer un arrêt propre du serveur.
    timer.unref?.();
    // `promise` (celle conservée dans la session) ne rejette jamais par
    // construction — voir `session.ts` — mais on s'en protège tout de même :
    // un rejet ne doit jamais transformer une simple expiration en exception
    // qui remonterait jusqu'au tool.
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

function outcomeToResult(taskId: string, outcome: TaskOutcome): Record<string, unknown> {
  return {
    task_id: taskId,
    status: outcome.record.status,
    agent: outcome.record.agent,
    role: outcome.record.role,
    pending: false,
    report: summarizeReport(outcome.report, outcome.record.changes_verified_by ?? "declaration"),
  };
}

/**
 * Repli quand `taskId` est inconnu de la session en cours (tâche lancée par
 * un autre processus — un précédent serveur MCP, ou `orch run`). Le rapport,
 * s'il existe, vient du fichier laissé par l'agent (palier "fichier") : il
 * n'est pas recoupé avec git ici, faute de reconstituer un `WorktreeHandle`
 * pour ce seul usage — limite documentée plutôt que rapprochée en silence.
 */
async function describeFromStore(record: TaskRecord): Promise<Record<string, unknown>> {
  const base = { task_id: record.id, status: record.status, agent: record.agent, role: record.role };
  if (record.status === "pending" || record.status === "running") {
    // Une tâche encore en cours n'est pas juste "pending" : si son sous-agent
    // attend une réponse via ask_orchestrator, il faut le dire — et dire quoi
    // — plutôt que de la rendre indiscernable d'une tâche qui travaille
    // simplement encore (voir le brief de la tâche 9).
    const pendingQuestions = await listPendingQuestions(taskPaths(record.task_dir).dir);
    return { ...base, pending: true, pending_questions: pendingQuestions };
  }
  const report = await readReport(taskPaths(record.task_dir));
  return { ...base, pending: false, report: report ? summarizeReport(report, record.changes_verified_by ?? "declaration") : undefined };
}

async function awaitOne(session: McpSession, taskId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const entry = session.tasks.get(taskId);
  if (!entry) {
    const record = await session.store.get(taskId);
    if (!record) return { task_id: taskId, status: "unknown" };
    return describeFromStore(record);
  }

  const outcome = await raceTimeout(entry.promise, timeoutMs);
  if (outcome === TIMED_OUT) {
    const record = await session.store.get(taskId);
    const pendingQuestions = record ? await listPendingQuestions(taskPaths(record.task_dir).dir) : [];
    return { task_id: taskId, status: record?.status ?? "running", agent: entry.agentId, pending: true, pending_questions: pendingQuestions };
  }
  return outcomeToResult(taskId, outcome);
}

export async function orchAwait(session: McpSession, input: OrchAwaitInput): Promise<CallToolResult> {
  const timeoutMs = input.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const entries = await Promise.all(input.task_ids.map(async (taskId) => [taskId, await awaitOne(session, taskId, timeoutMs)] as const));
  const tasks = Object.fromEntries(entries);
  return jsonResult({ tasks });
}

export function registerOrchAwait(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_AWAIT, { description: orchAwaitDescription, inputSchema: orchAwaitInputShape }, (args) => orchAwait(session, args));
}
