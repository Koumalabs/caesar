import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarApply } from "./apply.js";
import { caesarDelegate } from "./delegate.js";

describe("caesar_apply", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applique au dépôt principal le diff d'une tâche isolée en worktree", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const session = await createSession(root);

        const delegated = await caesarDelegate(session, {
          objective: "écrire un fichier",
          agent: "codex",
          mode: "write",
          isolation: "worktree",
          context: JSON.stringify({ files: [{ path: "nouveau.txt", content: "contenu\n" }] }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await caesarApply(session, { task_id: taskId });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { applied: boolean; conflicts: string[] };
        expect(data.applied).toBe(true);
        expect(data.conflicts).toEqual([]);

        const content = await readFile(join(root, "nouveau.txt"), "utf8");
        expect(content).toBe("contenu\n");

        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeDefined();
        expect(record?.applied_patch_digest).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  }, 20_000);

  it("isolation inplace : rien à appliquer, applied: true", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await caesarApply(session, { task_id: taskId });
        const data = result.structuredContent as { applied: boolean; conflicts: string[] };
        expect(data.applied).toBe(true);
        expect(data.conflicts).toEqual([]);

        const record = await session.store.get(taskId);
        expect(record?.applied_at).toBeUndefined();
      }),
    );
  }, 20_000);

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarApply(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
    });
  });
});
