/**
 * `caesar_await`: waits for one or more `taskId`s started by
 * `caesar_delegate`, and returns each one's normalized report — see the
 * task 7 brief.
 *
 * Never waits indefinitely: once `timeout_ms` has elapsed, tasks still
 * running are returned as-is (`pending: true`) rather than blocking the
 * caller. A second `caesar_await` with the same ids resumes the wait where
 * it left off — the session's promise, for its part, keeps running in the
 * background in the meantime.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskOutcome, TaskRecord } from "@caesar/core";
import { sweepAbandonedTasks } from "@caesar/core";
import { listPendingQuestions } from "@caesar/mcp-channel";
import { readReport, taskPaths } from "@caesar/protocol";
import type { McpSession } from "../session.js";
import { jsonResult } from "./result.js";
import { summarizeReport } from "./report-summary.js";

export const CAESAR_AWAIT = "caesar_await";

/** Reasonable default: short enough to stay responsive, long enough to cover most short tasks. */
const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;

export const caesarAwaitDescription =
  "Wait for one or more tasks started by caesar_delegate to finish, and return their normalized reports (status, " +
  "summary, files changed, findings, questions). changes_verified_by in the report tells you how much to trust " +
  "the files-changed list: \"git\" means it was cross-checked against the actual git state of the workspace " +
  "(true whenever the workspace is a git repository, in both isolations); \"declaration\" means no git check " +
  "was possible and it is only the sub-agent's own claim. Pass every task_id from a batch of parallel " +
  "caesar_delegate calls in a single caesar_await call to collect all their results together — that is the reason " +
  "caesar_delegate does not block on its own. Tasks still running when timeout_ms elapses are reported with " +
  "pending: true instead of a report — and, when the sub-agent has called its ask_orchestrator back-channel " +
  "tool and is still waiting on an answer, with pending_questions listing what it asked: a task waiting on you " +
  "is never indistinguishable from one simply still working. Answer with caesar_answer, then call caesar_await " +
  "again with the same task_id to keep waiting, or caesar_status for a lighter, non-blocking check.";

export const caesarAwaitInputShape = {
  task_ids: z
    .array(z.string().min(1))
    .min(1)
    .describe("One or more task_id values previously returned by caesar_delegate."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How long to wait for the tasks to finish, in milliseconds. Defaults to ${DEFAULT_AWAIT_TIMEOUT_MS} (30s).`),
};

const CaesarAwaitInputSchema = z.object(caesarAwaitInputShape);
export type CaesarAwaitInput = z.infer<typeof CaesarAwaitInputSchema>;

/** Sentinel distinguishable from any domain value (including `undefined`) that `Promise.resolve` could produce. */
const TIMED_OUT = Symbol("caesar_await:timed_out");

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Must never keep the process from exiting if nothing else is holding it
    // up — a `caesar_await` in flight is no reason to block a clean server
    // shutdown.
    timer.unref?.();
    // `promise` (the one kept in the session) never rejects by construction
    // — see `session.ts` — but we guard against it anyway: a rejection must
    // never turn a mere expiry into an exception that would bubble up to
    // the tool.
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
 * Fallback when `taskId` is unknown to the current session (task started by
 * another process — a previous MCP server, or `caesar run`). The report, if
 * it exists, comes from the file the agent left behind (the "file" tier):
 * it is not reconciled with git here, short of rebuilding a
 * `WorktreeHandle` for this sole purpose — a documented limitation rather
 * than silently papered over.
 */
async function describeFromStore(record: TaskRecord): Promise<Record<string, unknown>> {
  const base = { task_id: record.id, status: record.status, agent: record.agent, role: record.role };
  if (record.status === "pending" || record.status === "running") {
    // A task still in flight is not just "pending": if its subagent is
    // waiting on an answer via ask_orchestrator, that must be said — and
    // what it asked — rather than leaving it indistinguishable from a task
    // simply still working (see the task 9 brief).
    const pendingQuestions = await listPendingQuestions(taskPaths(record.task_dir).dir);
    return { ...base, pending: true, pending_questions: pendingQuestions };
  }
  const report = await readReport(taskPaths(record.task_dir));
  return { ...base, pending: false, report: report ? summarizeReport(report, record.changes_verified_by ?? "declaration") : undefined };
}

async function awaitOne(session: McpSession, taskId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const entry = session.tasks.get(taskId);
  if (!entry) {
    // Task from another process. If it was killed without concluding, its
    // record still says "running": returning it as `pending: true` would
    // amount to advising the caller to wait, indefinitely, on a task nobody
    // is driving anymore. The sweep only acts on proof that the process has
    // disappeared — see `sweepAbandonedTasks`.
    await sweepAbandonedTasks(session.root, session.store);
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

export async function caesarAwait(session: McpSession, input: CaesarAwaitInput): Promise<CallToolResult> {
  const timeoutMs = input.timeout_ms ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const entries = await Promise.all(input.task_ids.map(async (taskId) => [taskId, await awaitOne(session, taskId, timeoutMs)] as const));
  const tasks = Object.fromEntries(entries);
  return jsonResult({ tasks });
}

export function registerCaesarAwait(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_AWAIT, { description: caesarAwaitDescription, inputSchema: caesarAwaitInputShape }, (args) => caesarAwait(session, args));
}
