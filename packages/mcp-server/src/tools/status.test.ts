import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeQuestion } from "@caesar/mcp-channel";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarDelegate } from "./delegate.js";
import { caesarStatus } from "./status.js";

describe("caesar_status", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-status-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("known task: status, metadata, and last event", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, { objective: "task", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await caesarStatus(session, { task_id: taskId });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { task_id: string; status: string; agent: string; last_event: { type: string } | null };
        expect(data.task_id).toBe(taskId);
        expect(data.status).toBe("succeeded");
        expect(data.agent).toBe("codex");
        expect(data.last_event).not.toBeNull();
        expect(data.last_event?.type).toBe("finished");
        expect((data as unknown as { pending_questions: unknown[] }).pending_questions).toEqual([]);
      }),
    );
  }, 20_000);

  it("unknown task: clear error", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarStatus(session, { task_id: "t_nonexistent" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/unknown task/i);
    });
  });

  it("a pending question is visible in pending_questions — that is what makes the channel useful", async () => {
    const taskDir = join(root, ".caesar", "tasks", "t_q");
    await mkdir(taskDir, { recursive: true });
    const session = await createSession(root);
    await session.store.create({
      id: "t_q",
      agent: "codex",
      objective: "obj",
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
    await writeQuestion(taskDir, { id: "q1", question: "Which branch?", options: ["main", "dev"], asked_at: new Date().toISOString() });

    const result = await caesarStatus(session, { task_id: "t_q" });
    const data = result.structuredContent as { pending_questions: Array<{ id: string; question: string; options: string[] }> };
    expect(data.pending_questions).toEqual([expect.objectContaining({ id: "q1", question: "Which branch?", options: ["main", "dev"] })]);
  });
});
