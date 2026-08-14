/**
 * `caesar_diff`: the git diff of an isolated task's worktree — see the
 * task 7 brief. This is the full detail (patch included) that
 * `caesar_status`/`caesar_await` keep out of their compact responses:
 * exactly what is needed to compare the diffs of several providers launched
 * on the same objective before applying only one (`caesar_apply`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { diffWorktree, loadWorktreeHandle } from "@caesar/core";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_DIFF = "caesar_diff";

export const caesarDiffDescription =
  "Show the git diff of a task run with worktree isolation: which files changed, how, and the full unified " +
  "patch. Use this after caesar_await reports a task done, to inspect what it actually did before deciding " +
  "whether to caesar_apply it — especially when you delegated the same objective to several providers in " +
  "parallel and want to compare their diffs before picking one. Returns is_empty: true with no patch for tasks " +
  "that ran inplace (no worktree) or made no changes.";

export const caesarDiffInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
};

const CaesarDiffInputSchema = z.object(caesarDiffInputShape);
export type CaesarDiffInput = z.infer<typeof CaesarDiffInputSchema>;

export async function caesarDiff(session: McpSession, input: CaesarDiffInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  const handle = await loadWorktreeHandle(record);
  if (!handle) {
    return jsonResult({ task_id: input.task_id, is_empty: true, files: [], patch: "" });
  }

  const diff = await diffWorktree(handle);
  return jsonResult({ task_id: input.task_id, is_empty: diff.isEmpty, files: diff.files, patch: diff.patch });
}

export function registerCaesarDiff(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_DIFF, { description: caesarDiffDescription, inputSchema: caesarDiffInputShape }, (args) => caesarDiff(session, args));
}
