/**
 * `caesar_answer` : répond à une question qu'un sous-agent a posée en cours de
 * route via son tool `ask_orchestrator` (canal retour, `@caesar/mcp-channel`)
 * — voir le brief de la tâche 9. Écrit `<taskDir>/answers/<question_id>.json`
 * (le fichier que `ask_orchestrator` scrute, via `writeAnswer` de
 * `@caesar/mcp-channel` — même primitive des deux côtés du canal, pour ne
 * jamais faire diverger le format ni les règles "question inconnue"/"déjà
 * répondue") et émet un événement `answer` dans `events.jsonl`.
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
 * Prochain numéro d'ordre pour un événement — `seq` ne sert qu'à l'affichage
 * (`caesar logs`), jamais à trier ni à dédupliquer (voir
 * `packages/protocol/src/event.ts`). Même méthode, dupliquée faute d'un
 * point d'export commun, côté `ask_orchestrator`/`report_progress`
 * (`@caesar/mcp-channel`), qui écrit sur ce même journal depuis l'autre bout
 * du canal.
 */
async function nextSeq(paths: TaskPaths): Promise<number> {
  const events = await readEvents(paths);
  return events.length;
}

export async function caesarAnswer(session: McpSession, input: CaesarAnswerInput): Promise<CallToolResult> {
  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  const result = await writeAnswer(record.task_dir, {
    id: input.question_id,
    answer: input.answer,
    answered_at: new Date().toISOString(),
  });

  if (!result.ok) {
    if (result.reason === "unknown_question") {
      return errorResult(`Question inconnue : "${input.question_id}" pour la tâche "${input.task_id}".`);
    }
    return errorResult(`La question "${input.question_id}" (tâche "${input.task_id}") a déjà reçu une réponse.`);
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
