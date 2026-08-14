import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK_PROTOCOL, TaskSchema, readEvents, taskEnv, taskPaths, writeTask } from "@caesar/protocol";
import type { CaesarEvent, Task, TaskPaths } from "@caesar/protocol";
import { isRecord, parseJsonLine } from "../adapters/json-line.js";
import type { AgentDefinition, SpawnPlan, Translation } from "../registry/types.js";
import { runAgentProcess } from "./spawn.js";

const execFileAsync = promisify(execFile);
const FAKE_AGENT = fileURLToPath(new URL("../../test/fixtures/fake-agent.mjs", import.meta.url));

/**
 * Minimal translation recognizing the `{"kind":"progress","message":"…"}`
 * lines printed by the fake agent — the output format specific to this test,
 * unrelated to the format of a real CLI.
 */
const stubAgent: AgentDefinition = {
  id: "fake",
  displayName: "Fake",
  bin: process.execPath,
  capabilities: {
    jsonEvents: true,
    outputSchema: false,
    finalMessageFile: false,
    nativeReadOnly: false,
    resume: false,
    addDir: false,
    mcpInjection: "none",
    model: false,
  },
  preferredReportChannel: () => "file",
  build: () => {
    throw new Error("unused: the plan is built directly by the tests");
  },
  translate(line: string): Translation {
    const data = parseJsonLine(line);
    if (!isRecord(data) || data["kind"] !== "progress") return { events: [] };
    const message = String(data["message"]);
    return { events: [{ type: "progress", message }], finalText: message };
  },
};

async function setupTask(dir: string, context: Record<string, unknown> = {}): Promise<{ task: Task; paths: TaskPaths }> {
  const workspace = join(dir, "workspace");
  await mkdir(workspace, { recursive: true });
  const paths = taskPaths(join(dir, "task"));
  const task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_spawn_test",
    created_at: new Date().toISOString(),
    agent: "fake",
    objective: "test of the execution engine",
    context: JSON.stringify(context),
    mode: "write",
    isolation: "inplace",
    workspace,
    deadline_ms: 600_000,
    report_path: paths.reportPath,
    events_path: paths.eventsPath,
  });
  await writeTask(paths, task);
  return { task, paths };
}

function planFor(task: Task, paths: TaskPaths): SpawnPlan {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: task.workspace,
    env: taskEnv(task, paths),
    files: [],
  };
}

/**
 * Queries `pgrep` to know whether a fake-agent process lingers.
 * `pgrep` exits with an error (code 1) when nothing matches: that is the
 * expected result, translated here into an empty string. Any other error
 * propagates as-is rather than being swallowed by the caller.
 */
async function pgrepFakeAgent(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", FAKE_AGENT]);
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}

/**
 * Confirms that no fake-agent process lingers after `runAgentProcess`
 * resolves.
 *
 * Diagnosed as flaky under load (task 10, A1): `close` on the
 * child does mean Node deemed it terminated, but under heavy contention
 * (several dozen real processes launched in parallel by the suite),
 * `pgrep`, run right after, can for a moment still see the process
 * entry in the system table before it is purged — an OS-side
 * propagation delay, not an engine leak. A handful of quick
 * retries absorbs that delay without ever masking a real
 * leak, which would, for its part, survive every retry.
 */
