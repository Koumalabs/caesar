/**
 * `caesar_cancel`: cancels a running task — see the task 7 brief.
 *
 * Two paths, depending on whether this session started the task or not:
 *
 * - known to the session (the common case: this server instance is the one
 *   that launched `runTask`): we trigger directly the `AbortController`
 *   kept by `caesar_delegate` — the engine (`runAgentProcess`) already
 *   honors it (SIGTERM then, absent a response, SIGKILL). We then await the
 *   promise (never rejected — see `session.ts`) to return the final status
 *   actually observed, not a guess;
 * - unknown to the session (task started by another process — `caesar run`
 *   from the CLI, or a previous server instance): fall back on the `pid`
 *   recorded in the store, exactly like `caesar cancel` in the CLI
 *   (`packages/cli/src/commands/tasks.ts`) — same technique, duplicated
 *   here for lack of a shared export point (see the task 7 report).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskStatus } from "@caesar/core";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_CANCEL = "caesar_cancel";

export const caesarCancelDescription =
  "Cancel a task started by caesar_delegate that is still running: signals the sub-agent process to stop " +
  "(SIGTERM, escalating to SIGKILL if it does not exit) and waits for the shutdown to complete before " +
  "returning. Safe to call on a task that already finished — it is then a no-op that just reports the final " +
  "status, cancelled: false.";

export const caesarCancelInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
};

const CaesarCancelInputSchema = z.object(caesarCancelInputShape);
export type CaesarCancelInput = z.infer<typeof CaesarCancelInputSchema>;

const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];

export async function caesarCancel(session: McpSession, input: CaesarCancelInput): Promise<CallToolResult> {
  const entry = session.tasks.get(input.task_id);
  if (entry) {
    entry.controller.abort();
    const outcome = await entry.promise;
    return jsonResult({ task_id: input.task_id, cancelled: outcome.record.status === "cancelled", status: outcome.record.status });
  }

  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  if (!ACTIVE_STATUSES.includes(record.status)) {
    return jsonResult({ task_id: input.task_id, cancelled: false, status: record.status });
  }
  if (record.pid === undefined) {
    return errorResult(
      `Task "${input.task_id}" is running, but no process id is recorded: it cannot be cancelled from this server.`,
    );
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      const updated = await session.store.update(input.task_id, { status: "cancelled", ended_at: new Date().toISOString(), pid: undefined });
      return jsonResult({ task_id: input.task_id, cancelled: true, status: updated.status });
    }
    throw error;
  }

  const updated = await session.store.update(input.task_id, { status: "cancelled", ended_at: new Date().toISOString() });
  return jsonResult({ task_id: input.task_id, cancelled: true, status: updated.status });
}

export function registerCaesarCancel(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_CANCEL, { description: caesarCancelDescription, inputSchema: caesarCancelInputShape }, (args) =>
    caesarCancel(session, args),
  );
}
