/**
 * `caesar_answer`: answers a question a subagent asked mid-run via its
 * `ask_orchestrator` tool (return channel, `@caesar/mcp-channel`) — see the
 * task 9 brief. Writes `<taskDir>/answers/<question_id>.json` (the file
 * `ask_orchestrator` polls, via `writeAnswer` from `@caesar/mcp-channel` —
 * the same primitive on both ends of the channel, so the format and the
 * "unknown question"/"already answered" rules can never diverge) and emits
 * an `answer` event in `events.jsonl`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writeAnswer } from "@caesar/mcp-channel";
import { appendEvent, makeEvent, readEvents, taskPaths } from "@caesar/protocol";
import type { TaskPaths } from "@caesar/protocol";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const CAESAR_ANSWER = "caesar_answer";

export const caesarAnswerDescription =
  "Answer a question a delegated sub-agent asked mid-run via its ask_orchestrator tool (the MCP back-channel). " +
  "Discover pending questions first: caesar_status shows them for a single task, caesar_await surfaces them for " +
  "tasks it is still waiting on — this tool does not list them itself, it only answers a question_id you " +
  "already have. Answering an unknown task_id/question_id, or a question that already has an answer, fails " +
  "clearly instead of writing silently.";

export const caesarAnswerInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by caesar_delegate."),
  question_id: z.string().min(1).describe("The pending question's id, as surfaced by caesar_status/caesar_await."),
  answer: z.string().min(1).describe("The answer to hand back to the sub-agent."),
};

const CaesarAnswerInputSchema = z.object(caesarAnswerInputShape);
export type CaesarAnswerInput = z.infer<typeof CaesarAnswerInputSchema>;

/**
 * Next sequence number for an event — `seq` is only used for display
 * (`caesar logs`), never for sorting or deduplication (see
 * `packages/protocol/src/event.ts`). Same method, duplicated for lack of a
 * shared export point, on the `ask_orchestrator`/`report_progress` side
 * (`@caesar/mcp-channel`), which writes to this same log from the other end
 * of the channel.
 */
async function nextSeq(paths: TaskPaths): Promise<number> {
  const events = await readEvents(paths);
  return events.length;
}

export async function caesarAnswer(session: McpSession, input: CaesarAnswerInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Unknown task: "${input.task_id}".`);

  const result = await writeAnswer(record.task_dir, {
    id: input.question_id,
    answer: input.answer,
    answered_at: new Date().toISOString(),
  });

  if (!result.ok) {
    if (result.reason === "unknown_question") {
      return errorResult(`Unknown question: "${input.question_id}" for task "${input.task_id}".`);
    }
    return errorResult(`Question "${input.question_id}" (task "${input.task_id}") has already been answered.`);
  }

  const paths = taskPaths(record.task_dir);
  const seq = await nextSeq(paths);
  await appendEvent(paths, makeEvent(input.task_id, seq, "answer", { id: input.question_id, answer: input.answer }));

  return jsonResult({ task_id: input.task_id, question_id: input.question_id, answered: true });
}

export function registerCaesarAnswer(server: McpServer, session: McpSession): void {
  server.registerTool(CAESAR_ANSWER, { description: caesarAnswerDescription, inputSchema: caesarAnswerInputShape }, (args) =>
    caesarAnswer(session, args),
  );
}
