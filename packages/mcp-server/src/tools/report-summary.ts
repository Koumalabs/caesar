/**
 * The compact subset of a `Report` returned by `caesar_delegate` (synthetic
 * outcome aside) and `caesar_await`: status, summary, changed files,
 * findings and questions. The raw detail (commands run, artifacts, usage,
 * full patch) stays reachable via `caesar_logs`/`caesar_diff` rather than
 * being dumped here (see the brief).
 *
 * `changes_verified_by` (see C2 of the final review): `"git"` when
 * `changes` was reconciled against the observed git state
 * (`reconcileChanges`, `packages/core/src/engine/report.ts`) — under
 * `worktree` isolation, or `inplace` in a git repository
 * (`diffWorkspaceStatus`, `packages/core/src/engine/worktree.ts`) —
 * `"declaration"` only when no reconciliation was possible (workspace
 * outside a git repository), in which case `changes` remains the agent's
 * word alone. Before this field, the data did not distinguish the two: a
 * model consuming `caesar_await` had no way to know which of the two
 * situations it was looking at.
 */
import type { ChangesVerifiedBy } from "@caesar/core";
import type { Change, Finding, Question, Report, ReportStatus } from "@caesar/protocol";

export interface ReportSummary {
  status: ReportStatus;
  summary: string;
  changes: Change[];
  changes_verified_by: ChangesVerifiedBy;
  findings: Finding[];
  questions: Question[];
  next_steps: string[];
}

export function summarizeReport(report: Report, changesVerifiedBy: ChangesVerifiedBy): ReportSummary {
  return {
    status: report.status,
    summary: report.summary,
    changes: report.changes,
    changes_verified_by: changesVerifiedBy,
    findings: report.findings,
    questions: report.questions,
    next_steps: report.next_steps,
  };
}
