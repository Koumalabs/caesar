/**
 * `orch_apply` : applique au dépôt principal le diff du worktree d'une tâche
 * isolée, par `git apply --3way` — sans jamais committer ni toucher aux
 * branches (voir `packages/core/src/engine/worktree.ts`). Voir le brief de
 * la tâche 7.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyWorktree } from "@orch/core";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";
import { loadWorktreeHandle } from "./worktree-handle.js";

export const ORCH_APPLY = "orch_apply";

export const orchApplyDescription =
  "Apply the diff of a task run with worktree isolation to the main repository (git apply --3way; never " +
  "commits, never touches branches). Use this once you have reviewed the task's result — typically via " +
  "orch_diff, especially after comparing several providers — and decided to keep it. Reports conflicts instead " +
  "of a partial apply when the patch no longer applies cleanly. A no-op (applied: true, no conflicts) for tasks " +
  "that ran inplace or made no changes.";

export const orchApplyInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by orch_delegate."),
};

const OrchApplyInputSchema = z.object(orchApplyInputShape);
export type OrchApplyInput = z.infer<typeof OrchApplyInputSchema>;

export async function orchApply(session: McpSession, input: OrchApplyInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  const handle = await loadWorktreeHandle(record);
  if (!handle) {
    return jsonResult({ task_id: input.task_id, applied: true, conflicts: [] });
  }

  const result = await applyWorktree(session.root, handle);
  return jsonResult({ task_id: input.task_id, applied: result.applied, conflicts: result.conflicts });
}

export function registerOrchApply(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_APPLY, { description: orchApplyDescription, inputSchema: orchApplyInputShape }, (args) => orchApply(session, args));
}
