import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REPORT_PROTOCOL,
  TASK_PROTOCOL,
  TaskSchema,
  taskPaths,
  writeReport,
  type Change,
  type Report,
  type Task,
  type TaskPaths,
} from "@caesar/protocol";
import { reconcileChanges, resolveReport } from "./report.js";
import type { RunResult } from "./spawn.js";
import type { WorktreeDiff } from "./worktree.js";

function sampleTask(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_report_test",
    created_at: "2026-08-09T10:00:00.000Z",
    agent: "fake",
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

function sampleRun(overrides: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, eventCount: 0, durationMs: 10, ...overrides };
}

function sampleDiff(files: Change[] = []): WorktreeDiff {
  return { files, patch: "", isEmpty: files.length === 0 };
}

function minimalReport(overrides: Partial<Report> = {}): Report {
  return {
    protocol: REPORT_PROTOCOL,
    task_id: "t_report_test",
    status: "success",
    summary: "summary",
    details: "",
    changes: [],
    commands_run: [],
    findings: [],
    questions: [],
    next_steps: [],
    artifacts: [],
    ...overrides,
  };
}

describe("resolveReport", () => {
  let dir: string;
  let paths: TaskPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "caesar-report-"));
    paths = taskPaths(join(dir, "task"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tier 1, source \"file\": report.json present, no channel configured", async () => {
    await writeReport(paths, minimalReport({ summary: "written via file" }));
    const resolved = await resolveReport({ task: sampleTask(), paths, run: sampleRun() });
    expect(resolved.source).toBe("file");
    expect(resolved.report.summary).toBe("written via file");
  });

  it("tier 1, source \"channel\": report.json present, a channel was configured", async () => {
    await writeReport(paths, minimalReport());
    const task = sampleTask({
      channel: { transport: "mcp-stdio", command: "caesar-channel", args: [], server_name: "caesar" },
    });
    const resolved = await resolveReport({ task, paths, run: sampleRun() });
    expect(resolved.source).toBe("channel");
  });

  it("tier 2, source \"schema\": report in the final text, retained tier \"schema\"", async () => {
    const embedded = minimalReport({ summary: "report via structured output" });
    const run = sampleRun({ finalText: JSON.stringify(embedded) });
    const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "schema" });
    expect(resolved.source).toBe("schema");
    expect(resolved.report.summary).toBe("report via structured output");
  });

  it("tier 2, source \"extracted\": report in the final text, but retained tier \"file\"", async () => {
    const embedded = minimalReport({ summary: "the agent was supposed to write a file, it spoke instead" });
    const run = sampleRun({ finalText: JSON.stringify(embedded) });
    const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "file" });
    expect(resolved.source).toBe("extracted");
  });

  describe("tier 2, final message file", () => {
    it("source \"schema\" when the retained tier is \"schema\"", async () => {
      const embedded = minimalReport({ summary: "deposited by the CLI in final-message.txt" });
      await mkdir(paths.dir, { recursive: true });
      const finalMessageFile = join(paths.dir, "final-message.txt");
      await writeFile(finalMessageFile, JSON.stringify(embedded), "utf8");

      const resolved = await resolveReport({ task: sampleTask(), paths, run: sampleRun(), reportVia: "schema", finalMessageFile });
      expect(resolved.source).toBe("schema");
      expect(resolved.report.summary).toBe("deposited by the CLI in final-message.txt");
    });

    it("wins over a diverging stdout finalText: more reliable, consulted first", async () => {
      const fromFile = minimalReport({ summary: "the right answer, deposited by the CLI" });
      const fromStdout = minimalReport({ summary: "a diverging stdout reconstitution" });
      await mkdir(paths.dir, { recursive: true });
      const finalMessageFile = join(paths.dir, "final-message.txt");
      await writeFile(finalMessageFile, JSON.stringify(fromFile), "utf8");

      const run = sampleRun({ finalText: JSON.stringify(fromStdout) });
      const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "file", finalMessageFile });

      expect(resolved.report.summary).toBe("the right answer, deposited by the CLI");
      expect(resolved.source).toBe("extracted");
    });

    it("absent or unreadable: falls back to the stdout finalText", async () => {
      const embedded = minimalReport({ summary: "fallback to stdout" });
      const run = sampleRun({ finalText: JSON.stringify(embedded) });
      const resolved = await resolveReport({
        task: sampleTask(),
        paths,
        run,
        finalMessageFile: join(paths.dir, "does-not-exist.txt"),
      });
      expect(resolved.report.summary).toBe("fallback to stdout");
    });
  });

  it("tier 3, source \"extracted\": report buried in raw.log, absent from finalText", async () => {
    const embedded = minimalReport({ summary: "report found in the raw log" });
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.rawLog, `noise before\n${JSON.stringify(embedded)}\nnoise after\n`, "utf8");
    const run = sampleRun({ finalText: "just a message, no report here" });
    const resolved = await resolveReport({ task: sampleTask(), paths, run });
    expect(resolved.source).toBe("extracted");
    expect(resolved.report.summary).toBe("report found in the raw log");
  });

  describe("tier 4, synthesis", () => {
    it("failure: non-zero exit code", async () => {
      const run = sampleRun({ exitCode: 1 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.source).toBe("synthesized");
      expect(resolved.report.status).toBe("failed");
    });

    it("failure: timeout", async () => {
      const run = sampleRun({ exitCode: null, timedOut: true });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.report.status).toBe("failed");
    });

    it("partial: non-empty diff without a report", async () => {
      const run = sampleRun({ exitCode: 0 });
      const diff = sampleDiff([{ path: "a.txt", action: "modified", summary: "" }]);
      const resolved = await resolveReport({ task: sampleTask(), paths, run, diff });
      expect(resolved.report.status).toBe("partial");
      expect(resolved.report.changes).toEqual(diff.files);
    });

    it("success: zero exit code, empty or absent diff", async () => {
      const run = sampleRun({ exitCode: 0 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run, diff: sampleDiff([]) });
      expect(resolved.report.status).toBe("success");
    });

    it("summary built from the last useful lines of raw.log, failing a finalText", async () => {
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.rawLog, "line 1\nline 2\nfinal useful line\n", "utf8");
      const run = sampleRun({ exitCode: 0 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.report.summary).toContain("final useful line");
    });
  });
});

