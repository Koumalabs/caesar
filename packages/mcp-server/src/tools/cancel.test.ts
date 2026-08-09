import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchCancel } from "./cancel.js";
import { orchDelegate } from "./delegate.js";

const execFileAsync = promisify(execFile);

describe("orch_cancel", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-cancel-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("interrompt une tâche en cours et met à jour son statut, sans laisser de processus fils", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async (shimDir) => {
        const session = createSession(root);
        const shimPath = join(shimDir, "codex");

        const delegated = await orchDelegate(session, {
          objective: "tâche longue",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        // Laisse la tâche réellement démarrer avant de l'annuler.
        let record = await session.store.get(taskId);
        for (let i = 0; i < 200 && record?.pid === undefined; i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
          record = await session.store.get(taskId);
        }
        expect(record?.pid).toBeDefined();

        const cancelled = await orchCancel(session, { task_id: taskId });
        expect(cancelled.isError).toBeFalsy();
        const data = cancelled.structuredContent as { cancelled: boolean; status: string };
        expect(data.cancelled).toBe(true);
        expect(data.status).toBe("cancelled");

        const finalRecord = await session.store.get(taskId);
        expect(finalRecord?.status).toBe("cancelled");

        try {
          const { stdout } = await execFileAsync("pgrep", ["-f", shimPath]);
          expect(stdout.trim()).toBe("");
        } catch (error) {
          expect((error as { code?: number }).code).toBe(1);
        }
      }),
    );
  }, 20_000);

  it("une tâche déjà terminée : cancelled: false, statut inchangé", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const cancelled = await orchCancel(session, { task_id: taskId });
        const data = cancelled.structuredContent as { cancelled: boolean; status: string };
        expect(data.cancelled).toBe(false);
        expect(data.status).toBe("succeeded");
      }),
    );
  }, 20_000);

  it("une tâche inconnue rend une erreur", async () => {
    await withFakeHome(async () => {
      const session = createSession(root);
      const result = await orchCancel(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
    });
  });
});
