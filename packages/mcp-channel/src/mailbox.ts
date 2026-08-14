/**
 * Questions et réponses du canal retour, sur le système de fichiers.
 *
 * Le sous-agent (via `caesar-channel`, ce paquet) et l'agent principal (via
 * `caesar_answer`, `@caesar/mcp-server`) tournent dans deux processus qui ne
 * partagent aucune mémoire : ils se coordonnent en lisant et en écrivant les
 * mêmes fichiers sous le répertoire de la tâche, exactement comme le reste du
 * standard (`task.json`, `report.json`, `events.jsonl`) — voir le brief de la
 * tâche 9.
 *
 * `<taskDir>/questions/<id>.json` : déposée par `ask_orchestrator`.
 * `<taskDir>/answers/<id>.json`   : déposée par `caesar_answer`.
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

/** Dépose une question en attente. Écrase silencieusement une question du même id : `ask_orchestrator` en génère un nouveau à chaque appel, ce cas ne survient donc pas en pratique. */
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
 * Écrit la réponse à une question — jamais si la question est inconnue ou a
 * déjà reçu une réponse : voir le brief de la tâche 9 ("répondre à une
 * question inconnue ou déjà répondue doit le dire clairement plutôt que
 * d'écrire en silence"). C'est `caesar_answer` (côté orchestrateur) qui
 * transforme ce résultat discriminé en message pour l'agent principal.
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
 * Questions déposées mais encore sans réponse, les plus anciennes d'abord.
 * C'est ce qui permet à `caesar_status`/`caesar_await` de faire apparaître ce
 * qu'un sous-agent attend, sans que l'agent principal ait à deviner qu'on lui
 * demande quelque chose (voir le brief : « c'est la moitié qu'on oublie »).
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
 * Attend l'apparition d'une réponse, par scrutation à `pollIntervalMs`. Rend
 * `null` si `timeoutMs` s'écoule avant qu'une réponse apparaisse — jamais une
 * erreur : c'est `ask_orchestrator` qui décide comment le formuler à l'agent
 * (voir son brief : « pas une erreur, une instruction exploitable »).
 *
 * Vérifie une première fois avant toute attente, de sorte qu'un `timeoutMs`
 * déjà nul ou négatif (budget de tâche épuisé) rend immédiatement sans jamais
 * dormir.
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
