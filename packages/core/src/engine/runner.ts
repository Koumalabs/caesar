/**
 * Assembly of a complete execution: resolves the agent, prepares isolation,
 * picks the report tier, launches the process, reconciles the report with
 * git, and updates the store. This is the piece that turns the registry into
 * an orchestrator.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Channel, Finding, Isolation, CaesarEvent, Report, ReportChannel, Task, TaskMode, TaskPaths } from "@caesar/protocol";
import {
  REPORT_PROTOCOL,
  ReportSchema,
  TASK_PROTOCOL,
  TaskSchema,
  renderTaskPrompt,
  strictReportJsonSchema,
  taskEnv,
  taskPaths,
  writeReport,
  writeTask,
} from "@caesar/protocol";
import type { WorktreeConfig } from "../config.js";
import { decideInplaceWrite } from "../isolation.js";
import { resolveAgentDefinition } from "../registry/index.js";
import { detectUntrackedNeeds, materializeUntracked, runSetup } from "./materialize.js";
import type { MaterializeResult } from "./materialize.js";
import type { AgentDefinition, SpawnPlan } from "../registry/types.js";
import type { GenericAgentSpec } from "../registry/generic.js";
import type { ChangesVerifiedBy, ReportSource, TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { resolveReport, reconcileChanges } from "./report.js";
import { runAgentProcess } from "./spawn.js";
import type { RunResult } from "./spawn.js";
import {
  captureWorkspaceStatus,
  createWorktree,
  diffWorkspaceStatus,
  diffWorktree,
  hasCommits,
  repoRoot,
  worktreesDirIgnored,
} from "./worktree.js";
import type { Queue } from "./queue.js";
import type { WorktreeDiff, WorktreeHandle } from "./worktree.js";
import { clearWorktreeInUse, markWorktreeInUse } from "./gc.js";
import { acquireLease, releaseLease } from "./lock.js";

const DEFAULT_TIMEOUT_MS = 600_000;

/** Name under which the return channel is declared on the agent side (see `Channel.server_name`). Exported: an alternative launcher (see `ChannelLauncher`) must be able to reuse it without redefining it. */
export const CHANNEL_SERVER_NAME = "caesar";

/**
 * Absolute path of `dist/bin.js` inside `@caesar/mcp-channel`, resolved via
 * Node module resolution rather than assumed at a fixed relative path —
 * see the task 9 brief ("resolve its path dynamically rather than
 * assuming it"). This resolution survives an installation outside this
 * repository (npm, a global link…), as long as `@caesar/mcp-channel` remains a
 * declared dependency of `@caesar/core` (see its `package.json`): it is the
 * same method as `resolveTuiEntry` in
 * `packages/cli/src/commands/config.ts` for `@caesar/tui`.
 *
 * `@caesar/mcp-channel` restricts its `"exports"` to `"."` (unlike
 * `@caesar/tui`, which has no `"exports"`, so `resolveTuiEntry` can
 * resolve all the way to its `package.json` directly): asking to resolve
 * `"@caesar/mcp-channel/package.json"` would fail (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 * We therefore resolve the main entry (`"."` → `dist/index.js`) and
 * step over to its sibling `dist/bin.js`, always emitted in the same
 * directory by `tsc` since `src/index.ts` and `src/bin.ts` both live
 * at the root of `src/`, with no subdirectory.
 *
 * Only meaningful under Node: a compiled binary (task 12) no longer has any
 * `node_modules` to look anything up in — which is precisely why
 * this resolution is no longer hard-called by `buildChannel`, only
 * from `defaultChannelLauncher`, the default launcher (historical
 * behavior, unchanged).
 */
function resolveChannelEntry(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@caesar/mcp-channel");
  return join(dirname(indexPath), "bin.js");
}

/**
 * Builds the return channel coordinates for a task: a launcher, `taskDir`
 * as input, a `Channel | undefined` as output (never an error).
 *
 * Task 12's extension point: in a compiled binary (`bun build
 * --compile`), no module resolution makes sense anymore
 * (`resolveChannelEntry` fails, there is no `node_modules` left) — the
 * binary can no longer *infer* how to launch the channel, it must be
 * told. `configureChannelLauncher`, called once by the entry
 * point (see `packages/cli/src/bun-entry.ts`), is that configuration
 * point — a function rather than an environment variable:
 * directly testable (a test calls `configureChannelLauncher` with a
 * fake launcher and observes `task.channel`), without depending on ambient
 * state that `vitest` would have to manipulate and restore for each test.
 */
export type ChannelLauncher = (taskDir: string) => Channel | undefined;

/**
 * Default launcher, never reconfigured by the Node path (`bin.ts`):
 * it is the historical behavior of `buildChannel`, before task 12,
 * taken as-is — `command` is the Node binary itself
 * (`process.execPath`), never `caesar-channel` by name nor the resolved
 * file directly: neither can be assumed executable or present in the
 * sub-agent's `PATH` when it launches it — see
 * the task 9 brief. Throws if `resolveChannelEntry` fails;
 * `buildChannel`, its only caller, absorbs that exception.
 */
