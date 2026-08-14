import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveLayer } from "@caesar/core";
import { readTask, taskPaths } from "@caesar/protocol";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarDelegate } from "./delegate.js";

describe("caesar_delegate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-delegate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns a task_id immediately, without waiting for the task to finish", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const startedAt = Date.now();

        const result = await caesarDelegate(session, {
          objective: "long task",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ mode: "hang", sleepMs: 5_000 }),
        });

        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs).toBeLessThan(2_000);
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { task_id: string; agent: string; status: string };
        expect(data.task_id).toMatch(/^t_/);
        expect(data.agent).toBe("codex");
        expect(data.status).toBe("running");

        // `caesar_delegate` responds before `runTask` has even reached its
        // first internal wait point (isolation preparation): the store may
        // therefore not know the task yet at that precise moment. We wait
        // until it does (the task is supposed to run for 5 s), which proves
        // it really was launched without `caesar_delegate` having to wait
        // for it to finish.
        let record = await session.store.get(data.task_id);
        for (let i = 0; i < 200 && !record; i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
          record = await session.store.get(data.task_id);
        }
        expect(record?.status).toBe("running");

        // Cleanup: cancel so no child process is left behind by the test.
        const entry = session.tasks.get(data.task_id);
        entry?.controller.abort();
        await entry?.promise;
      }),
    );
  }, 20_000);

  it("channel: true enables the return channel for the delegated task (task 9) — without it, task.channel would stay empty", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const result = await caesarDelegate(session, {
          objective: "task with channel",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          channel: true,
        });
        expect(result.isError).toBeFalsy();
        const taskId = (result.structuredContent as { task_id: string }).task_id;

        const entry = session.tasks.get(taskId);
        const outcome = await entry?.promise;
        expect(outcome?.record.report_via).toBe("channel");

        const record = await session.store.get(taskId);
        const task = await readTask(taskPaths(record!.task_dir));
        expect(task.channel).toEqual(expect.objectContaining({ transport: "mcp-stdio", server_name: "caesar" }));
      }),
    );
  }, 20_000);

  it("an agent refused by policy returns an error carrying the exact reason from @caesar/core", async () => {
    await withFakeHome(async () => {
      const { config } = await loadConfig(root);
      await saveLayer("project", root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "task", agent: "codex" });

      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toBe(
        'Agent "codex" refused: present in the policy\'s "denied" list.',
      );
    });
  });

  it("an unknown role is handled cleanly, without launching anything", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "task", role: "nonexistent" });

      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/nonexistent/);
      expect(session.tasks.size).toBe(0);
    });
  });

  it("neither agent nor role: usage error", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "task" });
      expect(result.isError).toBe(true);
    });
  });

  it("an agent unknown to the catalog is handled cleanly", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "task", agent: "ghost-agent" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/unknown/i);
    });
  });
});
