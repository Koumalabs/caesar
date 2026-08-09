import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchAwait } from "./await.js";
import { orchDelegate } from "./delegate.js";

describe("orch_await", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-await-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cycle complet orch_delegate puis orch_await, jusqu'au rapport", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "écrire un fichier",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ summary: "fait." }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await orchAwait(session, { task_ids: [taskId] });
        expect(awaited.isError).toBeFalsy();
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { status: string; summary: string } }> }).tasks;
        expect(tasks[taskId]?.status).toBe("succeeded");
        expect(tasks[taskId]?.pending).toBe(false);
        expect(tasks[taskId]?.report?.status).toBe("success");
        expect(tasks[taskId]?.report?.summary).toBe("fait.");
      }),
    );
  }, 20_000);

  it("deux délégations en parallèle, attendues ensemble par un seul orch_await", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);

        const delayMs = 500;
        const [first, second] = await Promise.all([
          orchDelegate(session, {
            objective: "première",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "première faite.", sleepMs: delayMs }),
          }),
          orchDelegate(session, {
            objective: "seconde",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "seconde faite.", sleepMs: delayMs }),
          }),
        ]);
        const firstId = (first.structuredContent as { task_id: string }).task_id;
        const secondId = (second.structuredContent as { task_id: string }).task_id;
        expect(firstId).not.toBe(secondId);

        const startedAt = Date.now();
        const awaited = await orchAwait(session, { task_ids: [firstId, secondId], timeout_ms: 10_000 });
        const elapsedMs = Date.now() - startedAt;

        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; report?: { summary: string } }> }).tasks;
        expect(tasks[firstId]?.status).toBe("succeeded");
        expect(tasks[secondId]?.status).toBe("succeeded");
        expect(tasks[firstId]?.report?.summary).toBe("première faite.");
        expect(tasks[secondId]?.report?.summary).toBe("seconde faite.");

        // Les deux tâches tournent en parallèle : l'attente conjointe ne coûte
        // pas la somme des deux délais, seulement le plus long des deux.
        expect(elapsedMs).toBeLessThan(delayMs * 2);
      }),
    );
  }, 20_000);

  it("un délai dépassé rend l'état partiel plutôt que d'attendre indéfiniment", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "tâche longue",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ mode: "hang", sleepMs: 5_000 }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const startedAt = Date.now();
        const awaited = await orchAwait(session, { task_ids: [taskId], timeout_ms: 200 });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(2_000);
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: unknown }> }).tasks;
        expect(tasks[taskId]?.pending).toBe(true);
        expect(tasks[taskId]?.report).toBeUndefined();
        expect(["pending", "running"]).toContain(tasks[taskId]?.status);

        // Nettoyage.
        const entry = session.tasks.get(taskId);
        entry?.controller.abort();
        await entry?.promise;
      }),
    );
  }, 20_000);

  it("un task_id totalement inconnu est signalé comme tel, sans faire échouer le reste du lot", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, {
          objective: "tâche",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await orchAwait(session, { task_ids: [taskId, "t_inexistant"] });
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string }> }).tasks;
        expect(tasks["t_inexistant"]?.status).toBe("unknown");
        expect(tasks[taskId]?.status).toBe("succeeded");
      }),
    );
  }, 20_000);
});