export function defaultChannelLauncher(taskDir: string): Channel | undefined {
  const entry = resolveChannelEntry();
  return { transport: "mcp-stdio", command: process.execPath, args: [entry, taskDir], server_name: CHANNEL_SERVER_NAME };
}

let channelLauncher: ChannelLauncher = defaultChannelLauncher;

/**
 * Entry point of task 12's extension: replaces the return channel
 * launcher used by every subsequent `runTask`. The Bun entry point
 * (`bun-entry.ts`) calls it once at startup with a launcher that
 * self-invokes the compiled binary (`caesar channel serve --task-dir <dir>`);
 * the Node entry point (`bin.ts`) never calls it, leaving
 * `defaultChannelLauncher` in place — behavior unchanged.
 */
export function configureChannelLauncher(launcher: ChannelLauncher): void {
  channelLauncher = launcher;
}

/**
 * Never throws, whatever launcher is configured: a failed resolution
 * (broken installation, package not found, a custom launcher that
 * throws…) yields `undefined` rather than failing the whole task — the
 * channel is never a point of failure, in either of the two worlds.
 */
function buildChannel(taskDir: string): Channel | undefined {
  try {
    return channelLauncher(taskDir);
  } catch {
    return undefined;
  }
}

/**
 * Name of the file where a CLI capable of `finalMessageFile` drops its last
 * message, under the task directory. Fixed, predictable path: an
 * agent that knows its task directory (`$CAESAR_TASK_DIR`) can find it
 * without any dedicated token existing in the generic argument
 * template (`GenericAgentSpec`, task 3) — this is what the fake agent
 * does in the tests.
 */
const FINAL_MESSAGE_FILE_NAME = "final-message.txt";

export interface RunnerDeps {
  store: TaskStore;
  root: string;
  /**
   * Semaphore sharing the `policy.max_parallel` cap between all the
   * `runTask` calls of a single facade. Mandatory — even if it means passing
   * `undefined` explicitly — see C4/the typing hardening of the final review:
   * an optional property is precisely what let the three
   * facades (`caesar run`, `caesar_delegate`, `caesar agents test`) omit the
   * wiring without any compile error flagging it, leaving
   * `max_parallel` unenforced end to end. `undefined` remains a
   * legitimate choice for a caller that deliberately wants no limit (see
   * the tests); it is no longer a silent omission.
   */
  queue: Queue | undefined;
}

