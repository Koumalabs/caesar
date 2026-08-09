import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAnswer, writeQuestion } from "@orch/mcp-channel";
import { readEvents, taskPaths } from "@orch/protocol";
import { createSession } from "../session.js";
import type { McpSession } from "../session.js";
import { orchAnswer } from "./answer.js";

describe("orch_answer", () => {
  let root: string;
  let taskDir: string;
  let session: McpSession;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-answer-"));
    taskDir = join(root, ".orch", "tasks", "t_test");
    await mkdir(taskDir, { recursive: true });
    session = createSession(root);
    await session.store.create({
      id: "t_test",
      agent: "codex",
      objective: "objectif",
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

  it("écrit la réponse et émet un événement `answer`", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const result = await orchAnswer(session, { task_id: "t_test", question_id: "q1", answer: "oui" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ task_id: "t_test", question_id: "q1", answered: true });

    const stored = await readAnswer(taskDir, "q1");
    expect(stored?.answer).toBe("oui");

    const events = await readEvents(taskPaths(taskDir));
    expect(events).toEqual([expect.objectContaining({ type: "answer", id: "q1", answer: "oui" })]);
  });

  it("question inconnue : erreur claire, rien n'est écrit", async () => {
    const result = await orchAnswer(session, { task_id: "t_test", question_id: "q-fantome", answer: "oui" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
    expect(await readAnswer(taskDir, "q-fantome")).toBeNull();
  });

  it("réponse en double : erreur claire, la première réponse n'est pas modifiée", async () => {
    await writeQuestion(taskDir, { id: "q1", question: "Continuer ?", options: [], asked_at: new Date().toISOString() });

    const first = await orchAnswer(session, { task_id: "t_test", question_id: "q1", answer: "oui" });
    expect(first.isError).toBeFalsy();

    const second = await orchAnswer(session, { task_id: "t_test", question_id: "q1", answer: "non" });
    expect(second.isError).toBe(true);
    expect((second.content?.[0] as { text: string }).text).toMatch(/déjà/);

    expect((await readAnswer(taskDir, "q1"))?.answer).toBe("oui");
  });

  it("tâche inconnue : erreur claire", async () => {
    const result = await orchAnswer(session, { task_id: "t_inexistant", question_id: "q1", answer: "oui" });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
  });
});
