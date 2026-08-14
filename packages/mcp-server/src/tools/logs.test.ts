import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarDelegate } from "./delegate.js";
import { caesarLogs } from "./logs.js";

describe("caesar_logs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-logs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("known task: normalized events, then raw output with raw: true", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, { objective: "task", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const events = await caesarLogs(session, { task_id: taskId });
        const eventData = events.structuredContent as { raw: boolean; total_events: number; events: unknown[] };
        expect(eventData.raw).toBe(false);
        expect(eventData.total_events).toBeGreaterThan(0);
        expect(eventData.events.length).toBe(eventData.total_events);

        const raw = await caesarLogs(session, { task_id: taskId, raw: true });
        const rawData = raw.structuredContent as { raw: boolean; text: string; truncated: boolean };
        expect(rawData.raw).toBe(true);
        expect(rawData.truncated).toBe(false);
        // The fake agent logs "starting" then "processing" then "done" (see its doc).
        expect(rawData.text).toMatch(/starting/);
      }),
    );
  }, 20_000);

  it("limit caps the number of normalized events returned, keeping the most recent", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, { objective: "task", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const full = await caesarLogs(session, { task_id: taskId });
        const fullData = full.structuredContent as { total_events: number };

        const limited = await caesarLogs(session, { task_id: taskId, limit: 1 });
        const limitedData = limited.structuredContent as { total_events: number; events: unknown[] };
        expect(limitedData.total_events).toBe(fullData.total_events);
        expect(limitedData.events.length).toBe(1);
      }),
    );
  }, 20_000);

  it("unknown task: clear error", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarLogs(session, { task_id: "t_nonexistent" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/unknown task/i);
    });
  });
});
