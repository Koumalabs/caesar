/**
 * `caesar_apply`: applies the worktree diff of an isolated task to the main
 * repository, via `git apply --3way` — without ever committing or touching
 * branches (see `packages/core/src/engine/worktree.ts`). See the task 7
 * brief.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyRecordedWorktree } from "@caesar/core";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_APPLY = "caesar_apply";

export const caesarApplyDescription =
  "Apply the diff of a task run with worktree isolation to the main repository (git apply --3way; never " +
  "commits, never touches branches). Use this once you have reviewed the task's result — typically via " +
  "caesar_diff, especially after comparing several providers — and decided to keep it. Reports conflicts instead " +
  "of a partial apply when the patch no longer applies cleanly. A no-op (applied: true, no conflicts) for tasks " +
  "that ran inplace or made no changes.";

export const caesarApplyInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
};

const CaesarApplyInputSchema = z.object(caesarApplyInputShape);
export type CaesarApplyInput = z.infer<typeof CaesarApplyInputSchema>;

export async function caesarApply(session: McpSession, input: CaesarApplyInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  const result = await applyRecordedWorktree(session.root, session.store, record);
  if (result.outcome === "conflicts") {
    return jsonResult({ task_id: input.task_id, applied: false, conflicts: result.conflicts });
  }
  // "no_worktree" stays applied: true — the tool's existing contract for
  // inplace or no-change tasks, spelled out in its description.
  return jsonResult({ task_id: input.task_id, applied: true, conflicts: [] });
}

export function registerCaesarApply(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_APPLY, { description: caesarApplyDescription, inputSchema: caesarApplyInputShape }, (args) => caesarApply(session, args));
}
