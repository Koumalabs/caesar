/**
 * Return-channel questions and answers, on the filesystem.
 *
 * The subagent (via `caesar-channel`, this package) and the main agent (via
 * `caesar_answer`, `@caesar/mcp-server`) run in two processes that share no
 * memory: they coordinate by reading and writing the same files under the
 * task directory, exactly like the rest of the standard (`task.json`,
 * `report.json`, `events.jsonl`) — see the task 9 brief.
 *
 * `<taskDir>/questions/<id>.json`: dropped off by `ask_orchestrator`.
 * `<taskDir>/answers/<id>.json`  : dropped off by `caesar_answer`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PendingQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
  asked_at: z.iso.datetime(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const MailboxAnswerSchema = z.object({
  id: z.string().min(1),
  answer: z.string().min(1),
  answered_at: z.iso.datetime(),
});
export type MailboxAnswer = z.infer<typeof MailboxAnswerSchema>;

function questionsDir(taskDir: string): string {
  return join(taskDir, "questions");
}

function answersDir(taskDir: string): string {
  return join(taskDir, "answers");
}

function questionPath(taskDir: string, id: string): string {
  return join(questionsDir(taskDir), `${id}.json`);
}

function answerPath(taskDir: string, id: string): string {
  return join(answersDir(taskDir), `${id}.json`);
}

async function readJsonSafe<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Drops off a pending question. Silently overwrites a question with the same id: `ask_orchestrator` generates a fresh one on every call, so this case does not arise in practice. */
export async function writeQuestion(taskDir: string, question: PendingQuestion): Promise<void> {
  await mkdir(questionsDir(taskDir), { recursive: true });
  await writeFile(questionPath(taskDir, question.id), JSON.stringify(question, null, 2) + "\n", "utf8");
}

export async function readQuestion(taskDir: string, id: string): Promise<PendingQuestion | null> {
  return readJsonSafe(questionPath(taskDir, id), PendingQuestionSchema);
}

export async function readAnswer(taskDir: string, id: string): Promise<MailboxAnswer | null> {
  return readJsonSafe(answerPath(taskDir, id), MailboxAnswerSchema);
}

export type WriteAnswerResult = { ok: true } | { ok: false; reason: "unknown_question" | "already_answered" };

/**
 * Writes the answer to a question — never if the question is unknown or has
 * already received an answer: see the task 9 brief ("answering an unknown or
 * already-answered question must say so clearly rather than writing
 * silently"). It is `caesar_answer` (orchestrator side) that turns this
 * discriminated result into a message for the main agent.
 */
export async function writeAnswer(taskDir: string, answer: MailboxAnswer): Promise<WriteAnswerResult> {
  const question = await readQuestion(taskDir, answer.id);
  if (!question) return { ok: false, reason: "unknown_question" };
  if (await readAnswer(taskDir, answer.id)) return { ok: false, reason: "already_answered" };

  await mkdir(answersDir(taskDir), { recursive: true });
  await writeFile(answerPath(taskDir, answer.id), JSON.stringify(answer, null, 2) + "\n", "utf8");
  return { ok: true };
}

/**
 * Questions dropped off but still unanswered, oldest first. This is what lets
 * `caesar_status`/`caesar_await` surface what a subagent is waiting on,
 * without the main agent having to guess that something is being asked of it
 * (see the brief: "that is the half everyone forgets").
 */
export async function listPendingQuestions(taskDir: string): Promise<PendingQuestion[]> {
  let entries: string[];
  try {
    entries = await readdir(questionsDir(taskDir));
  } catch {
    return [];
  }
  const ids = entries.filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -".json".length));
  const questions = await Promise.all(ids.map((id) => readQuestion(taskDir, id)));

  const pending: PendingQuestion[] = [];
  for (const question of questions) {
    if (question && !(await readAnswer(taskDir, question.id))) pending.push(question);
  }
  return pending.sort((a, b) => a.asked_at.localeCompare(b.asked_at));
}

/**
 * Waits for an answer to appear, polling at `pollIntervalMs`. Returns `null`
 * if `timeoutMs` elapses before an answer appears — never an error: it is
 * `ask_orchestrator` that decides how to phrase it for the agent (see its
 * brief: "not an error, an actionable instruction").
 *
 * Checks once before any waiting, so that a `timeoutMs` that is already zero
 * or negative (task budget exhausted) returns immediately without ever
 * sleeping.
 */
export async function waitForAnswer(taskDir: string, id: string, timeoutMs: number, pollIntervalMs: number): Promise<MailboxAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await readAnswer(taskDir, id);
    if (answer) return answer;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
