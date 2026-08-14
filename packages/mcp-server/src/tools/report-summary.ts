/**
 * Le sous-ensemble compact d'un `Report` que rendent `caesar_delegate` (à
 * l'issue synthétique près) et `caesar_await` : statut, résumé, fichiers
 * modifiés, constats et questions. Le détail brut (commandes exécutées,
 * artefacts, usage, patch complet) reste accessible via `caesar_logs`/`caesar_diff`
 * plutôt que d'être déversé ici (voir le brief).
 *
 * `changes_verified_by` (voir C2 de la revue finale) : `"git"` quand
 * `changes` a été recoupé avec l'état git constaté (`reconcileChanges`,
 * `packages/core/src/engine/report.ts`) — en isolation `worktree`, ou
 * `inplace` dans un dépôt git (`diffWorkspaceStatus`,
 * `packages/core/src/engine/worktree.ts`) — `"declaration"` seulement quand
 * aucun recoupement n'était possible (workspace hors dépôt git), auquel cas
 * `changes` reste la seule parole de l'agent. Avant ce champ, la donnée ne
 * distinguait pas les deux : un modèle consommant `caesar_await` n'avait aucun
 * moyen de savoir laquelle des deux situations il regardait.
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