export interface RunTaskInput {
  agentId: string;
  objective: string;
  context?: string;
  constraints?: string[];
  acceptance_criteria?: string[];
  mode: TaskMode;
  isolation?: Isolation | "auto";
  /**
   * Allows a write task to run in `"inplace"` isolation inside
   * a usable git repository — which `decideInplaceWrite` (`isolation.ts`)
   * otherwise refuses.
   *
   * A permission **carried by the caller**, never read from the
   * configuration by the engine, on the `extraAgents` model: `runTask` only
   * has `deps.root`, and an engine that went to fetch the opt-in itself
   * would turn every direct call into a blind spot. Absent (the default), the
   * answer is no: a caller that forgets to pass along
   * `policy.allow_inplace_write` gets a refusal, never a silent
   * bypass. That is the very point of the fix — see the header
   * of `isolation.ts`.
   */
  allowInplaceWrite?: boolean;
  /**
   * Is the network available for this task? Already resolved — the tri-state
   * request stops at `resolveDelegation`, which confronted it with what the
   * agent allows. Absent: true, like the protocol default, so that
   * callers that know nothing about it (`caesar agents test`) remain unchanged.
   */
  network?: boolean;
  /** Warning produced by that resolution, to be added to the report (see `ResolvedDelegation.networkWarning`). */
  networkWarning?: string;
  /** Same channel for a dropped config-derived model (see `ResolvedDelegation.modelWarning`). */
  modelWarning?: string;
  workspace: string;
  role?: string;
  model?: string;
  timeoutMs?: number;
  depth?: number;
  /**
   * Generic agents declared in the configuration (`CaesarConfig.agents`,
   * `[[agent]]` in the TOML), consulted alongside the native catalog to resolve
   * `agentId` — see `resolveAgentDefinition` and C1 of the final review.
   * Absent or empty: native catalog only (behavior unchanged). Callers
   * that already hold the configuration (`caesar run`,
   * `caesar_delegate`, `caesar agents test`) pass it here rather than having
   * `runTask` — which otherwise only has `deps.root` — reload it.
   */
  extraAgents?: GenericAgentSpec[];
  /**
   * The project's `[worktree]` section (`CaesarConfig.worktree`): what must be
   * added to the worktree so that one can work in it, and what must be
   * run there before the agent.
   *
   * Passed by the caller rather than reloaded here, like `extraAgents` and
   * for the same reason: `runTask` only has `deps.root`, and the facades
   * already hold the merged configuration. Absent: the worktree remains
   * whatever git makes of it — the tracked files, nothing more. No effect in
   * `"inplace"` isolation, where the real workspace is already complete.
   */
  worktreeSetup?: WorktreeConfig;
  extraArgs?: string[];
  /**
   * Enables the bidirectional MCP return channel for this task, if the target
   * agent knows how to load an MCP server (`capabilities.mcpInjection !==
   * "none"`): the runner then builds the `Channel` coordinates
   * itself (see `buildChannel`/`resolveChannelEntry` below) —
   * `caesar-channel` binary resolved dynamically, `taskDir` argument, server
   * name `"caesar"` — no caller needs to know the details. Absent or
   * false (default): behavior unchanged, no channel offered — see the
   * task 9 brief: the channel adds a process and a configuration
   * injection to every delegation, that has to be chosen explicitly.
   *
   * No effect, never an error, if the agent cannot load an MCP
   * server or if the binary resolution fails (broken installation…): the
   * channel is never a point of failure, the task then falls back to
   * the next report tier (`defaultPreferredReportChannel`).
   */
  channel?: boolean;
  /**
   * Identifier to use for this task, rather than generating one.
   * Lets the caller know the task directory in advance
   * (`<root>/.caesar/tasks/<taskId>`) — hence follow it (`events.jsonl`)
   * while it runs, or reference it before `runTask` even
   * resolves. Absent: behavior unchanged, an identifier is generated here
   * as before. Serves notably the CLI (`caesar run`, live progress) and,
   * eventually, the MCP server (`caesar_delegate`, which must return an
   * identifier immediately to allow several delegations in parallel).
   */
  taskId?: string;
  /**
   * Passed as-is to `runAgentProcess`, which already supports it: lets the
   * caller cancel a running task without waiting for its resolution, while
   * guaranteeing that no sub-process is left behind (SIGTERM then,
   * absent a response, SIGKILL — see `spawn.ts`).
   */
  signal?: AbortSignal;
  /**
   * Passed as-is to `runAgentProcess`, which already supports it: lets the
   * caller observe the normalized events as they stream, rather
   * than having to re-read `events.jsonl` after the fact.
   */
  onEvent?: (event: CaesarEvent) => void;
}

export interface TaskOutcome {
  record: TaskRecord;
  report: Report;
  source: ReportSource;
  diff?: WorktreeDiff;
}