describe("reconcileChanges", () => {
  it("replaces changes with the git diff, which is the source of truth", () => {
    const report = minimalReport({ changes: [{ path: "a.txt", action: "modified", summary: "declared" }] });
    const diff = sampleDiff([{ path: "a.txt", action: "modified", summary: "" }]);
    const result = reconcileChanges(report, diff);
    expect(result.changes).toEqual(diff.files);
  });

  it("flags a modified file the agent did not declare", () => {
    const report = minimalReport({ changes: [] });
    const diff = sampleDiff([{ path: "forgotten.txt", action: "modified", summary: "" }]);
    const result = reconcileChanges(report, diff);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "medium", file: "forgotten.txt" }),
    ]);
    expect(result.findings[0]!.detail).toContain("forgotten.txt");
  });

  it("flags a declared file that git does not see modified", () => {
    const report = minimalReport({ changes: [{ path: "invented.txt", action: "modified", summary: "" }] });
    const diff = sampleDiff([]);
    const result = reconcileChanges(report, diff);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "medium", file: "invented.txt" }),
    ]);
    expect(result.findings[0]!.detail).toContain("invented.txt");
  });

  it("no finding when the declaration matches the diff exactly", () => {
    const changes: Change[] = [{ path: "a.txt", action: "modified", summary: "" }];
    const report = minimalReport({ changes });
    const result = reconcileChanges(report, sampleDiff(changes));
    expect(result.findings).toEqual([]);
  });

  it("keeps the findings already present in the report", () => {
    const existing = { severity: "info" as const, title: "already there", detail: "" };
    const report = minimalReport({ changes: [], findings: [existing] });
    const result = reconcileChanges(report, sampleDiff([]));
    expect(result.findings).toEqual([existing]);
  });
});
