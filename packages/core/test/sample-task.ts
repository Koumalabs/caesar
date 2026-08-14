/**
 * Test `sampleTask`/`sampleContext`, for a given agent — until now copied
 * identically into the five adapter tests (`src/adapters/*.test.ts`) and
 * `src/registry/generic.test.ts` (task 10, B): a required field added to
 * `Task` demanded six identical fixes rather than a single one here. Only
 * `agent` varies from one file to another (the identifier of the agent
 * under test) — `makeSampleFactory` pins it once, the rest is shared as is.
 */
import { taskPaths, TaskSchema, TASK_PROTOCOL, type Task, type TaskPaths } from "@caesar/protocol";
import type { BuildContext } from "../src/registry/types.js";

/** `TaskPaths` of `sampleContext` — exported separately: several tests also use it directly (e.g. `paths.dir`, `join(paths.dir, …)`). */
export const paths: TaskPaths = taskPaths("/tmp/task");

export function makeSampleFactory(defaultAgentId: string): {
  sampleTask: (overrides?: Partial<Task>) => Task;
  sampleContext: (overrides?: Partial<BuildContext>) => BuildContext;
} {
  function sampleTask(overrides: Partial<Task> = {}): Task {
    return TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id: "t_0001",
      created_at: "2026-08-09T10:00:00.000Z",
      agent: defaultAgentId,
      objective: "Fix the regression",
      mode: "write",
      isolation: "worktree",
      workspace: "/tmp/wt",
      deadline_ms: 600_000,
      report_path: "/tmp/task/report.json",
      events_path: "/tmp/task/events.jsonl",
      ...overrides,
    });
  }

  function sampleContext(overrides: Partial<BuildContext> = {}): BuildContext {
    return {
      task: sampleTask(),
      paths,
      prompt: "PROMPT",
      reportVia: "file",
      model: undefined,
      extraArgs: [],
      ...overrides,
    };
  }

  return { sampleTask, sampleContext };
}