export async function runTask(deps: RunnerDeps, input: RunTaskInput): Promise<TaskOutcome> {
  const agentDef = resolveAgentDefinition(input.agentId, input.extraAgents ?? []);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const depth = input.depth ?? 0;

  const id = input.taskId ?? generateTaskId();
  const taskDir = join(deps.root, ".caesar", "tasks", id);
  const paths = taskPaths(taskDir);

  // Checked here, before committing to isolation: the preparation that
  // follows can create a git worktree, an operation that is not instant.
  // Without this guard, a signal already triggered at entry would be ignored
  // until the end — `runAgentProcess` (second guard, right before launching
  // the child) only covers cancellation occurring *during* that preparation.
  if (input.signal?.aborted) {
    return abortBeforeStart(deps, input, id, paths, agentDef, depth);
  }

  // Placed before any possible worktree creation and kept until the
  // end: `caesar gc` can thus tell a genuine task that is starting up from an
  // orphan, even during the window preceding `store.create`.
  const worktreeLease = await markWorktreeInUse(deps.root, id);
  try {
  const { isolation, warning, handle, materialization, missingSection, gitignoreWarning, worktreeWasPossible } = await prepareIsolation(
    deps.root,
    id,
    input,
    agentDef,
  );
  const workspace = handle ? handle.path : input.workspace;

  // Write exclusivity over a shared tree. Two `worktree` tasks each have
  // their own and cannot get in each other's way; two `inplace` write tasks
  // share the same one, and `diffWorkspaceStatus` — which compares the git
  // state before and after — would then attribute each one's modifications
  // to the other. The reconciliation, which is the whole value of the
  // system, would become wrong without anything flagging it.
  //
  // Only when a worktree **was possible**: this is what separates the
  // *chosen* `"inplace"` (opt-in `allow_inplace_write`, where exclusivity is
  // the accepted price of the choice) from the `"inplace"` one is *stuck
  // with*, for want of a usable git repository. Locking the latter would
  // serialize every write delegation on an unversioned project — at the cost
  // of the parallelism promise that `caesar_delegate` carries — while
  // offering no alternative whatsoever, since no worktree can be created
  // there. The degraded-isolation finding, for its part, is already in the
  // report.
  //
  // Neither `createSlotQueue` (which bounds a *number* of tasks, not their
  // exclusivity) nor `markWorktreeInUse` (indexed by task) answers this
  // question: the workspace is the resource. Immediate failure naming the
  // occupant, never a silent waiting line — the caller knows better than us
  // whether it wants to wait or rephrase.
  const writeLease =
    isolation === "inplace" && input.mode === "write" && worktreeWasPossible
      ? await acquireLease(join(deps.root, ".caesar", "state", "workspace-writers"), workspace, {
          label: `task ${id} (${agentDef.id})`,
          describeHolder: (holder) =>
            `Cannot write in place in "${workspace}": ${holder.label ?? `process ${holder.pid}`} is already writing there. ` +
            `Two write tasks in the same tree would make their diffs unattributable. Wait for it to finish, ` +
            `or leave isolation at "worktree" so that each task gets its own.`,
        })
      : null;
  try {

  const channel: Channel | undefined =
    input.channel === true && agentDef.capabilities.mcpInjection !== "none" ? buildChannel(paths.dir) : undefined;

  const task: Task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id,
    created_at: new Date().toISOString(),
    role: input.role,
    agent: agentDef.id,
    objective: input.objective,
    context: input.context ?? "",
    constraints: input.constraints ?? [],
    acceptance_criteria: input.acceptance_criteria ?? [],
    mode: input.mode,
    isolation,
    network: input.network,
    workspace,
    base_ref: handle?.baseRef,
    deadline_ms: timeoutMs,
    depth,
    report_path: paths.reportPath,
    events_path: paths.eventsPath,
    channel,
  });

  const channelAvailable = task.channel != null;
  const reportVia: ReportChannel = agentDef.preferredReportChannel(task, channelAvailable);

  let schemaFile: string | undefined;
  if (reportVia === "schema") {
    await mkdir(paths.dir, { recursive: true });
    schemaFile = join(paths.dir, "report.schema.json");
    await writeFile(schemaFile, JSON.stringify(strictReportJsonSchema(), null, 2) + "\n", "utf8");
  }

  const prompt = renderTaskPrompt(task, { reportVia, channelServerName: task.channel?.server_name });

  // When the CLI itself knows how to drop its last message into a file
  // (Codex with `-o`, for example), that is more reliable than a
  // reconstruction from stdout: `resolveReport` consults it first at tier 2.
  const finalMessageFile = agentDef.capabilities.finalMessageFile ? join(paths.dir, FINAL_MESSAGE_FILE_NAME) : undefined;

  const plan = agentDef.build({
    task,
    paths,
    prompt,
    reportVia,
    schemaFile,
    finalMessageFile,
    // C6 of the final review: `BuildContext.model` was left absent here,
    // silently (the field was optional until now) — `--model`/`model:` was
    // therefore accepted by the CLI, the MCP tool's zod schema and the README,
    // without ever reaching a single one of the five adapters that consume it.
    model: input.model,
    extraArgs: input.extraArgs ?? [],
  });
  // The minimal contract of an external agent ($CAESAR_TASK_FILE, $CAESAR_REPORT_PATH…)
  // depends on no adapter: the engine guarantees it, here, for
  // every agent, generic or not.
  const finalPlan: SpawnPlan = { ...plan, env: { ...taskEnv(task, paths), ...plan.env } };

  await writeTask(paths, task);

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "running",
    created_at: task.created_at,
    started_at: new Date().toISOString(),
    task_dir: paths.dir,
    workspace,
    isolation,
    mode: input.mode,
    branch: handle?.branch,
    // Persisted at creation, not at the end: `caesar diff` can be called
    // on a task still running, and must already exclude what the
    // orchestrator placed.
    ...(handle?.excluded ? { excluded_paths: handle.excluded } : {}),
    report_via: reportVia,
    depth,
  };
  await deps.store.create(record);

  // From here on, the record exists in the store with the "running"
  // status: see I13 of the final review. Without this `try/finally`, an
  // unexpected exception between `store.create` and the final `store.update`
  // (I/O, git sub-process...) left the record stuck as "running"
  // forever — `caesar ps` then classifies it "active" for life, and a future
  // `caesar cancel` on that identifier would signal a pid that the OS may
  // have reassigned in the meantime (a risk already identified by the
  // `pid: undefined` comment below, which until now only covered the happy
  // path). `finalized` avoids a double `store.update` on the happy
  // path: the normal update, below, has already said everything.
  let finalized = false;
  try {
    return await runTaskBody();
  } finally {
    if (!finalized) {
      await deps.store
        .update(id, { status: "failed", ended_at: new Date().toISOString(), pid: undefined })
        .catch(() => {
          // Best effort: must never mask the original exception, already propagating.
        });
    }
  }

  async function runTaskBody(): Promise<TaskOutcome> {
  // Captured right before the launch, when isolation is "inplace": it is
  // the only way to reconcile `report.changes` with git reality outside a
  // worktree — see C2/C3 of the final review. `captureWorkspaceStatus`
  // returns `null` without throwing if `workspace` is not a git repository;
  // in that case as in "worktree" isolation (where reconciliation goes
  // through `diffWorktree`), no reconciliation is attempted below.
  const workspaceStatusBefore = isolation === "inplace" ? await captureWorkspaceStatus(workspace) : null;

  const execute = (): Promise<RunResult> =>
    runAgentProcess({
      agent: agentDef,
      plan: finalPlan,
      paths,
      taskId: id,
      timeoutMs,
      signal: input.signal,
      onEvent: input.onEvent,
      // Records the pid as soon as it is known, so that another process
      // (typically `caesar cancel`) can find and signal the task
      // while it is still running — see `TaskRecord.pid`.
      onSpawn: async (pid) => {
        await deps.store.update(id, { pid });
      },
    });
  const run = deps.queue ? await deps.queue.run(execute) : await execute();

  // "The git diff is the source of truth" must hold in both isolations, not
  // just "worktree" (see C2 of the final review): `diffWorkspaceStatus`
  // replays the same logic as `diffWorktree` (reconciliation + write
  // detection below) without a worktree, from two `git status --porcelain`
  // snapshots of the real workspace.
  const rawDiff = handle
    ? await diffWorktree(handle)
    : workspaceStatusBefore !== null
      ? await diffWorkspaceStatus(workspace, workspaceStatusBefore)
      : undefined;
  // Excludes the files the orchestrator itself wrote into the
  // task's workspace (e.g. `opencode.json`, see C5 of the final
  // review): without this filter, a read-only agent that never wrote
  // anything would be accused of writing by its own MCP configuration, and
  // `reconcileChanges` would add an "undeclared modification" finding
  // for a file the agent never touched.
  const diff = rawDiff ? excludePlanFiles(rawDiff, finalPlan.files, handle ? handle.path : workspace) : undefined;

  const resolved = await resolveReport({ task, paths, run, diff, reportVia, finalMessageFile });
  let report = resolved.report;

  // Provenance of `report.changes` for the consumer at the end of the chain
  // (`ReportSummary.changes_verified_by`, `caesar_await`/`caesar_delegate`):
  // "git" as soon as a reconciliation could be attempted (worktree, or inplace
  // in a git repository), "declaration" only when no `git status`/`git diff`
  // was possible (workspace outside a git repository) — it is then the
  // agent's word alone, never presented as anything more.
  const changesVerifiedBy: ChangesVerifiedBy = diff ? "git" : "declaration";

  if (diff) {
    report = reconcileChanges(report, diff);
  }

  if (task.mode === "read-only" && diff && !diff.isEmpty) {
    report = withFinding(report, {
      severity: "high",
      title: "Write detected during a read-only task",
      detail: `Files modified despite read-only mode: ${diff.files.map((f) => f.path).join(", ")}`,
    });
  }

  if (warning) {
    report = withFinding(report, { severity: "low", title: "Degraded isolation", detail: warning });
  }

  // The diagnostic that was missing the day of the workaround: saying, in the
  // report, what the workshop could not carry and by which key to
  // fix it. Without it, an incomplete worktree only shows up as a
  // task that fails for no visible reason — and the natural reaction is to
  // give up on isolation, not to fill in `[worktree]`.
  if (missingSection) {
    report = withFinding(report, { severity: "low", title: "Worktree without a workshop", detail: missingSection });
  }

  if (gitignoreWarning) {
    report = withFinding(report, { severity: "low", title: "Worktrees not ignored by git", detail: gitignoreWarning });
  }

  if (materialization) {
    for (const entry of materialization.skipped) {
      report = withFinding(report, {
        severity: "low",
        title: "Path not materialized in the worktree",
        detail: entry.detail,
        file: entry.path,
      });
    }
    if (materialization.shared.length > 0) {
      report = withFinding(report, {
        severity: "info",
        title: "Paths shared with the workspace",
        detail:
          `Placed as symlinks, hence NOT isolated: ${materialization.shared.join(", ")}. ` +
          `Whatever the sub-agent writes there touches the workspace, and two simultaneous tasks step on each other. ` +
          `Move these paths from "link" to "copy" under [worktree] as soon as the cost of the copy allows it.`,
      });
    }
  }

  // `info` rather than `low`: nothing failed, and this case is everyday life
  // for read-only roles on codex. Declaring `network = "off"` on the role
  // makes the intent explicit and silences the warning.
  if (input.networkWarning) {
    report = withFinding(report, { severity: "info", title: "Network not guaranteed", detail: input.networkWarning });
  }

  if (input.modelWarning) {
    report = withFinding(report, { severity: "info", title: "Model not applied", detail: input.modelWarning });
  }

  // Persisted before the final store update (see C2 of the final
  // review, second gap): `writeReport` until now had only one
  // production caller, `submit_report` on the MCP channel
  // (`packages/mcp-channel/src/server.ts`) — `runTask` computed the
  // reconciled report then let it die with the process. Direct consequence:
  // `caesar_await` on a task launched by another process
  // (`describeFromStore`, `packages/mcp-server`) re-read the agent's raw
  // report, never reconciled, or nothing at all when the selected tier
  // did not write `report.json` (the "extracted"/"synthesized" tiers). Written
  // before `deps.store.update`: a reader who sees the status switch to
  // "succeeded"/"failed" then already finds the final report on disk,
  // never a still-unreconciled version.
  await writeReport(paths, report);

  const finalStatus = deriveTaskStatus(run);
  const updated = await deps.store.update(id, {
    status: finalStatus,
    ended_at: new Date().toISOString(),
    exit_code: run.exitCode,
    report_source: resolved.source,
    changes_verified_by: changesVerifiedBy,
    // I3 of the final review: `status` (above) only reflects the outcome of
    // the process, never what the agent declared in its report — an agent
    // that writes {"status":"failed"} then exits with code 0 produced
    // `status: "succeeded"` without anything keeping a trace of the "failed"
    // report in the store. `report_status` carries that second level, so that
    // `caesar ps`, the exit code of `caesar run` and `caesar_status` can
    // cross-check the two rather than ignore the second.
    report_status: report.status,
    // The process no longer exists: a cleared pid keeps `caesar cancel` from
    // signaling a pid reused in the meantime by an entirely different process.
    pid: undefined,
  });
  finalized = true;

  return { record: updated, report, source: resolved.source, diff };
  }
  } finally {
    if (writeLease) await releaseLease(writeLease);
  }
  } finally {
    await clearWorktreeInUse(worktreeLease);
  }
}

