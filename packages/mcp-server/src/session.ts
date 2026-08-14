/**
 * Live state of the MCP server, for the lifetime of a connection: the project
 * root, the task store derived from it, and the tasks launched by
 * `caesar_delegate` — each with its `AbortController` (for `caesar_cancel`)
 * and the promise of its outcome (for `caesar_await`/`caesar_status`).
 *
 * Watch point from the task 7 brief: `caesar_delegate` launches `runTask`
 * without awaiting it. An unawaited promise that rejects would produce an
 * unhandled rejection — `launchTask` guards against this by systematically
 * intercepting `runTask`'s failure and turning it into a synthetic
 * `TaskOutcome` whose trace is dropped into the store: it is `caesar_await`
 * that will report it, never an exception bubbling up into the void.
 */
import type { Queue, RunTaskInput, TaskOutcome, TaskRecord, TaskStore } from "@caesar/core";
import { createSlotQueue, fileTaskStore, loadConfig, runTask } from "@caesar/core";
import { REPORT_PROTOCOL, ReportSchema } from "@caesar/protocol";

export interface SessionTask {
  agentId: string;
  startedAt: string;
  controller: AbortController;
  /** Never rejects: see `launchTask`. */
  promise: Promise<TaskOutcome>;
}

export interface McpSession {
  root: string;
  store: TaskStore;
  tasks: Map<string, SessionTask>;
  /**
   * Semaphore shared by every `caesar_delegate` of this session — see C4 of
   * the final review: `RunnerDeps.queue` was wired by no facade, so
   * `max_parallel` was enforced nowhere even though
   * `caesarDelegateDescription` explicitly encourages the model to call
   * `caesar_delegate` "repeatedly back to back". Its limit is that of
   * `policy.max_parallel` at connection time (`createSession`): like the
   * TUI's install detection ("loaded once, not on every keystroke"), a later
   * edit of the policy mid-session does not resize this queue — an accepted
   * limitation rather than rebuilding a queue that might have tasks waiting.
   *
   * Since then, this semaphore is backed by slot files (`createSlotQueue`)
   * rather than memory: the limit now holds across processes, hence between
   * this session and the `caesar run` invocations launched by hand under the
   * same root.
   */
  queue: Queue;
}

export async function createSession(root: string): Promise<McpSession> {
  const { config } = await loadConfig(root);
  // Slots on disk, shared with everything that delegates under this root:
  // without them, an MCP session with four tasks and a `caesar run` launched
  // in a terminal ignored each other, and `max_parallel = 4` allowed five
  // agents.
  const queue = createSlotQueue({
    root,
    limit: config.policy.max_parallel,
    label: "caesar mcp serve",
  });
  return { root, store: fileTaskStore(root), tasks: new Map(), queue };
}

/**
 * Builds the fallback `TaskOutcome` when `runTask` rejects before it could
 * produce its own. Two cases, depending on where the failure occurred:
 *
 * - before `store.create` even ran (e.g. "worktree" isolation requested
 *   outside a git repository, or "inplace" refused for writing): no record
 *   exists yet, so one is created;
 * - after (e.g. `diffWorktree` failing unexpectedly): the existing record is
 *   finalized rather than duplicated. `pid` is explicitly cleared: the child
 *   process, if it was launched, has already exited by construction
 *   (`runAgentProcess` only resolves once the child has terminated), so a
 *   pid still set at this point would be stale.
 *
 * The fresh record describes what the caller **asked for**, not filler
 * values: `isolation: "inplace"` and `mode: "read-only"` used to be
 * hard-coded here, so a refused write delegation left in the store the exact
 * opposite trace of what it requested. The refusal of in-place writing (see
 * `isolation.ts`) makes this path ordinary rather than exceptional: it can
 * no longer afford to lie. Absent an isolation decision — `prepareIsolation`
 * did not complete — `"auto"` falls back to `"inplace"`, the only observable
 * value: no worktree was created.
 */
async function synthesizeFailure(
  store: TaskStore,
  input: RunTaskInput & { taskId: string },
  error: unknown,
): Promise<TaskOutcome> {
  const { taskId, agentId } = input;
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();

  const existing = await store.get(taskId);
  let record: TaskRecord;
  if (existing) {
    record = await store.update(taskId, { status: "failed", ended_at: now, pid: undefined });
  } else {
    const fresh: TaskRecord = {
      id: taskId,
      agent: agentId,
      objective: input.objective,
      status: "failed",
      created_at: now,
      started_at: now,
      ended_at: now,
      task_dir: "",
      workspace: input.workspace,
      isolation: input.isolation && input.isolation !== "auto" ? input.isolation : "inplace",
      mode: input.mode,
      report_via: "file",
      depth: input.depth ?? 0,
    };
    if (input.role !== undefined) fresh.role = input.role;
    await store.create(fresh);
    record = fresh;
  }

  const report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: taskId,
    status: "failed",
    summary: `Task interrupted before completion: ${message}`,
  });

  return { record, report, source: "synthesized" };
}

/**
 * Last safety net, with no I/O at all: if even `synthesizeFailure` failed
 * (the store itself failing on I/O — disk full, permissions…), a valid
 * `TaskOutcome` is still built in pure memory. The result may then no longer
 * reflect what the store holds on disk, but the session's promise, for its
 * part, never rejects — that is the guarantee this module carries (see the
 * file header).
 */
function buildInMemoryFailureOutcome(input: RunTaskInput & { taskId: string }, error: unknown): TaskOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  const record: TaskRecord = {
    id: input.taskId,
    agent: input.agentId,
    objective: input.objective,
    status: "failed",
    created_at: now,
    started_at: now,
    ended_at: now,
    task_dir: "",
    workspace: input.workspace,
    isolation: input.isolation && input.isolation !== "auto" ? input.isolation : "inplace",
    mode: input.mode,
    report_via: "file",
    depth: input.depth ?? 0,
  };
  if (input.role !== undefined) record.role = input.role;
  const report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: input.taskId,
    status: "failed",
    summary: `Task interrupted before completion, and the trace itself could not be written to the store: ${message}`,
  });
  return { record, report, source: "synthesized" };
}

/**
 * Launches `runTask` without awaiting it, and keeps the promise and its
 * `AbortController` in the session, indexed by `input.taskId` — the caller
 * (see `tools/delegate.ts`) generated it itself, precisely so it can return
 * it before this promise resolves.
 */
export function launchTask(session: McpSession, input: RunTaskInput & { taskId: string }, controller: AbortController): SessionTask {
  const promise = runTask({ store: session.store, root: session.root, queue: session.queue }, input).catch(async (error: unknown) => {
    try {
      return await synthesizeFailure(session.store, input, error);
    } catch (storeError) {
      // Even the fallback trace could not be dropped into the store: this
      // promise is still never allowed to reject (see the watch point in
      // the brief).
      return buildInMemoryFailureOutcome(input, storeError);
    }
  });
  const entry: SessionTask = { agentId: input.agentId, startedAt: new Date().toISOString(), controller, promise };
  session.tasks.set(input.taskId, entry);
  return entry;
}
