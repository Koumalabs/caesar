/**
 * `caesar_status`: a non-blocking glance at a task — its state and the last
 * known event, without waiting or returning the full report (that is what
 * `caesar_await` returns, once the task is done) — see the task 7 brief.
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
  // A task launched by an MCP server that has since been closed keeps the
  // "running" status its process never had the chance to conclude.
  // Returning it as-is here would tell the caller to wait for something
  // nobody is doing anymore — see `sweepAbandonedTasks`. This session's own
  // tasks are driven by this very process: their marker is alive, the
  // sweep does not touch them.
  await sweepAbandonedTasks(session.root, session.store);

  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  const paths = taskPaths(record.task_dir);
  const events = await readEvents(paths);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const pendingQuestions = await listPendingQuestions(paths.dir);

  return jsonResult({
    task_id: record.id,
    status: record.status,
    // I3 of the final review: distinct from `status`, which reflects only
    // the process outcome — see the tool's description.
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