/** Used by `runTask` when `input.taskId` is absent. Exported so that
 * callers that prefer to impose their own identifier (see `RunTaskInput.taskId`)
 * reuse the same format rather than maintaining a second implementation. */
export function generateTaskId(): string {
  return `t_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Short-circuits `runTask` when `input.signal` is already triggered at entry:
 * no isolation is prepared (no git worktree, potentially
 * slow), `agentDef.build` is not called, and above all no process is
 * launched. The result remains a valid `TaskOutcome`, visible to
 * `caesar ps`/`caesar logs` like any other cancelled task.
 */
async function abortBeforeStart(
  deps: RunnerDeps,
  input: RunTaskInput,
  id: string,
  paths: TaskPaths,
  agentDef: AgentDefinition,
  depth: number,
): Promise<TaskOutcome> {
  const now = new Date().toISOString();
  // No real isolation decision was made since `prepareIsolation`
  // never ran: "auto" makes no sense here, "inplace" is the most
  // honest value (no worktree created), the explicitly requested isolation
  // otherwise.
  const isolation: Isolation = input.isolation && input.isolation !== "auto" ? input.isolation : "inplace";

  const record: TaskRecord = {
    id,
    agent: agentDef.id,
    role: input.role,
    objective: input.objective,
    status: "cancelled",
    created_at: now,
    started_at: now,
    ended_at: now,
    task_dir: paths.dir,
    workspace: input.workspace,
    isolation,
    mode: input.mode,
    report_via: "file",
    report_status: "failed",
    depth,
  };
  await deps.store.create(record);

  const report: Report = ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: id,
    status: "failed",
    summary: "Task cancelled before launch: the abort signal was already triggered when runTask was entered.",
  });

  return { record, report, source: "synthesized" };
}

function withFinding(report: Report, finding: Finding): Report {
  return { ...report, findings: [...report.findings, finding] };
}

/**
 * Removes from the diff the files the orchestrator itself dropped into
 * the diffed tree (`plan.files`, e.g. `opencode.json` — see C5 of
 * the final review). `diff.files[].path` is relative to `base` (worktree
 * root or real workspace depending on isolation); `plan.files[].path` is
 * absolute: the comparison therefore resolves each diff path against `base`
 * before checking it against the set of plan paths.
 */
function excludePlanFiles(diff: WorktreeDiff, planFiles: readonly { path: string }[], base: string): WorktreeDiff {
  if (planFiles.length === 0) return diff;
  const excluded = new Set(planFiles.map((file) => resolve(file.path)));
  const files = diff.files.filter((change) => !excluded.has(resolve(base, change.path)));
  if (files.length === diff.files.length) return diff;
  return { ...diff, files, isEmpty: files.length === 0 };
}

function deriveTaskStatus(run: RunResult): TaskStatus {
  if (run.aborted) return "cancelled";
  if (run.timedOut) return "timed_out";
  return run.exitCode === 0 ? "succeeded" : "failed";
}

interface IsolationPreparation {
  isolation: Isolation;
  warning?: string;
  handle?: WorktreeHandle;
  /**
   * What the workshop materialization placed and set aside (`[worktree]`,
   * see `materializeUntracked`), to be added to the report. Absent outside
   * worktree isolation, or when the project declares nothing.
   */
  materialization?: MaterializeResult;
  /**
   * Set when the project has no `[worktree]` section but seems to
   * need one (installed dependencies ignored by git, detected by
   * `detectUntrackedNeeds`). The worktree is then empty of everything that
   * runs, and that is precisely what the report must say.
   */
  missingSection?: string;
  /** Set when `.caesar/wt/` is not ignored by git — see `worktreesDirIgnored`. */
  gitignoreWarning?: string;
  /**
   * Was a worktree possible? False outside a git repository, or in a
   * repository without a single commit.
   *
   * Serves to distinguish the two `"inplace"` cases, which do not carry the
   * same responsibility: the one that was **chosen** while a worktree was
   * within reach, and the one that was **settled for** absent an alternative.
   * See the write lock, in `runTask`.
   */
  worktreeWasPossible: boolean;
}

/**
 * Applies the `"auto"` isolation rule (see the task brief) then, if
 * the result is `"worktree"`, actually creates the worktree.
 *
 * The last case in the table — read-only with an agent lacking a read-only
 * mode enforced by its CLI — is deliberate: the disposable worktree
 * turns a prompt promise into an observable guarantee.
 *
 * C3 of the final review: until now this transformation was a default of
 * the `"auto"` resolution, not a constraint — an explicit
 * `isolation: "inplace"` (argument of `caesar_delegate`, `role.isolation`,
 * `policy.default_isolation`) silently undid it, including for
 * the `reviewer` role shipped by default. `mustForceWorktree` makes it a
 * non-bypassable constraint: as soon as a read-only agent without a native
 * mode runs in a git repository, isolation is forced to `"worktree"`
 * whatever the requested value — with an explicit `warning` in the
 * report when this contradicts an explicit request (silent only
 * when the request was already `"worktree"` or `"auto"`, where that was
 * already the expected result).
 */
async function prepareIsolation(
  root: string,
  taskId: string,
  input: RunTaskInput,
  agentDef: AgentDefinition,
): Promise<IsolationPreparation> {
  const requested = input.isolation ?? "auto";
  const base = await repoRoot(input.workspace);

  // A repository without a commit is a repository: `repoRoot` resolves it. But
  // no branch was born there, `HEAD` points to nothing, and it therefore
  // cannot serve as the starting point of a worktree. For isolation, it
  // counts as a non-repository — with a remedy that, for its part, differs: a
  // first commit.
  const baseUsable = base !== null && (await hasCommits(base));
  const unusable =
    base === null
      ? `workspace "${input.workspace}" is not a git repository`
      : `repository "${base}" has no commits yet: its branch is unborn, "HEAD" points to nothing, ` +
        `and git cannot create a worktree out of nothing`;
  const remedy =
    base === null
      ? `Initialize a repository ("git init" then a first commit) to isolate the work, or explicitly request "inplace" knowing what that entails.`
      : `Make a first commit ("git add -A && git commit -m …", if needed "git commit --allow-empty -m init"), or explicitly request "inplace" — the agent will then work directly in the workspace.`;

  // Before any decision, not after: a write task has no
  // right to run in the user's working tree without a deliberate
  // opt-in. This point is the only one *all* facades go through — including
  // a direct call to `runTask` that would bypass
  // `resolveDelegation`, where the same verdict is already rendered, earlier
  // and without leaving anything on disk. `decideInplaceWrite` being pure,
  // the two cannot diverge.
  //
  // We throw instead of falling back to `"worktree"`: unlike
  // `mustForceWorktree` just below — which *contains* a forbidden
  // write — the write here is legitimate and it is its location that is
  // at issue. Silently relocating the modifications the caller
  // expects would be worse than refusing.
  const inplaceWrite = decideInplaceWrite({
    requested,
    mode: input.mode,
    repoUsable: baseUsable,
    allowed: input.allowInplaceWrite ?? false,
    ...(base !== null ? { repo: base } : {}),
  });
  if (inplaceWrite.refused) {
    throw new Error(`Task "${taskId}": ${inplaceWrite.reason} ${inplaceWrite.remedy}`);
  }

  const mustForceWorktree = input.mode === "read-only" && !agentDef.capabilities.nativeReadOnly && baseUsable;

  let isolation: Isolation;
  let warning: string | undefined;

  if (mustForceWorktree && requested !== "worktree") {
    isolation = "worktree";
    if (requested !== "auto") {
      warning =
        `Isolation "${requested}" requested for agent "${agentDef.id}" in read-only mode (no native mode): ` +
        `forced to "worktree" so that any write is contained and detected rather than merely promised by the prompt.`;
    }
  } else if (requested !== "auto") {
    isolation = requested;
  } else if (input.mode === "write") {
    if (baseUsable) {
      isolation = "worktree";
    } else {
      isolation = "inplace";
      warning = `Isolation fell back to "inplace" despite write mode: ${unusable}. ${remedy}`;
    }
  } else if (agentDef.capabilities.nativeReadOnly) {
    isolation = "inplace";
  } else {
    // mode === "read-only", agent without a native mode, and mustForceWorktree
    // is false: `baseUsable` is therefore necessarily false here (otherwise
    // the branch above would already have handled it).
    isolation = "inplace";
    warning =
      `Isolation fell back to "inplace" despite "${agentDef.id}" lacking a native read-only mode: ${unusable}. ${remedy}`;
  }

  if (isolation !== "worktree") {
    return { isolation, warning, worktreeWasPossible: baseUsable };
  }

  if (!baseUsable) {
    // The worktree was requested explicitly, or imposed by
    // `mustForceWorktree`: silently giving up on it would remove the very
    // guarantee it was required for. We refuse, naming the cause and the way
    // out.
    throw new Error(
      `Isolation "worktree" impossible for task "${taskId}": ${unusable}. ${remedy}`,
    );
  }

  // Step 0 of the `superpowers:using-git-worktrees` skill, which the project
  // assumed settled since `caesar init` — a hand-rewritten `.gitignore`
  // is enough to undo what it had set up.
  //
  // A finding, not a refusal, and deliberately so: verified rather than
  // assumed, git does *not* suck in the contents of a non-ignored worktree.
  // It recognizes it as a nested repository and adds only a single entry (a
  // gitlink), warning about it itself. The nuisance is real, the catastrophe
  // is not — and failing a delegation over a missing `.gitignore` line
  // would cost more than what it protects.
  const gitignoreWarning = (await worktreesDirIgnored(base, taskId))
    ? undefined
    : `The worktrees directory ".caesar/wt/" is not ignored by git in "${base}": a "git add -A" would add ` +
      `a nested-repository entry there. Add ".caesar/wt/" to the ".gitignore" (or rerun "caesar init --force", which does it).`;

  // Named to be read: in a workshop, the user re-reads their branches.
  // The role when there is one, the agent otherwise — that is what tells
  // apart two workshops opened at the same time on the same objective.
  const handle = await createWorktree(base, taskId, "HEAD", {
    objective: input.objective,
    label: input.role ?? agentDef.id,
  });

  // The workshop: the worktree git just created only carries the tracked
  // files. What follows adds to it what the project declares under
  // `[worktree]` — dependencies, `.env`, ignored directories — then runs its
  // setup. Here, and nowhere else: before `writeTask`, before
  // `agentDef.build`, before any launch. An agent starting in a half-mounted
  // workshop would spend its budget repairing an installation instead of
  // working.
  const request = input.worktreeSetup;
  let materialization: MaterializeResult | undefined;
  let missingSection: string | undefined;
  if (request && (request.copy.length > 0 || request.link.length > 0)) {
    materialization = await materializeUntracked(input.workspace, handle.path, request);
    if (materialization.excluded.length > 0) handle.excluded = materialization.excluded;
  } else {
    // No section, but a project that would obviously need one: say it
    // here rather than let the agent trip over a missing
    // `node_modules`. Without this finding, an empty worktree only shows up
    // as a task that fails for no visible reason — and the natural reaction
    // is to give up on isolation, not to fill in the configuration.
    const detected = await detectUntrackedNeeds(input.workspace);
    if (detected && detected.copy.length > 0) {
      missingSection =
        `The worktree only contains the files tracked by git. This project seems to need to bring along ` +
        `${detected.copy.join(", ")} — without which nothing installs or runs there. Declare them under [worktree] ` +
        `in ".caesar/config.toml" (key "copy"${detected.setup.length > 0 ? `, and "setup" for ${detected.setup.join(" ; ")}` : ""}), ` +
        `or rerun "caesar init --force", which will detect them.`;
    }
  }

  if (request && request.setup.length > 0) {
    const setup = await runSetup(handle.path, request.setup, input.signal);
    if (setup.failure) {
      // Outright failure, with the output attached: the message must be
      // enough to understand without rerunning the command by hand.
      throw new Error(
        `Task "${taskId}": the worktree setup command failed — "${setup.failure.command}" ` +
          `(code ${setup.failure.exitCode ?? "unknown"}).\n${setup.failure.output}\n` +
          `Fix the command under [worktree] setup in ".caesar/config.toml", or remove it.`,
      );
    }
  }

  // `warning` may be defined here: see C3 of the final review, the case where
  // `mustForceWorktree` contradicts an explicitly requested isolation. Without
  // propagating it, this last `return` — the only exit path once
  // `isolation === "worktree"` — would silently lose it, even though
  // the report must carry a trace of it (`withFinding`, higher up in
  // `runTask`).
  return {
    isolation,
    warning,
    handle,
    worktreeWasPossible: true,
    ...(materialization ? { materialization } : {}),
    ...(missingSection ? { missingSection } : {}),
    ...(gitignoreWarning ? { gitignoreWarning } : {}),
  };
}
