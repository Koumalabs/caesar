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
 *   "mode": "success" | "fail" | "silent" | "hang" | "ask",
 *   "exitCode": 0,
 *   "files": [{ "path": "relatif/au/workspace.txt", "content": "…" }],
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
 * - "success" (par défaut) : écrit les `files` déclarés, un rapport valide.
 * - "fail" : sort avec un code non nul (1 par défaut) ; écrit tout de même
 *   un rapport sauf si `writeReport` est faux.
 * - "silent" : n'écrit jamais de rapport, quel que soit `writeReport` —
 *   simule un agent qui ignore le contrat, pour éprouver la synthèse.
 * - "hang" : ne fait jamais rien de plus qu'attendre `sleepMs` (défaut : un
 *   jour, en pratique indéfiniment), pour éprouver le timeout et
 *   l'annulation. Avec `ignoreSigterm`, installe un gestionnaire qui absorbe
 *   SIGTERM, pour éprouver l'escalade vers SIGKILL.
 * - "ask" (tâche 9, canal retour) : si `task.channel` est renseigné, se
 *   connecte à `orch-channel` comme client MCP (voir
 *   `@modelcontextprotocol/sdk/client`), appelle `ask_orchestrator` avec
 *   `question`/`options`, puis `submit_report` avec un résumé qui rapporte
 *   littéralement la réponse reçue — c'est ce qui permet à un test de
 *   vérifier que la réponse a bien fait l'aller-retour, pas seulement que le
 *   canal a répondu quelque chose. Si `task.channel` est absent (canal non
 *   activé pour cette tâche), dégrade silencieusement vers l'écriture directe
 *   de `report.json`, exactement comme le mode "success" : c'est le
 *   comportement attendu d'un agent réel qui ignorerait le canal (voir la
 *   consigne de repli documentée par `renderTaskPrompt`).
 *
 * Dans les trois modes "success", "fail", "silent", `sleepMs`, s'il est
 * fourni explicitement, retarde d'autant le traitement avant l'écriture du
 * rapport (par défaut : aucune pause) — utile pour prouver qu'un appelant
 * attend plusieurs tâches en parallèle sans que l'attente conjointe ne coûte
 * la somme de leurs délais (voir `packages/mcp-server/src/tools/await.test.ts`).
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

/**
 * Mode "ask" : le round-trip complet du canal retour (tâche 9). Écrit
 * toujours `report.json`, soit via `submit_report` (canal disponible), soit
 * directement (dégradation, canal absent) — jamais les deux.
 *
 * Le SDK MCP n'est importé qu'ici, dynamiquement : les autres modes n'en ont
 * pas besoin, et ce script reste sans dépendance de paquet du monorepo (voir
 * l'en-tête) — seul `@modelcontextprotocol/sdk`, un paquet tiers, tout comme
 * un agent extérieur réel en embarquerait un pour parler MCP.
 */
async function handleAskMode(task, directive, reportPath) {
  const baseSummary = directive.summary ?? "Traité.";
  const channel = task.channel;

  if (!channel) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          protocol: REPORT_PROTOCOL,
          task_id: task.id,
          status: "success",
          summary: `${baseSummary} (canal indisponible, question non posée)`,
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
    arguments: { question: directive.question ?? "Quelle couleur ?", options: directive.options ?? [] },
  });
  const askedData = asked.structuredContent ?? {};
  const answerText = askedData.answered ? askedData.answer : `(sans réponse) ${askedData.message ?? ""}`;

  await client.callTool({
    name: "submit_report",
    arguments: {
      protocol: REPORT_PROTOCOL,
      task_id: task.id,
      status: "success",
      summary: `${baseSummary} Réponse reçue : ${answerText}`,
    },
  });

  await client.close();
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

  if (mode === "ask") {
    log("progress", "question");
    await handleAskMode(task, directive, reportPath);
    log("progress", "terminé");
    process.exitCode = directive.exitCode ?? 0;
    return;
  }

  if (directive.sleepMs !== undefined) {
    await sleep(directive.sleepMs);
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
