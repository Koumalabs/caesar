#!/usr/bin/env node
/**
 * Agent extérieur factice, utilisé par les tests du moteur d'exécution.
 *
 * Il ne dépend d'aucun package du monorepo : c'est délibéré. Un agent
 * extérieur réel ne connaîtrait rien de cette implémentation, seulement le
 * contrat minimal documenté par `@orch/protocol` — lire `$ORCH_TASK_FILE`,
 * écrire `$ORCH_REPORT_PATH`. Ce script prouve que ce contrat suffit : s'il
 * est orchestrable au même titre que Codex ou Antigravity, n'importe quel
 * CLI extérieur l'est aussi.
 *
 * Son comportement est piloté par `task.context`, un JSON optionnel de la
 * forme suivante (tous les champs ont une valeur par défaut) :
 *
 * {
 *   "mode": "success" | "fail" | "silent" | "hang",
 *   "exitCode": 0,
 *   "files": [{ "path": "relatif/au/workspace.txt", "content": "…" }],
 *   "declaredChanges": [{ "path": "…", "action": "modified", "summary": "…" }],
 *   "writeReport": true,
 *   "status": "success",
 *   "summary": "…",
 *   "sleepMs": 86400000,
 *   "ignoreSigterm": false,
 *   "finalMessage": "…"
 * }
 *
 * - "success" (par défaut) : écrit les `files` déclarés, un rapport valide.
 * - "fail" : sort avec un code non nul (1 par défaut) ; écrit tout de même
 *   un rapport sauf si `writeReport` est faux.
 * - "silent" : n'écrit jamais de rapport, quel que soit `writeReport` —
 *   simule un agent qui ignore le contrat, pour éprouver la synthèse.
 * - "hang" : ne fait jamais rien de plus qu'attendre `sleepMs`, pour
 *   éprouver le timeout et l'annulation. Avec `ignoreSigterm`, installe un
 *   gestionnaire qui absorbe SIGTERM, pour éprouver l'escalade vers SIGKILL.
 *
 * `declaredChanges`, quand fourni, remplace la déclaration de `changes` du
 * rapport indépendamment des `files` réellement écrits — de quoi simuler un
 * agent qui ment, dans les deux sens (fichier tu, fichier inventé), pour
 * éprouver `reconcileChanges`.
 *
 * `finalMessage`, quand fourni, simule un CLI dont `capabilities.finalMessageFile`
 * est vrai (Codex avec `-o`, par exemple) : le message est écrit tel quel
 * dans `final-message.txt`, sous le répertoire de la tâche. Ce script ne
 * reçoit ce chemin par aucun jeton dédié — `GenericAgentSpec` (tâche 3) n'en
 * prévoit pas pour un CLI générique — mais le retrouve lui-même sous
 * `$ORCH_TASK_DIR`, exactement comme le calcule le runner.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const REPORT_PROTOCOL = "orch.report/v1";
const FINAL_MESSAGE_FILE_NAME = "final-message.txt";

function log(kind, message) {
  process.stdout.write(JSON.stringify({ kind, message }) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const taskFile = process.env["ORCH_TASK_FILE"];
  const reportPath = process.env["ORCH_REPORT_PATH"];
  if (!taskFile || !reportPath) {
    process.stderr.write("fake-agent: ORCH_TASK_FILE / ORCH_REPORT_PATH manquants\n");
    process.exitCode = 1;
    return;
  }

  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  let directive = {};
  try {
    directive = JSON.parse(task.context);
  } catch {
    // task.context n'est pas un JSON de pilotage : comportement par défaut.
  }

  const mode = directive.mode ?? "success";
  const files = directive.files ?? [];
  const sleepMs = directive.sleepMs ?? 86_400_000;
  const writeReport = directive.writeReport ?? true;

  if (directive.ignoreSigterm) {
    process.on("SIGTERM", () => {
      // Absorbe volontairement le signal, pour forcer le moteur à escalader vers SIGKILL.
    });
  }

  log("progress", "démarrage");

  if (mode === "hang") {
    log("progress", "en attente indéfiniment");
    await sleep(sleepMs);
    // Jamais atteint en pratique : le processus est terminé avant.
    return;
  }

  log("progress", "traitement");

  for (const file of files) {
    const target = isAbsolute(file.path) ? file.path : join(task.workspace, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content ?? "", "utf8");
  }

  if (directive.finalMessage !== undefined) {
    const taskDir = process.env["ORCH_TASK_DIR"];
    writeFileSync(join(taskDir, FINAL_MESSAGE_FILE_NAME), directive.finalMessage, "utf8");
  }

  const exitCode = directive.exitCode ?? (mode === "fail" ? 1 : 0);

  if (mode !== "silent" && writeReport) {
    const changes = directive.declaredChanges ?? files.map((file) => ({ path: file.path, action: "created", summary: "" }));
    const report = {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: directive.status ?? (mode === "fail" ? "failed" : "success"),
      summary: directive.summary ?? "Mission traitée par l'agent factice.",
      changes,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  log("progress", "terminé");
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`fake-agent: erreur inattendue : ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
