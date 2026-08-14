/**
 * `caesar_status` : un coup d'œil non bloquant sur une tâche — son état et le
 * dernier événement connu, sans attendre ni rendre le rapport complet (c'est
 * `caesar_await` qui le rend, une fois la tâche terminée) — voir le brief de
 * la tâche 7.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listPendingQuestions } from "@caesar/mcp-channel";
import { sweepAbandonedTasks } from "@caesar/core";
import { readEvents, taskPaths } from "@caesar/protocol";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_STATUS = "caesar_status";

export const caesarStatusDescription =
  "Get a quick, non-blocking snapshot of a task started by caesar_delegate: its current status (pending, " +
  "running, succeeded, failed, cancelled, timed_out), timestamps, and the last normalized event recorded so " +
  "far (a tool call, a file change, a progress message…). Once the task has produced a report, " +
  "report_status (success, partial, failed, blocked — the sub-agent's own verdict) is also included: status " +
  "reflects only the process outcome, not what the sub-agent reported, so a sub-agent that writes " +
  "{\"status\":\"failed\"} and still exits 0 shows status: succeeded here — check report_status too before " +
  "assuming a task actually succeeded. Also reports pending_questions — anything the task's sub-agent has " +
  "asked via its ask_orchestrator back-channel tool and is still waiting on; answer them with caesar_answer. " +
  "Unlike caesar_await, this never waits and never returns the full report — use it to check in on a " +
  "long-running task without blocking, then caesar_await once you actually need the result, or caesar_logs for " +
  "more than just the last event.";

export const caesarStatusInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
};

const CaesarStatusInputSchema = z.object(caesarStatusInputShape);
export type CaesarStatusInput = z.infer<typeof CaesarStatusInputSchema>;

export async function caesarStatus(session: McpSession, input: CaesarStatusInput): Promise<CallToolResult> {
  // Une tâche lancée par un serveur MCP qu'on a depuis fermé garde le statut
  // "running" que son processus n'a jamais eu l'occasion de conclure. La
  // rendre telle quelle ici serait dire à l'appelant d'attendre quelque chose
  // que plus personne ne fait — voir `sweepAbandonedTasks`. Les tâches de
  // cette session, elles, sont conduites par ce processus-ci : leur marqueur
  // est vivant, le balayage ne les touche pas.
  await sweepAbandonedTasks(session.root, session.store);

  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  const paths = taskPaths(record.task_dir);
  const events = await readEvents(paths);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const pendingQuestions = await listPendingQuestions(paths.dir);

  return jsonResult({
    task_id: record.id,
    status: record.status,
    // I3 de la revue finale : distinct de `status`, qui ne reflète que
    // l'issue du processus — voir la description du tool.
    report_status: record.report_status,
    agent: record.agent,
    role: record.role,
    mode: record.mode,
    isolation: record.isolation,
    created_at: record.created_at,
    started_at: record.started_at,
    ended_at: record.ended_at,
    last_event: lastEvent,
    pending_questions: pendingQuestions,
  });
}

export function registerCaesarStatus(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_STATUS, { description: caesarStatusDescription, inputSchema: caesarStatusInputShape }, (args) =>
    caesarStatus(session, args),
  );
}
