/**
 * The MCP server exposed to the subagent by `caesar-channel`: four tools that
 * turn the delegation into a dialogue — see the task 9 brief.
 *
 * Each tool reads or writes exclusively under `taskDir`, the task directory
 * passed as an argument to `caesar-channel` (see `bin.ts`): this process
 * shares no memory with the main agent, everything goes through the
 * filesystem, exactly like the rest of the standard.
 *
 * Each handler is exported separately from its `registerXxx` to remain
 * testable without a transport (see `packages/mcp-server`, where this is
 * already the convention): only `server.test.ts` needs a real stdio
 * transport, where the transport itself is what is being tested.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Report } from "@caesar/protocol";
import { ReportSchema, appendEvent, makeEvent, readEvents, readTask, taskPaths, writeReport } from "@caesar/protocol";
import type { TaskPaths } from "@caesar/protocol";
import { waitForAnswer, writeQuestion } from "./mailbox.js";

const SERVER_NAME = "caesar-channel";
const SERVER_VERSION = "0.1.0";

export const GET_TASK = "get_task";
export const REPORT_PROGRESS = "report_progress";
export const ASK_ORCHESTRATOR = "ask_orchestrator";
export const SUBMIT_REPORT = "submit_report";

/** Five minutes by default (see the brief): long enough to let the main agent answer, never unbounded. */
export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;
/** Polling interval for `answers/<id>.json`. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface ChannelServerOptions {
  /** Default `ask_orchestrator` timeout, in milliseconds — configurable, see the brief. */
  askTimeoutMs?: number;
  /** Polling interval for the answer — configurable so tests stay fast. */
  pollIntervalMs?: number;
}

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/**
 * Next sequence number for an event emitted by this process. `seq` is only
 * used for display (`caesar logs`) — never for sorting or deduplication, see
 * `packages/protocol/src/event.ts` and the uses of `event.seq` in
 * `packages/cli/src/commands/tasks.ts` — so re-reading the existing log on
 * every call (infrequent, short log) is enough, with no coordination with
 * the main process's counter, which also writes to the same file. Same
 * method, duplicated for lack of a shared export point, on the
 * `caesar_answer` side (`@caesar/mcp-server`), which writes to this same log
 * from the other end of the channel.
 */
async function nextSeq(paths: TaskPaths): Promise<number> {
  const events = await readEvents(paths);
  return events.length;
}

export async function getTask(taskDir: string): Promise<CallToolResult> {
  const task = await readTask(taskPaths(taskDir));
  return jsonResult({ ...task });
}

function registerGetTask(server: McpServer, taskDir: string): void {
  server.registerTool(
    GET_TASK,
    {
      description:
        "Re-read this task's mission from task.json and return it verbatim: objective, context, constraints, " +
        "acceptance criteria, mode, workspace, deadline. Use this to recover the mission without depending on " +
        "your own context window.",
    },
    () => getTask(taskDir),
  );
}

const reportProgressInputShape = {
  message: z.string().min(1).describe("Short, human-readable progress update."),
  pct: z.number().min(0).max(100).optional().describe("Optional completion estimate, 0-100."),
};

export async function reportProgress(taskDir: string, args: { message: string; pct?: number }): Promise<CallToolResult> {
  const paths = taskPaths(taskDir);
  const task = await readTask(paths);
  const seq = await nextSeq(paths);
  await appendEvent(paths, makeEvent(task.id, seq, "progress", { message: args.message, pct: args.pct }));
  return jsonResult({ ok: true });
}

function registerReportProgress(server: McpServer, taskDir: string): void {
  server.registerTool(
    REPORT_PROGRESS,
    {
      description:
        "Report progress on the current task without ending it. Appends a progress event to this task's event " +
        "log, visible to the orchestrator via caesar_status/caesar_logs.",
      inputSchema: reportProgressInputShape,
    },
    (args) => reportProgress(taskDir, args),
  );
}

