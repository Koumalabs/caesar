import type { ReportChannel, Task } from "@caesar/protocol";
import type {
  AgentCapabilities,
  AgentDefinition,
  BuildContext,
  PartialEvent,
  SpawnPlan,
  Translation,
} from "../registry/types.js";
import { defaultPreferredReportChannel } from "../registry/types.js";
import { isRecord, parseJsonLine } from "./json-line.js";

const AGENT_ID = "antigravity";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: true,
  finalMessageFile: false,
  nativeReadOnly: true,
  resume: true,
  addDir: true,
  mcpInjection: "global-config",
  model: true,
  // `agy` a bien un `--sandbox`, mais il restreint le terminal, pas le
  // réseau — sa capture réelle (test/fixtures/antigravity.jsonl) montre au
  // contraire des outils `open_browser_url`, `read_url_content` et
  // `search_web`. Nous ne le passons pas, et nous ne saurions pas refermer.
  network: "open",
};

/** Convertit une durée en millisecondes vers la syntaxe Go attendue par `--print-timeout`. */
function toGoDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600}h`;
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60}m`;
  return `${totalSeconds}s`;
}

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = [
    "--print",
    ctx.prompt,
    "--output-format",
    "stream-json",
    "--mode",
    ctx.task.mode === "read-only" ? "plan" : "accept-edits",
    "--print-timeout",
    toGoDuration(ctx.task.deadline_ms),
  ];

  // Antigravity n'a aucun flag de répertoire de travail : le cwd du SpawnPlan
  // porte le workspace. --add-dir garde le répertoire de tâche accessible
  // pour le rapport et le message final.
  args.push("--add-dir", ctx.paths.dir);

  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.reportVia === "schema" && ctx.schemaFile) {
    args.push("--json-schema", ctx.schemaFile);
  }

  // La configuration globale de la machine est en agentMode "plan" avec une
  // liste trustedWorkspaces restreinte : il faut la surcharger explicitement
  // pour que le mode écriture s'applique réellement.
  if (ctx.task.mode === "write") args.push("--dangerously-skip-permissions");

  args.push(...ctx.extraArgs);

  return { command: "agy", args, cwd: ctx.task.workspace, env: {}, files: [] };
}

/**
 * Traduit le flux `agy --output-format stream-json`.
 *
 * Formes observées sur deux captures réelles : `init`, `step_update` (types
 * `user_input`, `unknown`, `agent_response`, `checkpoint`, `error_message`)
 * et `result`. La forme `error` de premier niveau n'a été observée sur aucune
 * des deux ; elle suit la même convention `event`/payload que les formes
 * confirmées et reste strictement défensive.
 *
 * Deux constats de la capture courante (`test/fixtures/antigravity.jsonl`),
 * qui est un échec de quota :
 *
 * - `result.error` porte l'explication entière (« Individual quota reached… »)
 *   et n'était **pas lue** : trois erreurs se sont succédé et le flux traduit
 *   n'en montrait aucune. Seul le repli synthétisé du moteur, qui recopie la
 *   fin du journal brut, laissait deviner ce qui s'était passé.
 * - les étapes `error_message` ne portent **aucun texte**, pas même un champ
 *   vide. On les signale tout de même : « une erreur est survenue et le CLI
 *   n'en dit pas plus » renseigne, un silence non.
 *
 * Aucune des deux captures n'a déclenché d'outil — la première était triviale,
 * la seconde a échoué avant d'agir. Le `step_type` des étapes d'outil reste
 * donc inconnu, et cet adaptateur n'émet aucun `tool_use` : une branche écrite
 * d'après une convention plausible serait exactement l'erreur qui a rendu
 * inopérante celle d'opencode.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const event = data["event"];
  if (typeof event !== "string") return { events: [] };

  if (event === "step_update") {
    const stepUpdate = data["step_update"];
    if (!isRecord(stepUpdate)) return { events: [] };
    const stepType = stepUpdate["step_type"];

    if (stepType === "agent_response" && typeof stepUpdate["text_delta"] === "string") {
      const text = stepUpdate["text_delta"];
      return { events: [{ type: "message", text }], finalText: text };
    }

    if (stepType === "error_message") {
      return {
        events: [
          { type: "error", message: "Antigravity a signalé une erreur, sans en donner le texte dans son flux.", fatal: false },
        ],
      };
    }

    return { events: [] };
  }

  if (event === "result") {
    const result = data["result"];
    if (!isRecord(result)) return { events: [] };
    const status = result["status"] === "SUCCESS" ? "success" : "failed";
    const response = typeof result["response"] === "string" ? result["response"] : "";
    const failure = typeof result["error"] === "string" && result["error"] !== "" ? result["error"] : undefined;

    const events: PartialEvent[] = [];
    // L'erreur d'abord : elle explique le `finished` qui suit, et c'est elle
    // qu'on veut lire en tête du journal quand la tâche a échoué.
    if (failure) events.push({ type: "error", message: failure, fatal: true });
    events.push({ type: "finished", status, summary: failure ?? "", exit_code: null });

    return response ? { events, finalText: response } : { events };
  }

  if (event === "error") {
    const message = data["message"] ?? (isRecord(data["error"]) ? data["error"]["message"] : undefined);
    if (typeof message === "string") {
      return { events: [{ type: "error", message, fatal: true }] };
    }
  }

  return { events: [] };
}

export const antigravityAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "Antigravity",
  bin: "agy",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
