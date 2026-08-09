import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchDelegate } from "./delegate.js";
import { orchLogs } from "./logs.js";

describe("orch_logs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-logs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tâche connue : événements normalisés, puis sortie brute avec raw: true", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const events = await orchLogs(session, { task_id: taskId });
        const eventData = events.structuredContent as { raw: boolean; total_events: number; events: unknown[] };
        expect(eventData.raw).toBe(false);
        expect(eventData.total_events).toBeGreaterThan(0);
        expect(eventData.events.length).toBe(eventData.total_events);

        const raw = await orchLogs(session, { task_id: taskId, raw: true });
        const rawData = raw.structuredContent as { raw: boolean; text: string; truncated: boolean };
        expect(rawData.raw).toBe(true);
        expect(rawData.truncated).toBe(false);
        // L'agent factice journalise "démarrage" puis "traitement" puis "terminé" (voir sa doc).
        expect(rawData.text).toMatch(/démarrage/);
      }),
    );
  }, 20_000);

  it("limit borne le nombre d'événements normalisés rendus, en gardant les plus récents", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const full = await orchLogs(session, { task_id: taskId });
        const fullData = full.structuredContent as { total_events: number };

        const limited = await orchLogs(session, { task_id: taskId, limit: 1 });
        const limitedData = limited.structuredContent as { total_events: number; events: unknown[] };
        expect(limitedData.total_events).toBe(fullData.total_events);
        expect(limitedData.events.length).toBe(1);
      }),
    );
  }, 20_000);

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = createSession(root);
      const result = await orchLogs(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inconnue/);
    });
  });
});
