import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarDelegate } from "./delegate.js";
import { caesarDiff } from "./diff.js";

describe("caesar_diff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-diff-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the patch and changed files of a worktree-isolated task", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        await initGitRepo(root);
        const session = await createSession(root);

        const delegated = await caesarDelegate(session, {
          objective: "write a file",
          agent: "codex",
          mode: "write",
          isolation: "worktree",
          context: JSON.stringify({ files: [{ path: "new.txt", content: "content\n" }] }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await caesarDiff(session, { task_id: taskId });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as { is_empty: boolean; files: Array<{ path: string; action: string }>; patch: string };
        expect(data.is_empty).toBe(false);
        expect(data.files.map((f) => f.path)).toContain("new.txt");
        expect(data.patch).toMatch(/new\.txt/);
      }),
    );
  }, 20_000);

  it("inplace isolation: is_empty, no worktree to diff", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, { objective: "task", agent: "codex", mode: "write", isolation: "inplace" });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;
        const entry = session.tasks.get(taskId);
        await entry?.promise;

        const result = await caesarDiff(session, { task_id: taskId });
        const data = result.structuredContent as { is_empty: boolean; files: unknown[] };
        expect(data.is_empty).toBe(true);
        expect(data.files).toEqual([]);
      }),
    );
  }, 20_000);

  it("unknown task: clear error", async () => {
    await withFakeHome(async () => {
      const session = await createSession(root);
      const result = await caesarDiff(session, { task_id: "t_nonexistent" });
      expect(result.isError).toBe(true);
    });
  });
});