async function expectNoOrphan(): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    const remaining = await pgrepFakeAgent();
    if (remaining === "") return;
    if (Date.now() >= deadline) {
      expect(remaining).toBe("");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("runAgentProcess", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "caesar-spawn-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("captures the events of a known stream, with started/finished and an increasing counter", async () => {
    const { task, paths } = await setupTask(dir, {});
    const seen: CaesarEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onEvent: (event) => seen.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);

    const types = seen.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("finished");
    expect(types.filter((t) => t === "progress")).toHaveLength(3);
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(result.eventCount).toBe(seen.length);

    // The last non-empty finalText wins: "done" is the last message emitted.
    expect(result.finalText).toBe("done");

    const persisted = await readEvents(paths);
    expect(persisted).toHaveLength(seen.length);
    await expectNoOrphan();
  });

  it("writes stdout and stderr into raw.log", async () => {
    const { task, paths } = await setupTask(dir, {});
    await runAgentProcess({ agent: stubAgent, plan: planFor(task, paths), paths, taskId: task.id, timeoutMs: 10_000 });

    const raw = await readFile(paths.rawLog, "utf8");
    expect(raw).toContain("starting");
    expect(raw).toContain("processing");
    expect(raw).toContain("done");
  });

  it("relays a non-zero exit code", async () => {
    const { task, paths } = await setupTask(dir, { mode: "fail", exitCode: 7 });
    const events: CaesarEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onEvent: (e) => events.push(e),
    });

    expect(result.exitCode).toBe(7);
    const finished = events.find((e) => e.type === "finished");
    expect(finished).toMatchObject({ type: "finished", status: "failed", exit_code: 7 });
    await expectNoOrphan();
  });

  it("the timeout triggers SIGTERM and process termination", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang" });
    const events: CaesarEvent[] = [];
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 200,
      onEvent: (e) => events.push(e),
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    await expectNoOrphan();
  });

  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang", ignoreSigterm: true });
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    await expectNoOrphan();
  }, 8000);

  it("writes plan.stdin then closes the input", async () => {
    const { task, paths } = await setupTask(dir, {});
    const plan: SpawnPlan = {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(0));"],
      cwd: task.workspace,
      env: {},
      files: [],
      stdin: "hello from stdin\n",
    };

    const result = await runAgentProcess({ agent: stubAgent, plan, paths, taskId: task.id, timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);

    const raw = await readFile(paths.rawLog, "utf8");
    expect(raw).toContain("hello from stdin");
  });

  it("onSpawn receives the sub-process pid before any processing of its output", async () => {
    const { task, paths } = await setupTask(dir, {});
    let spawnedPid: number | undefined;
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onSpawn: (pid) => {
        spawnedPid = pid;
      },
    });

    expect(spawnedPid).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it("an onSpawn that throws (or rejects) does not interrupt the task: it runs to completion, without an orphan", async () => {
    const { task, paths } = await setupTask(dir, {});
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onSpawn: () => {
        // Simulates a broken pid-recording callback — same risk profile as
        // the onEvent of the following test, applied to onSpawn (task 10, A2).
        throw new Error("broken pid-recording callback");
      },
    });

    expect(result.exitCode).toBe(0);
    await expectNoOrphan();
  });

  it("an onSpawn whose promise rejects does not interrupt the task: it runs to completion, without an orphan", async () => {
    const { task, paths } = await setupTask(dir, {});
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onSpawn: async () => {
        throw new Error("pid-recording promise rejected");
      },
    });

    expect(result.exitCode).toBe(0);
    await expectNoOrphan();
  });

  it("an onEvent that throws does not interrupt the task: it runs to completion, without an orphan", async () => {
    const { task, paths } = await setupTask(dir, {});
    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      onEvent: () => {
        // Simulates a broken display callback — from the very first event
        // ("started"), before the timeout timer and the abort listener
        // are even in place.
        throw new Error("broken display callback");
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
    await expectNoOrphan();
  });

  it("an AbortSignal already triggered before the call launches no process", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang" });
    const controller = new AbortController();
    controller.abort();

    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.eventCount).toBe(0);
    // Nothing was launched: no log file was even created.
    await expect(readFile(paths.rawLog, "utf8")).rejects.toThrow();
    await expectNoOrphan();
  });

  it("an AbortSignal cancels the execution before the timeout", async () => {
    const { task, paths } = await setupTask(dir, { mode: "hang" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await runAgentProcess({
      agent: stubAgent,
      plan: planFor(task, paths),
      paths,
      taskId: task.id,
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    await expectNoOrphan();
  });
});
