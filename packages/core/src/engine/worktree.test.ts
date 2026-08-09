import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskPaths, writeTask } from "@orch/protocol";
import type { Task } from "@orch/protocol";
import type { TaskRecord } from "../store.js";
import { applyWorktree, createWorktree, diffWorktree, loadWorktreeHandle, removeWorktree, repoRoot } from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "orch-test@example.com"]);
  await git(root, ["config", "user.name", "Orch Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

describe("worktree", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-worktree-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("repoRoot", () => {
    it("résout la racine d'un dépôt git", async () => {
      const resolved = await repoRoot(root);
      // macOS résout /tmp en /private/tmp : on compare les chemins réels.
      expect(resolved).toBe(await realpath(root));
    });

    it("renvoie null hors d'un dépôt git", async () => {
      const outside = await mkdtemp(join(tmpdir(), "orch-not-a-repo-"));
      try {
        expect(await repoRoot(outside)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("createWorktree / diffWorktree", () => {
    it("crée le worktree sous <root>/.orch/wt/<taskId> sur la branche orch/<taskId>", async () => {
      const handle = await createWorktree(root, "task-1");
      expect(handle.path).toBe(join(root, ".orch", "wt", "task-1"));
      expect(handle.branch).toBe("orch/task-1");
      expect(handle.baseRef).toBe("HEAD");

      const content = await readFile(join(handle.path, "a.txt"), "utf8");
      expect(content).toBe("hello\n");

      const branches = await git(root, ["branch", "--list", "orch/task-1"]);
      expect(branches).toContain("orch/task-1");
    });

    it("voit un fichier créé sans commit, grâce à --intent-to-add", async () => {
      const handle = await createWorktree(root, "task-2");
      await writeFile(join(handle.path, "nouveau.txt"), "contenu\n", "utf8");
      await writeFile(join(handle.path, "a.txt"), "hello\nmodifié\n", "utf8");

      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(false);
      expect(diff.files).toEqual(
        expect.arrayContaining([
          { path: "nouveau.txt", action: "created", summary: "" },
          { path: "a.txt", action: "modified", summary: "" },
        ]),
      );
      expect(diff.patch).toContain("nouveau.txt");
      expect(diff.patch).toContain("+contenu");
    });

    it("diff vide quand le worktree n'a subi aucun changement", async () => {
      const handle = await createWorktree(root, "task-3");
      const diff = await diffWorktree(handle);
      expect(diff.isEmpty).toBe(true);
      expect(diff.files).toEqual([]);
      expect(diff.patch).toBe("");
    });

    it("rapporte une suppression comme telle", async () => {
      const handle = await createWorktree(root, "task-4");
      await rm(join(handle.path, "a.txt"));
      const diff = await diffWorktree(handle);
      expect(diff.files).toEqual([{ path: "a.txt", action: "deleted", summary: "" }]);
    });
  });

  describe("applyWorktree", () => {
    it("applique proprement un patch sans conflit au dépôt principal", async () => {
      const handle = await createWorktree(root, "task-apply-ok");
      await writeFile(join(handle.path, "nouveau.txt"), "contenu\n", "utf8");

      const result = await applyWorktree(root, handle);
      expect(result).toEqual({ applied: true, conflicts: [] });
      expect(await readFile(join(root, "nouveau.txt"), "utf8")).toBe("contenu\n");

      // Réversible, sans effet de bord sur l'historique : rien n'est commité.
      const status = await git(root, ["status", "--porcelain"]);
      expect(status.trim()).not.toBe("");
      const log = await git(root, ["log", "--oneline"]);
      expect(log.trim().split("\n")).toHaveLength(1);
    });

    it("diff vide : n'échoue pas et ne change rien", async () => {
      const handle = await createWorktree(root, "task-apply-empty");
      const result = await applyWorktree(root, handle);
      expect(result).toEqual({ applied: true, conflicts: [] });
    });

    it("renvoie les fichiers en conflit plutôt que de lever", async () => {
      const handle = await createWorktree(root, "task-apply-conflict");
      await writeFile(join(handle.path, "a.txt"), "hello\nbranche agent\n", "utf8");

      // Le dépôt principal diverge sur la même ligne pendant que l'agent travaille.
      await writeFile(join(root, "a.txt"), "hello\nbranche principale\n", "utf8");
      await git(root, ["add", "a.txt"]);
      await git(root, ["commit", "-q", "-m", "diverge"]);

      const result = await applyWorktree(root, handle);
      expect(result.applied).toBe(false);
      expect(result.conflicts).toEqual(["a.txt"]);
    });
  });

  describe("removeWorktree", () => {
    it("supprime le worktree et sa branche", async () => {
      const handle = await createWorktree(root, "task-remove");
      await removeWorktree(root, handle);

      const worktrees = await git(root, ["worktree", "list"]);
      expect(worktrees).not.toContain("task-remove");

      const branches = await git(root, ["branch", "--list", "orch/task-remove"]);
      expect(branches.trim()).toBe("");
    });
  });

  describe("loadWorktreeHandle", () => {
    function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
      return {
        id: "task-handle",
        agent: "codex",
        objective: "tâche",
        status: "succeeded",
        created_at: new Date().toISOString(),
        task_dir: join(root, ".orch", "tasks", "task-handle"),
        workspace: join(root, ".orch", "wt", "task-handle"),
        isolation: "worktree",
        mode: "write",
        report_via: "file",
        depth: 0,
        branch: "orch/task-handle",
        ...overrides,
      };
    }

    it("null quand l'isolation n'est pas \"worktree\"", async () => {
      const handle = await loadWorktreeHandle(record({ isolation: "inplace", branch: undefined }));
      expect(handle).toBeNull();
    });

    it("null quand isolation \"worktree\" mais sans branche enregistrée", async () => {
      const handle = await loadWorktreeHandle(record({ branch: undefined }));
      expect(handle).toBeNull();
    });

    it("reconstruit le handle depuis task.json, base_ref compris", async () => {
      const rec = record();
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "orch.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        base_ref: "deadbeef",
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle).toEqual({ path: rec.workspace, branch: "orch/task-handle", baseRef: "deadbeef" });
    });

    it("base_ref absent de task.json : replie sur \"HEAD\"", async () => {
      const rec = record({ id: "task-handle-2", task_dir: join(root, ".orch", "tasks", "task-handle-2") });
      const paths = taskPaths(rec.task_dir);
      const task: Task = {
        protocol: "orch.task/v1",
        id: rec.id,
        created_at: rec.created_at,
        agent: rec.agent,
        objective: rec.objective,
        context: "",
        constraints: [],
        acceptance_criteria: [],
        mode: rec.mode,
        isolation: "worktree",
        workspace: rec.workspace,
        deadline_ms: 60_000,
        depth: 0,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      };
      await writeTask(paths, task);

      const handle = await loadWorktreeHandle(rec);
      expect(handle?.baseRef).toBe("HEAD");
    });
  });
});
