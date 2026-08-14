import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markWorktreeInUse } from "@caesar/core";
import { writeQuestion } from "@caesar/mcp-channel";
import { withFakeAgentAsBin, withFakeHome } from "../../test/support.js";
import { createSession } from "../session.js";
import { caesarAwait } from "./await.js";
import { caesarDelegate } from "./delegate.js";

describe("caesar_await", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-await-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("full caesar_delegate then caesar_await cycle, through to the report", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, {
          objective: "write a file",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ summary: "done." }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await caesarAwait(session, { task_ids: [taskId] });
        expect(awaited.isError).toBeFalsy();
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { status: string; summary: string } }> }).tasks;
        expect(tasks[taskId]?.status).toBe("succeeded");
        expect(tasks[taskId]?.pending).toBe(false);
        expect(tasks[taskId]?.report?.status).toBe("success");
        expect(tasks[taskId]?.report?.summary).toBe("done.");
      }),
    );
  }, 20_000);

  it("two parallel delegations really run at the same time, not one after the other", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);

        // `sleepMs`, since the fix for finding 1 of the task 7 review, also
        // delays the fake agent's "success" mode (not only "hang") — see
        // `fake-agent.mjs`. Without it, both tasks would finish almost
        // instantly regardless of execution order, and no measurement below
        // would tell a parallel run apart from a sequential one.
        const delayMs = 1_000;
        const startedAt = Date.now();
        const [first, second] = await Promise.all([
          caesarDelegate(session, {
            objective: "first",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "first done.", sleepMs: delayMs }),
          }),
          caesarDelegate(session, {
            objective: "second",
            agent: "codex",
            mode: "write",
            isolation: "inplace",
            context: JSON.stringify({ summary: "second done.", sleepMs: delayMs }),
          }),
        ]);
        const firstId = (first.structuredContent as { task_id: string }).task_id;
        const secondId = (second.structuredContent as { task_id: string }).task_id;
        expect(firstId).not.toBe(secondId);

        // Proof #1, by observed state rather than by timing — hence
        // insensitive to machine load (see the task 7 review): while both
        // tasks sleep, there must exist a moment where the store shows them
        // **simultaneously** "running". A sequential run (the second only
        // starting once the first has finished) never produces that moment:
        // there, the first would move to "succeeded" before the second even
        // exists in the store in the "running" state — the loop below would
        // then exhaust its iterations without ever seeing both "running" at
        // the same instant, and the assertion that follows would fail.
        let observedBothRunning = false;
        for (let i = 0; i < 400 && !observedBothRunning; i++) {
          const [r1, r2] = await Promise.all([session.store.get(firstId), session.store.get(secondId)]);
          if (r1?.status === "running" && r2?.status === "running") {
            observedBothRunning = true;
          } else {
            await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
          }
        }
        expect(observedBothRunning).toBe(true);

        // Proof #2, timed, complementing proof #1 (which remains the only
        // one whose margin does not depend on machine load): awaiting both
        // tasks together costs only the longer of the two delays, not their
        // sum. With delayMs = 1000 ms each, a sequential run would take at
        // least ~2000 ms (plus the startup cost of both processes); the
        // threshold below rules that out squarely while leaving a wide
        // margin for the real parallel case (measured between ~1000 and
        // ~1500 ms depending on machine load when calibrating this test).
        const awaited = await caesarAwait(session, { task_ids: [firstId, secondId], timeout_ms: 10_000 });
        const elapsedMs = Date.now() - startedAt;

        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; report?: { summary: string } }> }).tasks;
        expect(tasks[firstId]?.status).toBe("succeeded");
        expect(tasks[secondId]?.status).toBe("succeeded");
        expect(tasks[firstId]?.report?.summary).toBe("first done.");
        expect(tasks[secondId]?.report?.summary).toBe("second done.");
        expect(elapsedMs).toBeLessThan(1_800);
      }),
    );
  }, 20_000);

  it("an exceeded timeout returns the partial state rather than waiting indefinitely", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, {
          objective: "long task",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
          context: JSON.stringify({ mode: "hang", sleepMs: 5_000 }),
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const startedAt = Date.now();
        const awaited = await caesarAwait(session, { task_ids: [taskId], timeout_ms: 200 });
        const elapsedMs = Date.now() - startedAt;

        expect(elapsedMs).toBeLessThan(2_000);
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: unknown }> }).tasks;
        expect(tasks[taskId]?.pending).toBe(true);
        expect(tasks[taskId]?.report).toBeUndefined();
        expect(["pending", "running"]).toContain(tasks[taskId]?.status);

        // Cleanup.
        const entry = session.tasks.get(taskId);
        entry?.controller.abort();
        await entry?.promise;
      }),
    );
  }, 20_000);

  it("a completely unknown task_id is reported as such, without failing the rest of the batch", async () => {
    await withFakeHome(() =>
      withFakeAgentAsBin("codex", async () => {
        const session = await createSession(root);
        const delegated = await caesarDelegate(session, {
          objective: "task",
          agent: "codex",
          mode: "write",
          isolation: "inplace",
        });
        const taskId = (delegated.structuredContent as { task_id: string }).task_id;

        const awaited = await caesarAwait(session, { task_ids: [taskId, "t_nonexistent"] });
        const tasks = (awaited.structuredContent as { tasks: Record<string, { status: string }> }).tasks;
        expect(tasks["t_nonexistent"]?.status).toBe("unknown");
        expect(tasks[taskId]?.status).toBe("succeeded");
      }),
    );
  }, 20_000);

  it("a task blocked on a question says it is waiting, and on what — not just \"running\"", async () => {
    const taskDir = join(root, ".caesar", "tasks", "t_q");
    await mkdir(taskDir, { recursive: true });
    const session = await createSession(root);
    await session.store.create({
      id: "t_q",
      agent: "codex",
      objective: "obj",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "channel",
      depth: 0,
    });
    await writeQuestion(taskDir, { id: "q1", question: "Which branch?", options: [], asked_at: new Date().toISOString() });

    // `t_q` was never started by this session (no entry in
    // `session.tasks`): `caesarAwait` falls back on the store/filesystem,
    // exactly as for a task started by another process (`caesar run`, a
    // previous MCP server…) — see `describeFromStore`.
    const awaited = await caesarAwait(session, { task_ids: ["t_q"] });
    const tasks = (
      awaited.structuredContent as {
        tasks: Record<string, { pending: boolean; pending_questions: Array<{ id: string; question: string }> }>;
      }
    ).tasks;
    expect(tasks["t_q"]?.pending).toBe(true);
    expect(tasks["t_q"]?.pending_questions).toEqual([expect.objectContaining({ id: "q1", question: "Which branch?" })]);
  });

  /**
   * A task left behind by an MCP server that has since been closed: its
   * record says "running" forever, for lack of a live process to conclude
   * it. Returning it as `pending: true` would amount to advising to wait
   * indefinitely for something nobody is doing anymore.
   */
  it("a task whose orchestrator disappeared is concluded, not returned as pending", async () => {
    const taskDir = join(root, ".caesar", "tasks", "t_abandoned");
    await mkdir(taskDir, { recursive: true });
    const session = await createSession(root);
    await session.store.create({
      id: "t_abandoned",
      agent: "codex",
      objective: "obj",
      status: "running",
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      task_dir: taskDir,
      workspace: root,
      isolation: "inplace",
      mode: "write",
      report_via: "channel",
      depth: 0,
    });
    // The marker a killed orchestrator leaves behind.
    const lease = await markWorktreeInUse(root, "t_abandoned");
    await writeFile(lease.path, JSON.stringify({ pid: 2_147_483_647, token: lease.token }) + "\n", "utf8");

    const awaited = await caesarAwait(session, { task_ids: ["t_abandoned"] });

    const tasks = (
      awaited.structuredContent as { tasks: Record<string, { status: string; pending: boolean; report?: { status: string; summary: string } }> }
    ).tasks;
    expect(tasks["t_abandoned"]?.pending).toBe(false);
    expect(tasks["t_abandoned"]?.status).toBe("failed");
    expect(tasks["t_abandoned"]?.report?.summary).toContain("disappeared");
  });
});
