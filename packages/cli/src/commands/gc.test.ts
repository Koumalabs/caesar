import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@orch/core";
import { createWorktree, fileTaskStore, markWorktreeInUse } from "@orch/core";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { EXIT_OK } from "../output.js";
import { runGc } from "./gc.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

describe("orch gc", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-cli-gc-"));
    io = makeIo();
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "orch-test@example.com"]);
    await git(root, ["config", "user.name", "Orch Test"]);
    await writeFile(join(root, "a.txt"), "hello\n", "utf8");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createTask(id: string, status: TaskRecord["status"]): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "tester orch gc",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", id),
      workspace: handle.path,
      isolation: "worktree",
      mode: "write",
      branch: handle.branch,
      report_via: "file",
      depth: 0,
    };
    await fileTaskStore(root).create(record);
    return record;
  }

  it("--dry-run --json décrit exactement les suppressions et conservations", async () => {
    await createTask("t_propre", "succeeded");
    const modified = await createTask("t_modifiee", "failed");
    await writeFile(join(modified.workspace, "travail.txt"), "à appliquer\n", "utf8");
    await createTask("t_active", "running");
    await createWorktree(root, "t_orpheline");

    const code = await runGc(root, { dryRun: true, json: true }, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stderrText()).toBe("");
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.dry_run).toBe(true);
    expect(parsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "t_propre", action: "would_remove", reason: "clean", orphan: false }),
        expect.objectContaining({
          id: "t_modifiee",
          action: "kept",
          reason: "modified",
          orphan: false,
          diff_command: "orch diff t_modifiee",
          apply_command: "orch apply t_modifiee",
        }),
        expect.objectContaining({ id: "t_active", action: "kept", reason: "active", orphan: false }),
        expect.objectContaining({ id: "t_orpheline", action: "would_remove", reason: "clean", orphan: true }),
      ]),
    );
  });

  it("la sortie humaine rappelle diff/apply pour un travail modifié conservé", async () => {
    const modified = await createTask("t_a_appliquer", "timed_out");
    await writeFile(join(modified.workspace, "travail.txt"), "à appliquer\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_a_appliquer");
    expect(io.stdoutText()).toContain("orch diff t_a_appliquer");
    expect(io.stdoutText()).toContain("orch apply t_a_appliquer");
  });

  /**
   * Le cas qui a fait remonter le défaut : `orch gc` disait « Aucun worktree à
   * nettoyer » pendant que `orch ps` affichait une tâche en cours depuis six
   * heures. La cause — une tâche que plus personne ne conduit — doit se lire
   * dans la sortie, même quand il n'y a par ailleurs rien à supprimer.
   */
  it("nomme la tâche conclue d'office, même sans aucun worktree à nettoyer", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_sans_worktree",
      agent: "codex",
      objective: "écrire en place",
      status: "running",
      created_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".orch", "tasks", "t_sans_worktree"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });
    const lease = await markWorktreeInUse(root, "t_sans_worktree");
    await writeFile(lease.path, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_sans_worktree");
    expect(io.stdoutText()).toContain("Aucun worktree à nettoyer.");
    expect((await store.get("t_sans_worktree"))?.status).toBe("failed");
  });

  it("un orphelin modifié indique son chemin sans conseiller diff/apply", async () => {
    const orphan = await createWorktree(root, "t_orpheline_modifiee");
    await writeFile(join(orphan.path, "travail.txt"), "sans enregistrement\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_orpheline_modifiee");
    expect(io.stdoutText()).toContain(orphan.path);
    expect(io.stdoutText()).not.toContain("orch diff");
    expect(io.stdoutText()).not.toContain("orch apply");
  });
});
