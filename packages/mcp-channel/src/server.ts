/**
 * Le serveur MCP exposé au sous-agent par `orch-channel` : quatre tools qui
 * transforment la délégation en dialogue — voir le brief de la tâche 9.
 *
 * Chaque tool lit ou écrit exclusivement sous `taskDir`, le répertoire de la
 * tâche transmis en argument à `orch-channel` (voir `bin.ts`) : ce processus
 * ne partage aucune mémoire avec l'agent principal, tout passe par le
 * système de fichiers, exactement comme le reste du standard.
 *
 * Chaque handler est exporté séparément de son `registerXxx` pour rester
 * testable sans transport (voir `packages/mcp-server`, dont c'est déjà la
 * convention) : seul `server.test.ts` a besoin d'un vrai transport stdio,
 * là où le transport lui-même est en jeu.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Report } from "@orch/protocol";
import { ReportSchema, appendEvent, makeEvent, readEvents, readTask, taskPaths, writeReport } from "@orch/protocol";
import type { TaskPaths } from "@orch/protocol";
import { waitForAnswer, writeQuestion } from "./mailbox.js";

const SERVER_NAME = "orch-channel";
const SERVER_VERSION = "0.1.0";

export const GET_TASK = "get_task";
export const REPORT_PROGRESS = "report_progress";
export const ASK_ORCHESTRATOR = "ask_orchestrator";
export const SUBMIT_REPORT = "submit_report";

/** Cinq minutes par défaut (voir le brief) : assez long pour laisser l'agent principal répondre, jamais indéfini. */
export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60_000;
/** Intervalle de scrutation de `answers/<id>.json`. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface ChannelServerOptions {
  /** Délai par défaut de `ask_orchestrator`, en millisecondes — configurable, voir le brief. */
  askTimeoutMs?: number;
  /** Intervalle de scrutation de la réponse — configurable pour que les tests restent rapides. */
  pollIntervalMs?: number;
}

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/**
 * Prochain numéro d'ordre pour un événement émis par ce processus. `seq` ne
 * sert qu'à l'affichage (`orch logs`) — jamais à trier ni à dédupliquer,
 * voir `packages/protocol/src/event.ts` et les usages de `event.seq` dans
 * `packages/cli/src/commands/tasks.ts` — donc relire le journal existant à
 * chaque appel (peu fréquent, journal court) suffit, sans coordination avec
 * le compteur du processus principal qui écrit par ailleurs sur le même
 * fichier. Même méthode, dupliquée faute d'un point d'export commun, côté
 * `orch_answer` (`@orch/mcp-server`), qui écrit sur ce même journal depuis
 * l'autre bout du canal.
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
        "log, visible to the orchestrator via orch_status/orch_logs.",
      inputSchema: reportProgressInputShape,
    },
    (args) => reportProgress(taskDir, args),
  );
}

const askOrchestratorInputShape = {
  question: z.string().min(1).describe("The question to ask, self-contained — the orchestrator has no access to your conversation."),
  options: z.array(z.string()).optional().describe("Optional multiple-choice options, if the answer is one of a known set."),
};

/** Ce qu'il reste du budget de la tâche, en millisecondes — jamais négatif. `ask_orchestrator` n'attend jamais plus longtemps que ça (voir le brief). */
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
        "discover it via orch_status/orch_await; this call then blocks until an answer arrives or a timeout " +
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
      // Réutilise le shape de `ReportSchema` tel quel plutôt que de le
      // reformuler (voir la contrainte globale n°6) : la validation immédiate
      // — y compris le message nommant le champ fautif — est alors assurée
      // par le SDK MCP lui-même, avant même que ce handler ne soit invoqué.
      inputSchema: ReportSchema.shape,
    },
    (args) => submitReport(taskDir, args),
  );
}

/** Construit le serveur MCP branché sur `taskDir`, prêt à être connecté à un transport (voir `bin.ts`). */
export function buildChannelServer(taskDir: string, options: ChannelServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerGetTask(server, taskDir);
  registerReportProgress(server, taskDir);
  registerAskOrchestrator(server, taskDir, options);
  registerSubmitReport(server, taskDir);
  return server;
}
