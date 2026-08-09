/**
 * Le sous-ensemble compact d'un `Report` que rendent `orch_delegate` (à
 * l'issue synthétique près) et `orch_await` : statut, résumé, fichiers
 * modifiés (déjà recoupés avec git par le moteur quand l'isolation le
 * permet — voir `packages/core/src/engine/report.ts`), constats et
 * questions. Le détail brut (commandes exécutées, artefacts, usage, patch
 * complet) reste accessible via `orch_logs`/`orch_diff` plutôt que d'être
 * déversé ici (voir le brief).
 */
import type { Change, Finding, Question, Report, ReportStatus } from "@orch/protocol";

export interface ReportSummary {
  status: ReportStatus;
  summary: string;
  changes: Change[];
  findings: Finding[];
  questions: Question[];
  next_steps: string[];
}

export function summarizeReport(report: Report): ReportSummary {
  return {
    status: report.status,
    summary: report.summary,
    changes: report.changes,
    findings: report.findings,
    questions: report.questions,
    next_steps: report.next_steps,
  };
}
