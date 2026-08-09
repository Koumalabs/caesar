/**
 * Récupération du rapport d'une exécution, selon quatre paliers dégradés, et
 * recoupement de ce que l'agent déclare avoir modifié avec ce que git
 * constate.
 *
 * Le palier 2 (le texte final de l'agent) consulte deux sources dans
 * l'ordre de fiabilité décroissante : d'abord un fichier que le CLI
 * lui-même a déposé (`finalMessageFile`), puis, à défaut, le texte
 * reconstitué en rejouant les traductions ligne à ligne de stdout.
 *
 * C'est le garde-fou central du projet : un agent qui ne respecte aucun
 * contrat de rapport ne fait pas échouer l'orchestrateur, et un agent qui
 * ment sur ses `changes` ne trompe jamais l'appelant plus loin que ce
 * fichier.
 */
import { readFile } from "node:fs/promises";
import type { Finding, Report, ReportChannel, ReportStatus, Task, TaskPaths } from "@orch/protocol";
import { REPORT_PROTOCOL, ReportSchema, extractReportFromText, readReport } from "@orch/protocol";
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
   * Palier de rapport effectivement retenu pour cette exécution, choisi en
   * amont par le moteur via `agent.preferredReportChannel`.
   *
   * Absent des signatures listées au brief de la tâche 4, qui ne donne par
   * ailleurs aucun autre moyen de faire parvenir cette information jusqu'ici :
   * sans elle, le palier 2 ne peut pas distinguer un rapport obtenu par le
   * mécanisme *attendu* (`"schema"`) d'un rapport simplement *retrouvé* dans
   * le texte final d'un agent censé écrire un fichier et qui ne l'a pas fait
   * (`"extracted"`) — deux situations que le brief demande pourtant de
   * distinguer. Extension minimale et documentée, à confirmer en revue.
   */
  reportVia?: ReportChannel;
  /**
   * Chemin du fichier où le CLI lui-même — et non le modèle sous sandbox —
   * dépose son message final, quand `agent.capabilities.finalMessageFile`
   * est vrai (voir `BuildContext.finalMessageFile`, renseigné par le
   * runner). Plus fiable que `run.finalText`, reconstitué en reformant les
   * traductions ligne à ligne de stdout : consulté avant lui.
   */
  finalMessageFile?: string;
}): Promise<ResolvedReport> {
  const { task, paths, run, diff, reportVia, finalMessageFile } = args;

  // Palier 1 : canal MCP ou contrat de fichier, tous deux écrivant report.json.
  const fromFile = await readReport(paths);
  if (fromFile) {
    return { report: fromFile, source: task.channel ? "channel" : "file" };
  }

  // Palier 2, message final : le CLI a lui-même déposé son dernier message
  // dans un fichier dédié — plus fiable qu'une reconstitution depuis stdout,
  // donc consulté en premier.
  if (finalMessageFile) {
    const fileText = await readTextSafe(finalMessageFile);
    if (fileText.trim() !== "") {
      const extracted = extractReportFromText(fileText);
      if (extracted) {
        return { report: extracted, source: reportVia === "schema" ? "schema" : "extracted" };
      }
    }
  }

  // Palier 2, stdout : le dernier texte final non vide de l'agent contient le rapport.
  if (run.finalText) {
    const extracted = extractReportFromText(run.finalText);
    if (extracted) {
      return { report: extracted, source: reportVia === "schema" ? "schema" : "extracted" };
    }
  }

  // Palier 3 : le rapport est noyé quelque part dans le journal brut complet.
  const rawText = await readTextSafe(paths.rawLog);
  const fromLog = extractReportFromText(rawText);
  if (fromLog) {
    return { report: fromLog, source: "extracted" };
  }

  // Palier 4 : aucun rapport exploitable, on synthétise depuis ce qu'on sait.
  return { report: synthesize(task, run, diff, rawText), source: "synthesized" };
}

/**
 * Recoupe les `changes` déclarés par l'agent avec le diff git constaté.
 *
 * Le diff fait foi : `report.changes` est remplacé par la vérité constatée,
 * et un `finding` nomme chaque divergence — fichier modifié mais non
 * déclaré, ou fichier déclaré mais que git ne voit pas changé.
 */
export function reconcileChanges(report: Report, diff: WorktreeDiff): Report {
  const declared = new Set(report.changes.map((change) => change.path));
  const actual = new Set(diff.files.map((change) => change.path));

  const findings: Finding[] = [...report.findings];

  for (const change of diff.files) {
    if (!declared.has(change.path)) {
      findings.push({
        severity: "medium",
        title: "Modification non déclarée",
        file: change.path,
        detail: `Le diff git montre "${change.path}" (${change.action}) alors que l'agent ne l'a pas mentionné dans son rapport.`,
      });
    }
  }

  for (const change of report.changes) {
    if (!actual.has(change.path)) {
      findings.push({
        severity: "medium",
        title: "Modification déclarée mais introuvable dans le diff",
        file: change.path,
        detail: `L'agent déclare avoir modifié "${change.path}" (${change.action}), mais git ne voit aucun changement sur ce fichier.`,
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
    return `Aucun rapport reçu ; dernières lignes du journal : ${usefulLines.join(" | ")}`;
  }
  return "Aucun rapport reçu de l'agent, et le journal ne contient rien d'exploitable.";
}
