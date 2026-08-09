import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        const session = createSession(root);
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
      }),
    );
  }, 20_000);

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = createSession(root);
      const result = await orchStatus(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
    });
  });
});
