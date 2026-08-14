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

  it("rend un task_id immédiatement, sans attendre la fin de la tâche", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const startedAt = Date.now();

        const result = await caesarDelegate(session, {
          objective: "tâche longue",
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

        // `caesar_delegate` répond avant même que `runTask` n'ait atteint son
        // premier point d'attente interne (préparation de l'isolation) : le
        // store peut donc ne pas encore connaître la tâche à cet instant précis.
        // On attend qu'il la connaisse (elle est censée tourner pendant 5 s),
        // ce qui prouve qu'elle a bien été lancée sans que `caesar_delegate` ait eu
        // à en attendre la fin.
        let record = await session.store.get(data.task_id);
        for (let i = 0; i < 200 && !record; i++) {
          await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
          record = await session.store.get(data.task_id);
        }
        expect(record?.status).toBe("running");

        // Nettoyage : on annule pour ne laisser aucun processus fils derrière le test.
        const entry = session.tasks.get(data.task_id);
        entry?.controller.abort();
        await entry?.promise;
      }),
    );
  }, 20_000);

  it("channel: true active le canal retour pour la tâche déléguée (tâche 9) — sans lui, task.channel resterait vide", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const result = await caesarDelegate(session, {
          objective: "tâche avec canal",
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

  it("un agent refusé par la politique rend une erreur portant le motif exact de @caesar/core", async () => {
    await withFakeHome(async () => {
      const { config } = await loadConfig(root);
      await saveLayer("project", root, { ...config, policy: { ...config.policy, denied: ["codex"] } });

      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "tâche", agent: "codex" });

      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toBe(
        'Agent "codex" refusé : présent dans la liste "denied" de la politique.',
      );
    });
  });

  it("un rôle inconnu est traité proprement, sans lancer quoi que ce soit", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "tâche", role: "inexistant" });

      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inexistant/);
      expect(session.tasks.size).toBe(0);
    });
  });

  it("ni agent ni role : erreur d'usage", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "tâche" });
      expect(result.isError).toBe(true);
    });
  });

  it("un agent inconnu du catalogue est traité proprement", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDelegate(session, { objective: "tâche", agent: "agent-fantome" });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toMatch(/inconnu/);
    });
  });
});
