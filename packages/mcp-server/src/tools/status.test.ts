import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeQuestion } from "@orch/mcp-channel";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchDelegate } from "./delegate.js";
import { orchStatus } from "./status.js";

describe("orch_status", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-status-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tâche connue : statut, métadonnées, et dernier événement", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await orchStatus(session, { task_id: taskId });
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

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await orchStatus(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
    });
  });

  it("une question en attente est visible dans pending_questions — c'est ce qui rend le canal utile", async () => {
    const taskDir = join(root, ".orch", "tasks", "t_q");
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
    await writeQuestion(taskDir, { id: "q1", question: "Quelle branche ?", options: ["main", "dev"], asked_at: new Date().toISOString() });

    const result = await orchStatus(session, { task_id: "t_q" });
    const data = result.structuredContent as { pending_questions: Array<{ id: string; question: string; options: string[] }> };
    expect(data.pending_questions).toEqual([expect.objectContaining({ id: "q1", question: "Quelle branche ?", options: ["main", "dev"] })]);
  });
});
