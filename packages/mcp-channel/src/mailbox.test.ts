import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPendingQuestions, readAnswer, waitForAnswer, writeAnswer, writeQuestion } from "./mailbox.js";

describe("mailbox", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await mkdtemp(join(tmpdir(), "caesar-mailbox-"));
  });

  afterEach(async () => {
    await rm(taskDir, { recursive: true, force: true });
  });

  it("dépose une question, visible dans listPendingQuestions", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: ["oui", "non"], asked_at: new Date().toISOString() });

    const pending = await listPendingQuestions(taskDir);
    expect(pending).toEqual([expect.objectContaining({ id: "q1", question: "Continuer ?", options: ["oui", "non"] })]);
  });

  it("waitForAnswer rend la réponse dès qu'elle apparaît, sans attendre le délai complet", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const waitPromise = waitForAnswer(taskDir, "q1", 5_000, 20);
    // Écrit la réponse pendant que l'attente est en cours, comme le ferait
    // `caesar_answer` dans un processus séparé.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeAnswer(taskDir, { id: "q1", answer: "oui", answered_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitPromise;
    expect(answer?.answer).toBe("oui");
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    // Une fois répondue, elle disparaît des questions en attente.
    expect(await listPendingQuestions(taskDir)).toEqual([]);
  });

  it("waitForAnswer rend null à l'expiration du délai, sans jamais lever", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitForAnswer(taskDir, "q1", 100, 20);
    expect(answer).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("un délai déjà épuisé rend immédiatement, sans dormir", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitForAnswer(taskDir, "q1", 0, 20);
    expect(answer).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("répondre à une question inconnue le dit clairement plutôt que d'écrire en silence", async () => {
    const result = await writeAnswer(taskDir, { id: "q-fantome", answer: "oui", answered_at: new Date().toISOString() });
    expect(result).toEqual({ ok: false, reason: "unknown_question" });
    expect(await readAnswer(taskDir, "q-fantome")).toBeNull();
  });

  it("une réponse en double est refusée, la première n'est pas modifiée", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const first = await writeAnswer(taskDir, { id: "q1", answer: "oui", answered_at: new Date().toISOString() });
    expect(first).toEqual({ ok: true });

    const second = await writeAnswer(taskDir, { id: "q1", answer: "non", answered_at: new Date().toISOString() });
    expect(second).toEqual({ ok: false, reason: "already_answered" });

    expect((await readAnswer(taskDir, "q1"))?.answer).toBe("oui");
  });
});
