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
    objective: "Corriger la régression",
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
    summary: "résumé",
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

  it("palier 1, source \"file\" : report.json présent, aucun canal configuré", async () => {
    await writeReport(paths, minimalReport({ summary: "écrit par fichier" }));
    const resolved = await resolveReport({ task: sampleTask(), paths, run: sampleRun() });
    expect(resolved.source).toBe("file");
    expect(resolved.report.summary).toBe("écrit par fichier");
  });

  it("palier 1, source \"channel\" : report.json présent, un canal était configuré", async () => {
    await writeReport(paths, minimalReport());
    const task = sampleTask({
      channel: { transport: "mcp-stdio", command: "caesar-channel", args: [], server_name: "caesar" },
    });
    const resolved = await resolveReport({ task, paths, run: sampleRun() });
    expect(resolved.source).toBe("channel");
  });

  it("palier 2, source \"schema\" : rapport dans le texte final, palier retenu \"schema\"", async () => {
    const embedded = minimalReport({ summary: "rapport en sortie structurée" });
    const run = sampleRun({ finalText: JSON.stringify(embedded) });
    const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "schema" });
    expect(resolved.source).toBe("schema");
    expect(resolved.report.summary).toBe("rapport en sortie structurée");
  });

  it("palier 2, source \"extracted\" : rapport dans le texte final, mais palier retenu \"file\"", async () => {
    const embedded = minimalReport({ summary: "l'agent devait écrire un fichier, il a parlé à la place" });
    const run = sampleRun({ finalText: JSON.stringify(embedded) });
    const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "file" });
    expect(resolved.source).toBe("extracted");
  });

  describe("palier 2, fichier de message final", () => {
    it("source \"schema\" quand le palier retenu est \"schema\"", async () => {
      const embedded = minimalReport({ summary: "déposé par le CLI dans final-message.txt" });
      await mkdir(paths.dir, { recursive: true });
      const finalMessageFile = join(paths.dir, "final-message.txt");
      await writeFile(finalMessageFile, JSON.stringify(embedded), "utf8");

      const resolved = await resolveReport({ task: sampleTask(), paths, run: sampleRun(), reportVia: "schema", finalMessageFile });
      expect(resolved.source).toBe("schema");
      expect(resolved.report.summary).toBe("déposé par le CLI dans final-message.txt");
    });

    it("l'emporte sur un finalText de stdout divergent : plus fiable, consulté en premier", async () => {
      const fromFile = minimalReport({ summary: "la bonne réponse, déposée par le CLI" });
      const fromStdout = minimalReport({ summary: "une reconstitution stdout qui diverge" });
      await mkdir(paths.dir, { recursive: true });
      const finalMessageFile = join(paths.dir, "final-message.txt");
      await writeFile(finalMessageFile, JSON.stringify(fromFile), "utf8");

      const run = sampleRun({ finalText: JSON.stringify(fromStdout) });
      const resolved = await resolveReport({ task: sampleTask(), paths, run, reportVia: "file", finalMessageFile });

      expect(resolved.report.summary).toBe("la bonne réponse, déposée par le CLI");
      expect(resolved.source).toBe("extracted");
    });

    it("absent ou illisible : se rabat sur le finalText de stdout", async () => {
      const embedded = minimalReport({ summary: "repli sur stdout" });
      const run = sampleRun({ finalText: JSON.stringify(embedded) });
      const resolved = await resolveReport({
        task: sampleTask(),
        paths,
        run,
        finalMessageFile: join(paths.dir, "n-existe-pas.txt"),
      });
      expect(resolved.report.summary).toBe("repli sur stdout");
    });
  });

  it("palier 3, source \"extracted\" : rapport noyé dans raw.log, absent de finalText", async () => {
    const embedded = minimalReport({ summary: "rapport retrouvé dans le journal brut" });
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.rawLog, `bruit avant\n${JSON.stringify(embedded)}\nbruit après\n`, "utf8");
    const run = sampleRun({ finalText: "juste un message, pas de rapport ici" });
    const resolved = await resolveReport({ task: sampleTask(), paths, run });
    expect(resolved.source).toBe("extracted");
    expect(resolved.report.summary).toBe("rapport retrouvé dans le journal brut");
  });

  describe("palier 4, synthèse", () => {
    it("échec : code de sortie non nul", async () => {
      const run = sampleRun({ exitCode: 1 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.source).toBe("synthesized");
      expect(resolved.report.status).toBe("failed");
    });

    it("échec : timeout", async () => {
      const run = sampleRun({ exitCode: null, timedOut: true });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.report.status).toBe("failed");
    });

    it("partiel : diff non vide sans rapport", async () => {
      const run = sampleRun({ exitCode: 0 });
      const diff = sampleDiff([{ path: "a.txt", action: "modified", summary: "" }]);
      const resolved = await resolveReport({ task: sampleTask(), paths, run, diff });
      expect(resolved.report.status).toBe("partial");
      expect(resolved.report.changes).toEqual(diff.files);
    });

    it("succès : code de sortie nul, diff vide ou absent", async () => {
      const run = sampleRun({ exitCode: 0 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run, diff: sampleDiff([]) });
      expect(resolved.report.status).toBe("success");
    });

    it("résumé bâti depuis les dernières lignes utiles de raw.log, à défaut de finalText", async () => {
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.rawLog, "ligne 1\nligne 2\nligne finale utile\n", "utf8");
      const run = sampleRun({ exitCode: 0 });
      const resolved = await resolveReport({ task: sampleTask(), paths, run });
      expect(resolved.report.summary).toContain("ligne finale utile");
    });
  });
});

describe("reconcileChanges", () => {
  it("remplace changes par le diff git, qui fait foi", () => {
    const report = minimalReport({ changes: [{ path: "a.txt", action: "modified", summary: "déclaré" }] });
    const diff = sampleDiff([{ path: "a.txt", action: "modified", summary: "" }]);
    const result = reconcileChanges(report, diff);
    expect(result.changes).toEqual(diff.files);
  });

  it("signale un fichier modifié que l'agent n'a pas déclaré", () => {
    const report = minimalReport({ changes: [] });
    const diff = sampleDiff([{ path: "oublie.txt", action: "modified", summary: "" }]);
    const result = reconcileChanges(report, diff);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "medium", file: "oublie.txt" }),
    ]);
    expect(result.findings[0]!.detail).toContain("oublie.txt");
  });

  it("signale un fichier déclaré que git ne voit pas modifié", () => {
    const report = minimalReport({ changes: [{ path: "invente.txt", action: "modified", summary: "" }] });
    const diff = sampleDiff([]);
    const result = reconcileChanges(report, diff);
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "medium", file: "invente.txt" }),
    ]);
    expect(result.findings[0]!.detail).toContain("invente.txt");
  });

  it("aucun constat quand la déclaration correspond exactement au diff", () => {
    const changes: Change[] = [{ path: "a.txt", action: "modified", summary: "" }];
    const report = minimalReport({ changes });
    const result = reconcileChanges(report, sampleDiff(changes));
    expect(result.findings).toEqual([]);
  });

  it("conserve les constats déjà présents dans le rapport", () => {
    const existing = { severity: "info" as const, title: "déjà là", detail: "" };
    const report = minimalReport({ changes: [], findings: [existing] });
    const result = reconcileChanges(report, sampleDiff([]));
    expect(result.findings).toEqual([existing]);
  });
});
