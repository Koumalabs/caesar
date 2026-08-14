/**
 * Retrieval of a run's report, along four degraded tiers, and
 * reconciliation of what the agent declares it modified with what git
 * observes.
 *
 * Tier 2 (the agent's final text) consults two sources in decreasing
 * order of reliability: first a file the CLI itself deposited
 * (`finalMessageFile`), then, failing that, the text reconstituted by
 * replaying the line-by-line translations of stdout.
 *
 * This is the project's central safeguard: an agent that respects no
 * report contract does not make the orchestrator fail, and an agent that
 * lies about its `changes` never deceives the caller beyond this file.
 */
import { readFile } from "node:fs/promises";
import type { Finding, Report, ReportChannel, ReportStatus, Task, TaskPaths } from "@caesar/protocol";
import { REPORT_PROTOCOL, ReportSchema, extractReportFromText, readReport } from "@caesar/protocol";
import type { ReportSource } from "../store.js";
import type { RunResult } from "./spawn.js";
import type { WorktreeDiff } from "./worktree.js";

export interface ResolvedReport {
  report: Report;
  source: ReportSource;
}

export async function resolveReport(args: {
  task: Task;
  paths: TaskPaths;
  run: RunResult;
  diff?: WorktreeDiff;
  /**
   * Report tier actually retained for this run, chosen upstream by the
   * engine via `agent.preferredReportChannel`.
   *
   * Absent from the signatures listed in the task 4 brief, which moreover
   * gives no other way to carry this information down to here: without it,
   * tier 2 cannot distinguish a report obtained through the *expected*
   * mechanism (`"schema"`) from a report merely *found* in the final text
   * of an agent that was supposed to write a file and did not
   * (`"extracted"`) — two situations the brief nevertheless asks to
   * distinguish. Minimal and documented extension, to confirm in review.
   */
  reportVia?: ReportChannel;
  /**
   * Path of the file where the CLI itself — not the model under sandbox —
   * deposits its final message, when `agent.capabilities.finalMessageFile`
   * is true (see `BuildContext.finalMessageFile`, filled in by the
   * runner). More reliable than `run.finalText`, reconstituted by
   * reassembling the line-by-line translations of stdout: consulted
   * before it.
   */
  finalMessageFile?: string;
}): Promise<ResolvedReport> {
  const { task, paths, run, diff, reportVia, finalMessageFile } = args;

  // Tier 1: MCP channel or file contract, both writing report.json.
  const fromFile = await readReport(paths);
  if (fromFile) {
    return { report: fromFile, source: task.channel ? "channel" : "file" };
  }

  // Tier 2, final message: the CLI itself deposited its last message in a
  // dedicated file — more reliable than a reconstitution from stdout, so
  // consulted first.
  if (finalMessageFile) {
    const fileText = await readTextSafe(finalMessageFile);
    if (fileText.trim() !== "") {
      const extracted = extractReportFromText(fileText);
      if (extracted) {
        return { report: extracted, source: reportVia === "schema" ? "schema" : "extracted" };
      }
    }
  }

  // Tier 2, stdout: the agent's last non-empty final text contains the report.
  if (run.finalText) {
    const extracted = extractReportFromText(run.finalText);
    if (extracted) {
      return { report: extracted, source: reportVia === "schema" ? "schema" : "extracted" };
    }
  }

  // Tier 3: the report is buried somewhere in the complete raw log.
  const rawText = await readTextSafe(paths.rawLog);
  const fromLog = extractReportFromText(rawText);
  if (fromLog) {
    return { report: fromLog, source: "extracted" };
  }

  // Tier 4: no usable report, we synthesize from what we know.
  return { report: synthesize(task, run, diff, rawText), source: "synthesized" };
}

/**
 * Reconciles the `changes` declared by the agent with the observed git diff.
 *
 * The diff is the source of truth: `report.changes` is replaced by the
 * observed truth, and a `finding` names each divergence — a file modified
 * but not declared, or a file declared but that git does not see changed.
 */
export function reconcileChanges(report: Report, diff: WorktreeDiff): Report {
  const declared = new Set(report.changes.map((change) => change.path));
  const actual = new Set(diff.files.map((change) => change.path));

  const findings: Finding[] = [...report.findings];

  for (const change of diff.files) {
    if (!declared.has(change.path)) {
      findings.push({
        severity: "medium",
        title: "Undeclared change",
        file: change.path,
        detail: `The git diff shows "${change.path}" (${change.action}) even though the agent did not mention it in its report.`,
      });
    }
  }

  for (const change of report.changes) {
    if (!actual.has(change.path)) {
      findings.push({
        severity: "medium",
        title: "Change declared but not found in the diff",
        file: change.path,
        detail: `The agent declares it modified "${change.path}" (${change.action}), but git sees no change to that file.`,
      });
    }
  }

  return { ...report, changes: diff.files, findings };
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function synthesize(task: Task, run: RunResult, diff: WorktreeDiff | undefined, rawText: string): Report {
  const status: ReportStatus = deriveStatus(run, diff);
  const summary = buildSummary(run, rawText);

  return ReportSchema.parse({
    protocol: REPORT_PROTOCOL,
    task_id: task.id,
    status,
    summary,
    changes: diff ? diff.files : [],
  });
}

function deriveStatus(run: RunResult, diff: WorktreeDiff | undefined): ReportStatus {
  if (run.timedOut) return "failed";
  if (run.aborted) return "failed";
  if (run.exitCode !== 0) return "failed";
  if (diff && !diff.isEmpty) return "partial";
  return "success";
}

function buildSummary(run: RunResult, rawText: string): string {
  if (run.finalText && run.finalText.trim() !== "") {
    return run.finalText.trim();
  }
  const usefulLines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-5);
  if (usefulLines.length > 0) {
    return `No report received; last log lines: ${usefulLines.join(" | ")}`;
  }
  return "No report received from the agent, and the log contains nothing usable.";
}
