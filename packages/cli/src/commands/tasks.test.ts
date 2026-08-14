import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEvent, taskPaths } from "@caesar/protocol";
import type { TaskRecord } from "@caesar/core";
import { clearWorktreeInUse, fileTaskStore, markWorktreeInUse, runTask } from "@caesar/core";
import { makeIo, withFakeAgentAsBin, withFakeHome, type CapturedIo } from "../../test/support.js";
import { runApply, runCancel, runDiff, runLogs, runPs } from "./tasks.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../output.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "caesar-test@example.com"]);
  await git(root, ["config", "user.name", "Caesar Test"]);
  await writeFile(join(root, "a.txt"), "hello\n", "utf8");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "init"]);
}

describe("caesar ps", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-ps-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t_1",
      agent: "codex",
      objective: "objective",
      status: "pending",
      created_at: "2026-08-09T10:00:00.000Z",
      task_dir: join(root, ".caesar", "tasks", "t_1"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      ...overrides,
    };
  }

  it("by default: active tasks + latest finished, usable --json", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_running", status: "running", created_at: "2026-08-09T10:00:00.000Z" }));
    await store.create(record({ id: "t_done", status: "succeeded", created_at: "2026-08-09T09:00:00.000Z" }));

    const code = await runPs(root, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    const ids = parsed.tasks.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual(["t_done", "t_running"]);
  });

  it("--status filters, an unknown status is a usage error", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_ok", status: "succeeded" }));
    await store.create(record({ id: "t_ko", status: "failed" }));

    const code = await runPs(root, { status: "succeeded", json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.tasks.map((t: { id: string }) => t.id)).toEqual(["t_ok"]);

    const io2 = makeIo();
    const badCode = await runPs(root, { status: "whatever" }, io2);
    expect(badCode).toBe(EXIT_USAGE);
  });

  it("empty store: empty list, no error", async () => {
    const code = await runPs(root, { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText()).tasks).toEqual([]);
  });

  /**
   * The original symptom: a task whose orchestrator was killed stays
   * "running" forever, at the top of `ps`, hours after nothing drives it
   * anymore. `ps` is the first place where that lie is visible — hence the
   * first where it gets repaired.
   */
  it("a task whose orchestrator disappeared is no longer shown in progress", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_abandoned", status: "running" }));
    // The marker `markWorktreeInUse` leaves behind a killed process.
    const lease = await markWorktreeInUse(root, "t_abandoned");
    await writeFile(lease.path, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");

    const code = await runPs(root, { json: true }, io);

    expect(code).toBe(EXIT_OK);
    const [task] = JSON.parse(io.stdoutText()).tasks as TaskRecord[];
    expect(task.status).toBe("failed");
    expect(task.ended_at).toBeDefined();
    expect((await store.get("t_abandoned"))?.status).toBe("failed");
  });

  it("a task really in progress is not concluded by a mere ps", async () => {
    const store = fileTaskStore(root);
    await store.create(record({ id: "t_in_progress", status: "running" }));
    const lease = await markWorktreeInUse(root, "t_in_progress");

    const code = await runPs(root, { json: true }, io);

    expect(code).toBe(EXIT_OK);
    expect((JSON.parse(io.stdoutText()).tasks as TaskRecord[])[0]?.status).toBe("running");

    await clearWorktreeInUse(lease);
  });
});

