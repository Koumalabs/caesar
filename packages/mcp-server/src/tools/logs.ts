/**
 * `caesar_logs` : un extrait des événements normalisés d'une tâche, ou de la
 * sortie brute de son CLI — le détail que `caesar_status`/`caesar_await` gardent
 * volontairement hors de leurs réponses, pour rester compacts (voir le
 * brief de la tâche 7).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readEvents, taskPaths } from "@caesar/protocol";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_LOGS = "caesar_logs";

const DEFAULT_EVENT_LIMIT = 50;
/** Nombre de caractères conservés en fin de journal brut, en mode `raw`. */
const RAW_TAIL_CHARS = 20_000;

export const caesarLogsDescription =
  "Fetch an excerpt of a task's activity: normalized events (tool calls, file changes, progress, errors) by " +
  "default, or the sub-agent's raw CLI output with raw: true. Use this to diagnose a task that failed, timed " +
  "out, or produced a surprising report — caesar_status and caesar_await deliberately omit this level of detail to " +
  "stay compact. Only the most recent entries are returned (see limit / the raw output's fixed tail size); " +
  "total_events tells you how much was cut off.";

export const caesarLogsInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
  raw: z.boolean().optional().describe("Return the sub-agent's raw CLI output (stdout/stderr, interleaved) instead of normalized events."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum number of most-recent normalized events to return. Ignored when raw is true. Defaults to ${DEFAULT_EVENT_LIMIT}.`),
};

const CaesarLogsInputSchema = z.object(caesarLogsInputShape);
export type CaesarLogsInput = z.infer<typeof CaesarLogsInputSchema>;

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function caesarLogs(session: McpSession, input: CaesarLogsInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);
  const paths = taskPaths(record.task_dir);

  if (input.raw) {
    const text = await readTextSafe(paths.rawLog);
    const truncated = text.length > RAW_TAIL_CHARS;
    return jsonResult({ task_id: record.id, raw: true, truncated, text: truncated ? text.slice(-RAW_TAIL_CHARS) : text });
  }

  const events = await readEvents(paths);
  const limit = input.limit ?? DEFAULT_EVENT_LIMIT;
  return jsonResult({ task_id: record.id, raw: false, total_events: events.length, events: events.slice(-limit) });
}

export function registerCaesarLogs(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_LOGS, { description: caesarLogsDescription, inputSchema: caesarLogsInputShape }, (args) => caesarLogs(session, args));
}
