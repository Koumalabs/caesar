import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@caesar/core";
import { applyRecordedWorktree, createWorktree, fileTaskStore, markWorktreeInUse } from "@caesar/core";
import { TASK_PROTOCOL, TaskSchema, taskPaths, writeTask } from "@caesar/protocol";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { EXIT_OK } from "../output.js";
import { runGc } from "./gc.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

describe("caesar gc", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-gc-"));
    io = makeIo();
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "caesar-test@example.com"]);
    await git(root, ["config", "user.name", "Caesar Test"]);
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
      objective: "test caesar gc",
      status,
      created_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", id),
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

  /**
   * A finished task whose work was applied through the official path —
   * mirror of the helper in `packages/core/src/engine/gc.test.ts`: that is
   * where `applyRecordedWorktree` is exercised in detail, here we only
   * build the data needed to check what the CLI facade says about it.
   */
  async function appliedRecordedWorktree(id: string): Promise<TaskRecord> {
    const record = await createTask(id, "succeeded");
    await writeFile(join(record.workspace, `${id}.txt`), "work\n", "utf8");
    const paths = taskPaths(record.task_dir);
    const baseRef = (await git(record.workspace, ["rev-parse", "HEAD"])).trim();
    await writeTask(
      paths,
      TaskSchema.parse({
        protocol: TASK_PROTOCOL,
        id,
        created_at: record.created_at,
        agent: record.agent,
        objective: record.objective,
        mode: "write",
        isolation: "worktree",
        workspace: record.workspace,
        base_ref: baseRef,
        deadline_ms: 60_000,
        report_path: paths.reportPath,
        events_path: paths.eventsPath,
      }),
    );
    const applied = await applyRecordedWorktree(root, fileTaskStore(root), record);
    expect(applied.outcome).toBe("applied");
    return (await fileTaskStore(root).get(id))!;
  }

  it("--dry-run --json describes exactly the removals and keeps", async () => {
    await createTask("t_clean", "succeeded");
    const modified = await createTask("t_modified", "failed");
    await writeFile(join(modified.workspace, "work.txt"), "to apply\n", "utf8");
    await createTask("t_active", "running");
    await createWorktree(root, "t_orphan");

    const code = await runGc(root, { dryRun: true, json: true }, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stderrText()).toBe("");
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.dry_run).toBe(true);
    expect(parsed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "t_clean", action: "would_remove", reason: "clean", orphan: false }),
        expect.objectContaining({
          id: "t_modified",
          action: "kept",
          reason: "modified",
          orphan: false,
          diff_command: "caesar diff t_modified",
          apply_command: "caesar apply t_modified",
        }),
        expect.objectContaining({ id: "t_active", action: "kept", reason: "active", orphan: false }),
        expect.objectContaining({ id: "t_orphan", action: "would_remove", reason: "clean", orphan: true }),
      ]),
    );
  });

  it("the human output recalls diff/apply for kept modified work", async () => {
    const modified = await createTask("t_to_apply", "timed_out");
    await writeFile(join(modified.workspace, "work.txt"), "to apply\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_to_apply");
    expect(io.stdoutText()).toContain("caesar diff t_to_apply");
    expect(io.stdoutText()).toContain("caesar apply t_to_apply");
  });

  /**
   * The case that surfaced the defect: `caesar gc` said "No worktree to
   * clean up." while `caesar ps` showed a task in progress for six hours.
   * The cause — a task nobody is driving anymore — must be readable in the
   * output, even when there is otherwise nothing to remove.
   */
  it("names the task concluded by decree, even without any worktree to clean up", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_no_worktree",
      agent: "codex",
      objective: "write in place",
      status: "running",
      created_at: "2026-08-11T10:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", "t_no_worktree"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });
    const lease = await markWorktreeInUse(root, "t_no_worktree");
    await writeFile(lease.path, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_no_worktree");
    expect(io.stdoutText()).toContain("No worktree to clean up.");
    expect((await store.get("t_no_worktree"))?.status).toBe("failed");
  });

  it("a modified orphan shows its path without advising diff/apply", async () => {
    const orphan = await createWorktree(root, "t_orphan_modified");
    await writeFile(join(orphan.path, "work.txt"), "without a record\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("t_orphan_modified");
    expect(io.stdoutText()).toContain(orphan.path);
    expect(io.stdoutText()).not.toContain("caesar diff");
    expect(io.stdoutText()).not.toContain("caesar apply");
  });

  it("labels \"applied\" a worktree collected after an apply", async () => {
    await appliedRecordedWorktree("t_applied_cli");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("removed");
    // A short substring rather than the full label: the "reason" column of
    // `printTable` trims to the terminal width (80 by default outside a
    // tty), and this label exceeds the budget the other columns of this row
    // leave it — same motive as the neighboring test "recalls diff/apply",
    // which for the same reason never asserts a full sentence.
    expect(io.stdoutText()).toContain("applied to the workspace");
  });

  it("labels \"modified since it was applied\" a worktree retouched after apply, with the matching advice", async () => {
    const record = await appliedRecordedWorktree("t_retouched_cli");
    await writeFile(join(record.workspace, "t_retouched_cli.txt"), "retouch\n", "utf8");

    const code = await runGc(root, {}, io);

    expect(code).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("modified since it was applied");
    // Same here: `wrapText` cuts this sentence at 80 columns (the advice
    // exceeds one line's width) — the tested substring stays inside a
    // single line of the wrapping.
    expect(io.stdoutText()).toContain("what changed since the apply");
  });
});
