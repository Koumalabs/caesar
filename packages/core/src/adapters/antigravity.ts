import type { ReportChannel, Task } from "@orch/protocol";
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
 * Les formes `init`, `step_update` (types `agent_response` et `checkpoint`)
 * et `result` viennent de la capture réelle
 * (`test/fixtures/antigravity.jsonl`). La forme `error` de premier niveau
 * n'a pas été observée (la capture a réussi) ; elle suit la même convention
 * `event`/payload que les formes confirmées et reste strictement défensive.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const event = data["event"];
  if (typeof event !== "string") return { events: [] };

  if (event === "step_update") {
    const stepUpdate = data["step_update"];
    if (!isRecord(stepUpdate)) return { events: [] };
    if (stepUpdate["step_type"] === "agent_response" && typeof stepUpdate["text_delta"] === "string") {
      const text = stepUpdate["text_delta"];
      return { events: [{ type: "message", text }], finalText: text };
    }
    return { events: [] };
  }

  if (event === "result") {
    const result = data["result"];
    if (!isRecord(result)) return { events: [] };
    const status = result["status"] === "SUCCESS" ? "success" : "failed";
    const response = typeof result["response"] === "string" ? result["response"] : "";
    const events: PartialEvent[] = [{ type: "finished", status, summary: "", exit_code: null }];
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
