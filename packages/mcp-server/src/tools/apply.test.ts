import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchApply } from "./apply.js";
import { orchDelegate } from "./delegate.js";

describe("orch_apply", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applique au dépôt principal le diff d'une tâche isolée en worktree", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const session = createSession(root);

        const delegated = await orchDelegate(session, {
          objective: "écrire un fichier",
          agent: "codex",
          mode: "write",
          isolation: "worktree",
          context: JSON.stringify({ files: [{ path: "nouveau.txt", content: "contenu\n" }] }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await orchApply(session, { task_id: taskId });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { applied: boolean; conflicts: string[] };
        expect(data.applied).toBe(true);
        expect(data.conflicts).toEqual([]);

        const content = await readFile(join(root, "nouveau.txt"), "utf8");
        expect(content).toBe("contenu\n");
      }),
    );
  }, 20_000);

  it("isolation inplace : rien à appliquer, applied: true", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await orchApply(session, { task_id: taskId });
        const data = result.structuredContent as { applied: boolean; conflicts: string[] };
        expect(data.applied).toBe(true);
        expect(data.conflicts).toEqual([]);
      }),
    );
  }, 20_000);

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = createSession(root);
      const result = await orchApply(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
    });
  });
});
