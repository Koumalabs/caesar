#!/usr/bin/env node
/**
 * Fake external agent, used by the execution engine's tests.
 *
 * It depends on no package of the monorepo: that is deliberate. A real
 * external agent would know nothing of this implementation, only the
 * minimal contract documented by `@caesar/protocol` — read `$CAESAR_TASK_FILE`,
 * write `$CAESAR_REPORT_PATH`. This script proves that contract is enough: if
 * it can be orchestrated on par with Codex or Antigravity, any external
 * CLI can be too.
 *
 * Its behavior is driven by `task.context`, an optional JSON of the
 * following shape (every field has a default value):
 *
 * {
 *   "mode": "success" | "fail" | "silent" | "hang" | "ask",
 *   "exitCode": 0,
 *   "files": [{ "path": "relative/to/workspace.txt", "content": "…" }],
 *   "declaredChanges": [{ "path": "…", "action": "modified", "summary": "…" }],
 *   "writeReport": true,
 *   "status": "success",
 *   "summary": "…",
 *   "sleepMs": 86400000,
 *   "ignoreSigterm": false,
 *   "finalMessage": "…",
 *   "question": "…",
 *   "options": ["…"]
 * }
 *
 * - "success" (default): writes the declared `files`, a valid report.
 * - "fail": exits with a non-zero code (1 by default); still writes a
 *   report unless `writeReport` is false.
 * - "silent": never writes a report, whatever `writeReport` says —
 *   simulates an agent ignoring the contract, to exercise synthesis.
 * - "hang": never does anything more than wait `sleepMs` (default: one
 *   day, in practice indefinitely), to exercise the timeout and
 *   cancellation. With `ignoreSigterm`, installs a handler that absorbs
 *   SIGTERM, to exercise the escalation to SIGKILL.
 * - "ask" (task 9, return channel): if `task.channel` is set, connects
 *   to `caesar-channel` as an MCP client (see
 *   `@modelcontextprotocol/sdk/client`), calls `ask_orchestrator` with
 *   `question`/`options`, then `submit_report` with a summary that
 *   literally reports the answer received — this is what lets a test
 *   verify the answer made the round trip, not merely that the channel
 *   answered something. If `task.channel` is absent (channel not enabled
 *   for this task), silently degrades to writing `report.json` directly,
 *   exactly like the "success" mode: that is the expected behavior of a
 *   real agent that would ignore the channel (see the fallback
 *   instruction documented by `renderTaskPrompt`).
 *
 * In the three modes "success", "fail", "silent", `sleepMs`, if provided
 * explicitly, delays processing by that much before writing the report
 * (default: no pause) — useful to prove a caller awaits several tasks in
 * parallel without the joint wait costing the sum of their delays (see
 * `packages/mcp-server/src/tools/await.test.ts`).
 *
 * `declaredChanges`, when provided, replaces the report's `changes`
 * declaration independently of the `files` actually written — enough to
 * simulate a lying agent, in both directions (file kept quiet, file made
 * up), to exercise `reconcileChanges`.
 *
 * `finalMessage`, when provided, simulates a CLI whose `capabilities.finalMessageFile`
 * is true (Codex with `-o`, for instance): the message is written as is
 * into `final-message.txt`, under the task's directory. This script
 * receives that path through no dedicated token — `GenericAgentSpec` (task 3)
 * provides none for a generic CLI — but finds it itself under
 * `$CAESAR_TASK_DIR`, exactly as the runner computes it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const REPORT_PROTOCOL = "caesar.report/v1";
const FINAL_MESSAGE_FILE_NAME = "final-message.txt";

function log(kind, message) {
  process.stdout.write(JSON.stringify({ kind, message }) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "ask" mode: the full round trip of the return channel (task 9). Always
 * writes `report.json`, either via `submit_report` (channel available) or
 * directly (degradation, channel absent) — never both.
 *
 * The MCP SDK is imported only here, dynamically: the other modes have no
 * need for it, and this script stays free of any monorepo package
 * dependency (see the header) — only `@modelcontextprotocol/sdk`, a
 * third-party package, just as a real external agent would embed one to
 * speak MCP.
 */
async function handleAskMode(task, directive, reportPath) {
  const baseSummary = directive.summary ?? "Handled.";
  const channel = task.channel;

  if (!channel) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          protocol: REPORT_PROTOCOL,
          task_id: task.id,
          status: "success",
          summary: `${baseSummary} (channel unavailable, question not asked)`,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    return;
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({ command: channel.command, args: channel.args });
  const client = new Client({ name: "fake-agent", version: "0.0.0" });
  await client.connect(transport);

  const asked = await client.callTool({
    name: "ask_orchestrator",
    arguments: { question: directive.question ?? "What color?", options: directive.options ?? [] },
  });
  const askedData = asked.structuredContent ?? {};
  const answerText = askedData.answered ? askedData.answer : `(no answer) ${askedData.message ?? ""}`;

  await client.callTool({
    name: "submit_report",
    arguments: {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: "success",
      summary: `${baseSummary} Answer received: ${answerText}`,
    },
  });

  await client.close();
}

async function main() {
  const taskFile = process.env["CAESAR_TASK_FILE"];
  const reportPath = process.env["CAESAR_REPORT_PATH"];
  if (!taskFile || !reportPath) {
    process.stderr.write("fake-agent: CAESAR_TASK_FILE / CAESAR_REPORT_PATH missing\n");
    process.exitCode = 1;
    return;
  }

  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  let directive = {};
  try {
    directive = JSON.parse(task.context);
  } catch {
    // task.context is not a steering JSON: default behavior.
  }

  const mode = directive.mode ?? "success";
  const files = directive.files ?? [];
  const sleepMs = directive.sleepMs ?? 86_400_000;
  const writeReport = directive.writeReport ?? true;

  if (directive.ignoreSigterm) {
    process.on("SIGTERM", () => {
      // Deliberately absorbs the signal, to force the engine to escalate to SIGKILL.
    });
  }

  log("progress", "starting");

  if (mode === "hang") {
    log("progress", "waiting indefinitely");
    await sleep(sleepMs);
    // Never reached in practice: the process is terminated before.
    return;
  }

  if (mode === "ask") {
    log("progress", "question");
    await handleAskMode(task, directive, reportPath);
    log("progress", "done");
    process.exitCode = directive.exitCode ?? 0;
    return;
  }

  if (directive.sleepMs !== undefined) {
    await sleep(directive.sleepMs);
  }

  log("progress", "processing");

  for (const file of files) {
    const target = isAbsolute(file.path) ? file.path : join(task.workspace, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content ?? "", "utf8");
  }

  if (directive.finalMessage !== undefined) {
    const taskDir = process.env["CAESAR_TASK_DIR"];
    writeFileSync(join(taskDir, FINAL_MESSAGE_FILE_NAME), directive.finalMessage, "utf8");
  }

  const exitCode = directive.exitCode ?? (mode === "fail" ? 1 : 0);

  if (mode !== "silent" && writeReport) {
    const changes = directive.declaredChanges ?? files.map((file) => ({ path: file.path, action: "created", summary: "" }));
    const report = {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: directive.status ?? (mode === "fail" ? "failed" : "success"),
      summary: directive.summary ?? "Task handled by the fake agent.",
      changes,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  log("progress", "done");
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`fake-agent: unexpected error: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