describe("caesar logs / cancel / diff / apply — on a store populated by real tasks", () => {
  let root: string;
  let io: CapturedIo;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-cli-tasks-"));
    io = makeIo();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("logs: unknown task handled cleanly (usage code, clear message)", async () => {
    const code = await runLogs(root, "t_ghost", {}, io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderrText()).toMatch(/[Uu]nknown/);
  });

  it("logs: normalized events of a real task (inplace), human and --json", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "log task", mode: "write", isolation: "inplace", workspace: root },
      );

      const code = await runLogs(root, outcome.record.id, {}, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("started");
      expect(io.stdoutText()).toContain("finished");

      const io2 = makeIo();
      const jsonCode = await runLogs(root, outcome.record.id, { json: true }, io2);
      expect(jsonCode).toBe(EXIT_OK);
      const parsed = JSON.parse(io2.stdoutText());
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.events[0].type).toBe("started");
      expect(io2.stdoutText()).not.toMatch(/\x1b\[/);
    });
  }, 20_000);

  it("logs --raw: the agent CLI's raw output", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "raw log task", mode: "write", isolation: "inplace", workspace: root },
      );

      const code = await runLogs(root, outcome.record.id, { raw: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(io.stdoutText()).toContain("starting");
      expect(io.stdoutText()).toContain("done");
    });
  }, 20_000);

  it("logs --follow: follows a live task until it ends", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const runPromise = runTask(
        { store, root },
        { agentId: "codex", objective: "task followed live", mode: "write", isolation: "inplace", workspace: root },
      );

      const [outcome] = await Promise.all([runPromise, runLogs(root, await firstTaskId(store), { follow: true }, io)]);
      expect(outcome.record.status).toBe("succeeded");
      expect(io.stdoutText()).toContain("started");
      expect(io.stdoutText()).toContain("finished");
    });

    async function firstTaskId(store: ReturnType<typeof fileTaskStore>): Promise<string> {
      for (let i = 0; i < 100; i++) {
        const [record] = await store.list({ status: ["running"] });
        if (record) return record.id;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("no running task found in time");
    }
  }, 20_000);

  it("logs --follow: a malformed or off-schema line is flagged on stderr, without stopping the follow nor polluting stdout", async () => {
    const id = "t_bad_line";
    const taskDir = join(root, ".caesar", "tasks", id);
    const paths = taskPaths(taskDir);
    await mkdir(dirname(paths.eventsPath), { recursive: true });

    const started = makeEvent(id, 0, "started", { agent: "codex", command: "codex run" });
    const finished = makeEvent(id, 1, "finished", { status: "success", summary: "", exit_code: 0 });
    const lines = [
      JSON.stringify(started),
      "{this is not JSON",
      JSON.stringify({ type: "unknown" }),
      JSON.stringify(finished),
    ];
    await writeFile(paths.eventsPath, lines.join("\n") + "\n", "utf8");

    const store = fileTaskStore(root);
    await store.create({
      id,
      agent: "codex",
      objective: "events with a malformed line",
      status: "succeeded",
      created_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });

    const code = await runLogs(root, id, { follow: true }, io);
    expect(code).toBe(EXIT_OK);

    // The two valid events reach stdout, in order.
    expect(io.stdoutText()).toContain("started");
    expect(io.stdoutText()).toContain("finished");

    // The two invalid lines are flagged on stderr, each for its own reason.
    expect(io.stderrText()).toMatch(/invalid JSON/);
    expect(io.stderrText()).toMatch(/schema/);

    // stdout stays usable NDJSON/text: never a diagnostic on it.
    expect(io.stdoutText()).not.toMatch(/dropped/);
  });

  it("cancel: unknown task handled cleanly", async () => {
    const code = await runCancel(root, "t_ghost", {}, io);
    expect(code).toBe(EXIT_USAGE);
  });

  it("cancel: task already finished — clear message, not an error", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_done",
      agent: "codex",
      objective: "already finished",
      status: "succeeded",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".caesar", "tasks", "t_done"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });

    const code = await runCancel(root, "t_done", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.cancelled).toBe(false);
  });

  it("cancel: running task without a recorded pid — clear message, not an error", async () => {
    const store = fileTaskStore(root);
    await store.create({
      id: "t_no_pid",
      agent: "codex",
      objective: "without a pid",
      status: "running",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".caesar", "tasks", "t_no_pid"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
    });

    const code = await runCancel(root, "t_no_pid", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(io.stdoutText()).cancelled).toBe(false);
  });

  it("cancel: recorded pid but process already dead — clear message (ESRCH)", async () => {
    // A process we actually let finish: its pid is guaranteed free.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.once("exit", resolve));

    const store = fileTaskStore(root);
    await store.create({
      id: "t_dead_pid",
      agent: "codex",
      objective: "dead pid",
      status: "running",
      created_at: new Date().toISOString(),
      task_dir: join(root, ".caesar", "tasks", "t_dead_pid"),
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "file",
      depth: 0,
      pid: deadPid,
    });

    const code = await runCancel(root, "t_dead_pid", { json: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.cancelled).toBe(true);
    expect((await store.get("t_dead_pid"))!.status).toBe("cancelled");
  });

  it("cancel: sends SIGTERM to a task really in progress, which terminates promptly", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const runPromise = runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "lingering task",
          mode: "write",
          isolation: "inplace",
          workspace: root,
          timeoutMs: 30_000,
          context: JSON.stringify({ mode: "hang", sleepMs: 30_000 }),
        },
      );

      let id: string | undefined;
      for (let i = 0; i < 100 && !id; i++) {
        const [record] = await store.list({ status: ["running"] });
        if (record?.pid !== undefined) id = record.id;
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(id).toBeDefined();

      const code = await runCancel(root, id!, { json: true }, io);
      expect(code).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).cancelled).toBe(true);

      // Proof that the SIGTERM really reached the subprocess: the task
      // finishes well before `sleepMs`'s 30 s.
      await runPromise;
    });
  }, 20_000);

  it("diff / apply: \"inplace\" isolation, nothing to diff nor to apply", async () => {
    await withFakeAgentAsBin("codex", async () => {
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        { agentId: "codex", objective: "without a worktree", mode: "write", isolation: "inplace", workspace: root },
      );

      const diffCode = await runDiff(root, outcome.record.id, { json: true }, io);
      expect(diffCode).toBe(EXIT_OK);
      expect(JSON.parse(io.stdoutText()).is_empty).toBe(true);

      const io2 = makeIo();
      const applyCode = await runApply(root, outcome.record.id, { json: true }, io2);
      expect(applyCode).toBe(EXIT_OK);
      expect(JSON.parse(io2.stdoutText()).applied).toBe(false);
    });
  }, 20_000);

  it("diff / apply: conflict-free worktree — the diff ends up applied to the main repository", async () => {
    await withFakeAgentAsBin("codex", async () => {
      await initGitRepo(root);
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "write a file in a worktree",
          mode: "write",
          isolation: "worktree",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "new.txt", content: "content\n" }] }),
        },
      );
      expect(outcome.record.isolation).toBe("worktree");

      const diffCode = await runDiff(root, outcome.record.id, { json: true }, io);
      expect(diffCode).toBe(EXIT_OK);
      const diffParsed = JSON.parse(io.stdoutText());
      expect(diffParsed.is_empty).toBe(false);
      expect(diffParsed.files.map((f: { path: string }) => f.path)).toContain("new.txt");

      const io2 = makeIo();
      const applyCode = await runApply(root, outcome.record.id, { json: true }, io2);
      expect(applyCode).toBe(EXIT_OK);
      expect(JSON.parse(io2.stdoutText()).applied).toBe(true);
      expect(await readFile(join(root, "new.txt"), "utf8")).toBe("content\n");

      const record = await fileTaskStore(root).get(outcome.record.id);
      expect(record?.applied_at).toBeDefined();
      expect(record?.applied_patch_digest).toMatch(/^[0-9a-f]{64}$/);
    });
  }, 20_000);

  it("apply: reports the conflicts without masking them (code 1)", async () => {
    await withFakeAgentAsBin("codex", async () => {
      await initGitRepo(root);
      const store = fileTaskStore(root);
      const outcome = await runTask(
        { store, root },
        {
          agentId: "codex",
          objective: "modify a.txt in a worktree",
          mode: "write",
          isolation: "worktree",
          workspace: root,
          context: JSON.stringify({ files: [{ path: "a.txt", content: "hello\nagent branch\n" }] }),
        },
      );

      // The main repository diverges on the same line while the agent works.
      await writeFile(join(root, "a.txt"), "hello\nmain branch\n", "utf8");
      await git(root, ["add", "a.txt"]);
      await git(root, ["commit", "-q", "-m", "diverge"]);

      const code = await runApply(root, outcome.record.id, { json: true }, io);
      expect(code).toBe(EXIT_RUNTIME);
      const parsed = JSON.parse(io.stdoutText());
      expect(parsed.applied).toBe(false);
      expect(parsed.conflicts).toEqual(["a.txt"]);
    });
  }, 20_000);

  it("diff / apply: unknown task handled cleanly", async () => {
    expect(await runDiff(root, "t_ghost", {}, io)).toBe(EXIT_USAGE);
    const io2 = makeIo();
    expect(await runApply(root, "t_ghost", {}, io2)).toBe(EXIT_USAGE);
  });
});
