import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAnswer, writeQuestion } from "@caesar/mcp-channel";
import { readEvents, taskPaths } from "@caesar/protocol";
import { createSession } from "../session.js";
import type { McpSession } from "../session.js";
import { caesarAnswer } from "./answer.js";

describe("caesar_answer", () => {
  let root: string;
  let taskDir: string;
  let session: McpSession;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-answer-"));
    taskDir = join(root, ".caesar", "tasks", "t_test");
    await mkdir(taskDir, { recursive: true });
    session = await createSession(root);
    await session.store.create({
      id: "t_test",
      agent: "codex",
      objective: "objective",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "channel",
      depth: 0,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the answer and emits an `answer` event", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const result = await caesarAnswer(session, { task_id: "t_test", question_id: "q1", answer: "yes" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ task_id: "t_test", question_id: "q1", answered: true });

    const stored = await readAnswer(taskDir, "q1");
    expect(stored?.answer).toBe("yes");

    const events = await readEvents(taskPaths(taskDir));
    expect(events).toEqual([expect.objectContaining({ type: "answer", id: "q1", answer: "yes" })]);
  });

  it("unknown question: clear error, nothing is written", async () => {
    const result = await caesarAnswer(session, { task_id: "t_test", question_id: "q-ghost", answer: "yes" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/unknown question/i);
    expect(await readAnswer(taskDir, "q-ghost")).toBeNull();
  });

  it("duplicate answer: clear error, the first answer is left untouched", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continue?", options: [], asked_at: new Date().toISOString() });

    const first = await caesarAnswer(session, { task_id: "t_test", question_id: "q1", answer: "yes" });
    expect(first.isError).toBeFalsy();

    const second = await caesarAnswer(session, { task_id: "t_test", question_id: "q1", answer: "no" });
    expect(second.isError).toBe(true);
    expect((second.content?.[0] as { text: string }).text).toMatch(/already/);

    expect((await readAnswer(taskDir, "q1"))?.answer).toBe("yes");
  });

  it("unknown task: clear error", async () => {
    const result = await caesarAnswer(session, { task_id: "t_nonexistent", question_id: "q1", answer: "yes" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/unknown task/i);
  });
});
