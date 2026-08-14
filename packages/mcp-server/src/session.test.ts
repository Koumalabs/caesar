/**
 * `launchTask` carries the central guarantee of the task 7 watch point: a
 * task launched without being awaited (`caesar_delegate`) must never
 * produce an unhandled promise rejection, however `runTask` fails —
 * including when the store itself, meant to collect the fallback trace, is
 * unavailable.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, launchTask } from "./session.js";

describe("launchTask", () => {
  let root: string;
  let unhandled: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "caesar-mcp-session-"));
    unhandled = [];
    onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    // If this test let an unhandled rejection through, that is precisely
    // the scenario this file exists to prevent.
    expect(unhandled).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("a failure before the store write (\"worktree\" isolation outside a git repository) returns a synthesized TaskOutcome, never a rejection", async () => {
    const session = await createSession(root);
    const controller = new AbortController();

    const entry = launchTask(
      session,
      {
        agentId: "codex",
        objective: "task",
        mode: "write",
        isolation: "worktree", // `root` is not a git repository: `prepareIsolation` throws before `store.create`.
        workspace: root,
        taskId: "t_session_test_1",
      },
      controller,
    );

    const outcome = await entry.promise;
    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("failed");
    expect(outcome.report.status).toBe("failed");
    expect(outcome.report.summary).toMatch(/interrupted/);

    const stored = await session.store.get("t_session_test_1");
    expect(stored?.status).toBe("failed");

    // Gives any unhandled rejection a chance to surface before the test
    // ends.
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));
  });

  it("a failure even when the store is unavailable falls back to a purely in-memory TaskOutcome, never a rejection", async () => {
    // Blocks the store write: a file occupies the spot where the store
    // would want to create its directory (`.caesar/state/tasks/`).
    await mkdir(join(root, ".caesar", "state"), { recursive: true });
    await writeFile(join(root, ".caesar", "state", "tasks"), "occupied", "utf8");

    const session = await createSession(root);
    const controller = new AbortController();

    const entry = launchTask(
      session,
      {
        agentId: "codex",
        objective: "task",
        mode: "write",
        isolation: "worktree",
        workspace: root,
        taskId: "t_session_test_2",
      },
      controller,
    );

    const outcome = await entry.promise;
    expect(outcome.source).toBe("synthesized");
    expect(outcome.record.status).toBe("failed");
    expect(outcome.report.status).toBe("failed");

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));
  });
});
