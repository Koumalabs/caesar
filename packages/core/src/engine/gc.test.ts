import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskRecord, TaskStatus } from "../store.js";
import { fileTaskStore } from "../store.js";
import { createWorktree } from "./worktree.js";
import { clearWorktreeInUse, garbageCollectWorktrees, markWorktreeInUse } from "./gc.js";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("garbageCollectWorktrees", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-gc-repo-"));
    await initRepo(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createRecordedWorktree(id: string, status: TaskStatus): Promise<TaskRecord> {
    const handle = await createWorktree(root, id);
    const record: TaskRecord = {
      id,
      agent: "codex",
      objective: "tester le ramasse-miettes",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      ended_at: status === "pending" || status === "running" ? undefined : "2026-08-11T10:01:00.000Z",
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

  it("--dry-run annonce un worktree terminé propre sans supprimer le worktree ni la branche", async () => {
    const record = await createRecordedWorktree("t_propre", "succeeded");

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: record.id,
        action: "would_remove",
        reason: "clean",
        orphan: false,
        status: "succeeded",
      }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("supprime le worktree terminé propre et sa branche", async () => {
    const record = await createRecordedWorktree("t_supprimee", "failed");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "clean", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
    expect((await git(root, ["worktree", "list"]))).not.toContain(record.id);
    expect((await git(root, ["branch", "--list", record.branch!])).trim()).toBe("");
  });

  it("conserve un worktree terminé modifié, puis le supprime avec --force", async () => {
    const record = await createRecordedWorktree("t_modifiee", "cancelled");
    await writeFile(join(record.workspace, "travail.txt"), "important\n", "utf8");
    const statusBefore = await git(record.workspace, ["status", "--porcelain"]);

    const kept = await garbageCollectWorktrees(root);

    expect(kept.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(record.workspace, ["status", "--porcelain"])).toBe(statusBefore);

    const removed = await garbageCollectWorktrees(root, { force: true });
    expect(removed.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "removed", reason: "modified", orphan: false }),
    ]);
    expect(await pathExists(record.workspace)).toBe(false);
  });

  it.each(["pending", "running"] as const)("ne supprime jamais une tâche %s, même avec --force", async (status) => {
    const record = await createRecordedWorktree(`t_${status}`, status);
    await writeFile(join(record.workspace, "en-cours.txt"), "écriture\n", "utf8");

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id: record.id, action: "kept", reason: "active", status }),
    ]);
    expect(await pathExists(record.workspace)).toBe(true);
    expect(await git(root, ["branch", "--list", record.branch!])).toContain(record.branch!);
  });

  it("détecte et supprime un worktree orphelin absent du store", async () => {
    const handle = await createWorktree(root, "t_orpheline");

    const result = await garbageCollectWorktrees(root);

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "t_orpheline",
        action: "removed",
        reason: "clean",
        orphan: true,
        status: undefined,
      }),
    ]);
    expect(await pathExists(handle.path)).toBe(false);
    expect((await git(root, ["branch", "--list", handle.branch])).trim()).toBe("");
  });

  it("protège un worktree en cours de création avant son apparition dans le store", async () => {
    const lease = await markWorktreeInUse(root, "t_demarrage");
    const handle = await createWorktree(root, "t_demarrage");

    const protectedResult = await garbageCollectWorktrees(root, { force: true });

    expect(protectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_demarrage", action: "kept", reason: "active", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);

    await clearWorktreeInUse(lease);
    const collectedResult = await garbageCollectWorktrees(root);
    expect(collectedResult.entries).toEqual([
      expect.objectContaining({ id: "t_demarrage", action: "removed", reason: "clean", orphan: true }),
    ]);
  });

  it("--dry-run ne purge pas un marqueur laissé par un processus mort", async () => {
    const id = "t_marqueur_perime";
    const lease = await markWorktreeInUse(root, id);
    const marker = lease.path;
    await writeFile(marker, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { dryRun: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "would_remove", reason: "clean", orphan: true }),
    ]);
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(handle.path)).toBe(true);
  });

  it("conserve un orphelin dont le marqueur est illisible, même avec --force", async () => {
    const id = "t_marqueur_invalide";
    const lease = await markWorktreeInUse(root, id);
    await writeFile(lease.path, "{json incomplet", "utf8");
    const handle = await createWorktree(root, id);

    const result = await garbageCollectWorktrees(root, { force: true });

    expect(result.entries).toEqual([
      expect.objectContaining({ id, action: "kept", reason: "inspection_failed", orphan: true }),
    ]);
    expect(await pathExists(handle.path)).toBe(true);
  });
});