const askOrchestratorInputShape = {
  question: z.string().min(1).describe("The question to ask, self-contained — the orchestrator has no access to your conversation."),
  options: z.array(z.string()).optional().describe("Optional multiple-choice options, if the answer is one of a known set."),
};

/** What remains of the task's budget, in milliseconds — never negative. `ask_orchestrator` never waits longer than that (see the brief). */
function remainingBudgetMs(task: { deadline_ms: number; created_at: string }): number {
  const elapsed = Date.now() - Date.parse(task.created_at);
  return Math.max(0, task.deadline_ms - elapsed);
}

export async function askOrchestrator(
  taskDir: string,
  args: { question: string; options?: string[] },
  serverOptions: ChannelServerOptions = {},
): Promise<CallToolResult> {
  const paths = taskPaths(taskDir);
  const task = await readTask(paths);
  const askOptions = args.options ?? [];

  const id = randomUUID();
  const askedAt = new Date().toISOString();
  await writeQuestion(taskDir, { id, question: args.question, options: askOptions, asked_at: askedAt });

  const seq = await nextSeq(paths);
  await appendEvent(paths, makeEvent(task.id, seq, "question", { id, question: args.question, options: askOptions }));

  const askTimeoutMs = serverOptions.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const pollIntervalMs = serverOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const effectiveTimeoutMs = Math.min(askTimeoutMs, remainingBudgetMs(task));

  const answer = await waitForAnswer(taskDir, id, effectiveTimeoutMs, pollIntervalMs);
  if (!answer) {
    return jsonResult({
      id,
      answered: false,
      message: "No answer arrived in time. Proceed using your own best judgment — do not keep waiting on this question.",
    });
  }
  return jsonResult({ id, answered: true, answer: answer.answer });
}

function registerAskOrchestrator(server: McpServer, taskDir: string, serverOptions: ChannelServerOptions): void {
  server.registerTool(
    ASK_ORCHESTRATOR,
    {
      description:
        "Ask the orchestrator — the main agent that delegated this task — a question, and wait for its answer. " +
        "The question (and optional multiple-choice `options`) is recorded immediately, so the orchestrator can " +
        "discover it via caesar_status/caesar_await; this call then blocks until an answer arrives or a timeout " +
        `elapses (default ${Math.round(DEFAULT_ASK_TIMEOUT_MS / 60_000)} minutes, never longer than what is left ` +
        "of this task's own deadline). If nobody answers in time, this returns normally (not an error) with an " +
        "instruction to proceed using your own best judgment.",
      inputSchema: askOrchestratorInputShape,
    },
    (args) => askOrchestrator(taskDir, args, serverOptions),
  );
}

export async function submitReport(taskDir: string, args: Report): Promise<CallToolResult> {
  await writeReport(taskPaths(taskDir), args);
  return jsonResult({ ok: true, task_id: args.task_id });
}

function registerSubmitReport(server: McpServer, taskDir: string): void {
  server.registerTool(
    SUBMIT_REPORT,
    {
      description:
        "Submit the final report for this task, validated immediately against the report schema — protocol, " +
        "status and summary are required, everything else is optional. On success the report is written and " +
        "this should be your last action. On an invalid report, the call fails naming the offending field(s); " +
        "fix them and call submit_report again.",
      // Reuses the `ReportSchema` shape as-is rather than restating it (see
      // global constraint #6): immediate validation — including the message
      // naming the offending field — is then handled by the MCP SDK itself,
      // before this handler is even invoked.
      inputSchema: ReportSchema.shape,
    },
    (args) => submitReport(taskDir, args),
  );
}

/** Builds the MCP server wired to `taskDir`, ready to be connected to a transport (see `bin.ts`). */
export function buildChannelServer(taskDir: string, options: ChannelServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerGetTask(server, taskDir);
  registerReportProgress(server, taskDir);
  registerAskOrchestrator(server, taskDir, options);
  registerSubmitReport(server, taskDir);
  return server;
}
