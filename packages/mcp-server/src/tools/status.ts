/**
 * `orch_status` : un coup d'œil non bloquant sur une tâche — son état et le
 * dernier événement connu, sans attendre ni rendre le rapport complet (c'est
 * `orch_await` qui le rend, une fois la tâche terminée) — voir le brief de
 * la tâche 7.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readEvents, taskPaths } from "@orch/protocol";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const ORCH_STATUS = "orch_status";

export const orchStatusDescription =
  "Get a quick, non-blocking snapshot of a task started by orch_delegate: its current status (pending, " +
  "running, succeeded, failed, cancelled, timed_out), timestamps, and the last normalized event recorded so " +
  "far (a tool call, a file change, a progress message…). Unlike orch_await, this never waits and never " +
  "returns the final report — use it to check in on a long-running task without blocking, then orch_await once " +
  "you actually need the result, or orch_logs for more than just the last event.";

export const orchStatusInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by orch_delegate."),
};

const OrchStatusInputSchema = z.object(orchStatusInputShape);
export type OrchStatusInput = z.infer<typeof OrchStatusInputSchema>;

export async function orchStatus(session: McpSession, input: OrchStatusInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  const events = await readEvents(taskPaths(record.task_dir));
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return jsonResult({
    task_id: record.id,
    status: record.status,
    agent: record.agent,
    role: record.role,
    mode: record.mode,
    isolation: record.isolation,
    created_at: record.created_at,
    started_at: record.started_at,
    ended_at: record.ended_at,
    last_event: lastEvent,
  });
}

export function registerOrchStatus(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_STATUS, { description: orchStatusDescription, inputSchema: orchStatusInputShape }, (args) =>
    orchStatus(session, args),
  );
}
