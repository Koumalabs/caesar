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

  it("drops off a question, visible in listPendingQuestions", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: ["yes", "no"], asked_at: new Date().toISOString() });

    const pending = await listPendingQuestions(taskDir);
    expect(pending).toEqual([expect.objectContaining({ id: "q1", question: "Continue?", options: ["yes", "no"] })]);
  });

  it("waitForAnswer returns the answer as soon as it appears, without waiting out the full timeout", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const waitPromise = waitForAnswer(taskDir, "q1", 5_000, 20);
    // Writes the answer while the wait is in progress, as `caesar_answer`
    // would from a separate process.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeAnswer(taskDir, { id: "q1", answer: "yes", answered_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitPromise;
    expect(answer?.answer).toBe("yes");
    expect(Date.now() - startedAt).toBeLessThan(4_000);

    // Once answered, it disappears from the pending questions.
    expect(await listPendingQuestions(taskDir)).toEqual([]);
  });

  it("waitForAnswer returns null when the timeout expires, without ever throwing", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitForAnswer(taskDir, "q1", 100, 20);
    expect(answer).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("an already-exhausted timeout returns immediately, without sleeping", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const startedAt = Date.now();
    const answer = await waitForAnswer(taskDir, "q1", 0, 20);
    expect(answer).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("answering an unknown question says so clearly rather than writing silently", async () => {
    const result = await writeAnswer(taskDir, { id: "q-ghost", answer: "yes", answered_at: new Date().toISOString() });
    expect(result).toEqual({ ok: false, reason: "unknown_question" });
    expect(await readAnswer(taskDir, "q-ghost")).toBeNull();
  });

  it("a duplicate answer is refused, the first one is left untouched", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const first = await writeAnswer(taskDir, { id: "q1", answer: "yes", answered_at: new Date().toISOString() });
    expect(first).toEqual({ ok: true });

    const second = await writeAnswer(taskDir, { id: "q1", answer: "no", answered_at: new Date().toISOString() });
    expect(second).toEqual({ ok: false, reason: "already_answered" });

    expect((await readAnswer(taskDir, "q1"))?.answer).toBe("yes");
  });
});
