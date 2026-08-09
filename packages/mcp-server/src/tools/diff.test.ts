import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { orchDelegate } from "./delegate.js";
import { orchDiff } from "./diff.js";

describe("orch_diff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-mcp-diff-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rend le patch et les fichiers modifiés d'une tâche isolée en worktree", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const session = await createSession(root);

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

        const result = await orchDiff(session, { task_id: taskId });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { is_empty: boolean; files: Array<{ path: string; action: string }>; patch: string };
        expect(data.is_empty).toBe(false);
        expect(data.files.map((f) => f.path)).toContain("nouveau.txt");
        expect(data.patch).toMatch(/nouveau\.txt/);
      }),
    );
  }, 20_000);

  it("isolation inplace : is_empty, sans worktree à diffuser", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await orchDelegate(session, { objective: "tâche", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await orchDiff(session, { task_id: taskId });
        const data = result.structuredContent as { is_empty: boolean; files: unknown[] };
        expect(data.is_empty).toBe(true);
        expect(data.files).toEqual([]);
      }),
    );
  }, 20_000);

  it("tâche inconnue : erreur claire", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await orchDiff(session, { task_id: "t_inexistant" });
      expect(result.isError).toBe(true);
    });
  });
});
