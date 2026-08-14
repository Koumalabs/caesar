import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPORT_PROTOCOL, TASK_PROTOCOL, TaskSchema, readEvents, readReport, taskPaths, writeTask } from "@caesar/protocol";
import type { Task } from "@caesar/protocol";
import { writeAnswer } from "./mailbox.js";
import { askOrchestrator, buildChannelServer, getTask, reportProgress, submitReport } from "./server.js";

async function writeSampleTask(taskDir: string, overrides: Partial<Task> = {}): Promise<Task> {
  const task = TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_channel",
    created_at: new Date().toISOString(),
    agent: "codex",
    objective: "Fix the regression",
    mode: "write",
    isolation: "inplace",
    workspace: taskDir,
    deadline_ms: 600_000,
    report_path: join(taskDir, "report.json"),
    events_path: join(taskDir, "events.jsonl"),
    ...overrides,
  });
  await writeTask(taskPaths(taskDir), task);
  return task;
}

describe("channel tools — direct call", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await mkdtemp(join(tmpdir(), "caesar-channel-"));
  });

  afterEach(async () => {
    await rm(taskDir, { recursive: true, force: true });
  });

  it("get_task re-reads task.json and returns it", async () => {
    await writeSampleTask(taskDir);
    const result = await getTask(taskDir);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { objective: string }).objective).toBe("Fix the regression");
  });

  it("report_progress writes a `progress` event to events.jsonl", async () => {
    await writeSampleTask(taskDir);
    const result = await reportProgress(taskDir, { message: "halfway there", pct: 50 });
    expect(result.isError).toBeFalsy();

    const events = await readEvents(taskPaths(taskDir));
    expect(events).toEqual([expect.objectContaining({ type: "progress", message: "halfway there", pct: 50 })]);
  });

  it("submit_report validates and writes report.json", async () => {
    await writeSampleTask(taskDir);
    const result = await submitReport(taskDir, {
      protocol: REPORT_PROTOCOL,
      task_id: "t_channel",
      status: "success",
      summary: "Done.",
      details: "",
      changes: [],
      commands_run: [],
      findings: [],
      questions: [],
      next_steps: [],
      artifacts: [],
    });
    expect(result.isError).toBeFalsy();

    const report = await readReport(taskPaths(taskDir));
    expect(report?.status).toBe("success");
    expect(report?.summary).toBe("Done.");
  });

  it("ask_orchestrator: nominal case, the answer written during the wait is returned", async () => {
    await writeSampleTask(taskDir);
    const askPromise = askOrchestrator(
      taskDir,
      { question: "Which branch?", options: ["main", "dev"] },
      { askTimeoutMs: 5_000, pollIntervalMs: 20 },
    );

    // Simulates `caesar_answer`, which would run in another process in
    // practice: waits for the question to be dropped off, then answers it.
    let questionId: string | undefined;
    for (let i = 0; i < 100 && !questionId; i++) {
      const entries = await readdir(join(taskDir, "questions")).catch(() => []);
      questionId = entries[0]?.replace(/\.json$/, "");
      if (!questionId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(questionId).toBeDefined();
    await writeAnswer(taskDir, { id: questionId!, answer: "dev", answered_at: new Date().toISOString() });

    const result = await askPromise;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: questionId, answered: true, answer: "dev" });

    const events = await readEvents(taskPaths(taskDir));
    expect(events.some((event) => event.type === "question")).toBe(true);
  });

  it("ask_orchestrator: timeout expiry, returns an instruction to proceed rather than an error", async () => {
    await writeSampleTask(taskDir);
    const startedAt = Date.now();
    const result = await askOrchestrator(taskDir, { question: "Which branch?" }, { askTimeoutMs: 100, pollIntervalMs: 20 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { answered: boolean; message: string };
    expect(data.answered).toBe(false);
    expect(data.message).toMatch(/best judgment/i);
  });

  it("ask_orchestrator: the timeout never exceeds what remains of the task budget", async () => {
    // Very short deadline_ms: the remaining budget expires almost
    // immediately, well before the (long) explicitly requested timeout.
    await writeSampleTask(taskDir, { deadline_ms: 50 });
    const startedAt = Date.now();
    const result = await askOrchestrator(taskDir, { question: "?" }, { askTimeoutMs: 5_000, pollIntervalMs: 20 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((result.structuredContent as { answered: boolean }).answered).toBe(false);
  });
});

describe("buildChannelServer over the stdio transport", () => {
  let taskDir: string;

  beforeEach(async () => {
    taskDir = await mkdtemp(join(tmpdir(), "caesar-channel-transport-"));
    await writeSampleTask(taskDir);
  });

  afterEach(async () => {
    await rm(taskDir, { recursive: true, force: true });
  });

  it("exposes exactly the four tools promised to the agent", async () => {
    const server = buildChannelServer(taskDir);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    await server.connect(new StdioServerTransport(stdin, stdout));

    const listResponse = await callAndRead(stdin, stdout, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = (listResponse.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual(["ask_orchestrator", "get_task", "report_progress", "submit_report"]);

    await server.close();
    stdin.end();
  });

  it("submit_report: invalid report rejected with a message naming the offending field, resubmission after fixing", async () => {
    const server = buildChannelServer(taskDir);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    await server.connect(new StdioServerTransport(stdin, stdout));

    const invalidCall = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "submit_report", arguments: { protocol: REPORT_PROTOCOL, task_id: "t_channel", status: "success" } },
    };
    const firstResponse = await callAndRead(stdin, stdout, invalidCall);
    expect(firstResponse.result.isError).toBe(true);
    expect(firstResponse.result.content[0].text).toMatch(/summary/);
    expect(await readReport(taskPaths(taskDir))).toBeNull();

    const validCall = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submit_report", arguments: { protocol: REPORT_PROTOCOL, task_id: "t_channel", status: "success", summary: "Fixed." } },
    };
    const secondResponse = await callAndRead(stdin, stdout, validCall);
    expect(secondResponse.result.isError).toBeFalsy();
    const report = await readReport(taskPaths(taskDir));
    expect(report?.summary).toBe("Fixed.");

    await server.close();
    stdin.end();
  });
});

function nextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        stream.off("data", onData);
        resolve(buffer.slice(0, newline));
      }
    };
    stream.on("data", onData);
  });
}

interface JsonRpcCallResponse {
  result: {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    tools?: Array<{ name: string }>;
  };
}

async function callAndRead(stdin: PassThrough, stdout: PassThrough, request: Record<string, unknown>): Promise<JsonRpcCallResponse> {
  const responsePromise = nextLine(stdout);
  stdin.write(JSON.stringify(request) + "\n");
  const line = await responsePromise;
  return JSON.parse(line) as JsonRpcCallResponse;
}
