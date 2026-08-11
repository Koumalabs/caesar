import { join } from "node:path";
import type { ReportChannel, Task } from "@orch/protocol";
import type {
  AgentCapabilities,
  AgentDefinition,
  BuildContext,
  PartialEvent,
  PreparedFile,
  SpawnPlan,
  Translation,
} from "../registry/types.js";
import { defaultPreferredReportChannel } from "../registry/types.js";
import { isRecord, parseJsonLine } from "./json-line.js";

const AGENT_ID = "claude";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: true,
  resume: true,
  addDir: true,
  mcpInjection: "flag",
  model: true,
  // Nos arguments ne passent aucun bac à sable : le réseau est ouvert, et
  // nous n'avons pas de quoi le refermer. `claude` sait se confiner, mais par
  // des réglages de la machine que l'orchestrateur ne pilote pas — annoncer
  // "toggle" reviendrait à promettre une fermeture que nous n'obtiendrions pas.
  network: "open",
};

/** Config MCP, au format `mcpServers` documenté par Claude Code (`--mcp-config`). */
function mcpConfigFile(taskDir: string, channel: NonNullable<Task["channel"]>): PreparedFile {
  return {
    path: join(taskDir, "claude-mcp-config.json"),
    content:
      JSON.stringify(
        {
          mcpServers: {
            [channel.server_name]: {
              type: "stdio",
              command: channel.command,
              args: channel.args,
            },
          },
        },
        null,
        2,
      ) + "\n",
  };
}

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = [
    "--print",
    ctx.prompt,
    // `stream-json` et non `json` : ce dernier n'émet qu'un seul objet, à la
    // toute fin. Un sous-agent claude était donc muet du début à la fin de son
    // exécution — rien à afficher dans `orch run`, rien à suivre dans `orch
    // logs --follow`, rien dans `orch watch`. Le mode flux rend chaque message
    // de l'assistant dès qu'il est complet.
    //
    // `--verbose` accompagne obligatoirement `stream-json` sous `--print`.
    // Pas de `--include-partial-messages` : il découperait chaque réponse en
    // fragments de quelques caractères, soit un événement par fragment dans
    // `events.jsonl` — le grain utile est le message entier.
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    ctx.task.mode === "read-only" ? "plan" : "acceptEdits",
  ];

  // Le répertoire de tâche héberge le rapport et le message final ; il doit
  // rester accessible même quand le workspace, lui, est en lecture seule.
  args.push("--add-dir", ctx.paths.dir);

  if (ctx.model) args.push("--model", ctx.model);

  const files: PreparedFile[] = [];
  if (ctx.reportVia === "channel" && ctx.task.channel) {
    const file = mcpConfigFile(ctx.paths.dir, ctx.task.channel);
    files.push(file);
    args.push("--mcp-config", file.path);
  }

  args.push(...ctx.extraArgs);

  return { command: "claude", args, cwd: ctx.task.workspace, env: {}, files };
}

/**
 * Clés d'entrée d'outil qui portent, à elles seules, ce qu'un humain veut
 * lire — dans l'ordre de préférence. Reprend les schémas des outils de Claude
 * Code (`Bash.command`, `Write.file_path`, `Grep.pattern`…) ; à défaut,
 * l'entrée sérialisée sert de repli.
 */
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description"] as const;

function summarizeToolInput(input: unknown): string {
  if (!isRecord(input)) return input === undefined ? "" : JSON.stringify(input).slice(0, 200);
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value.slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
}

/** Les blocs de contenu d'un message `assistant`, traduits un à un. */
function translateAssistant(content: readonly unknown[]): PartialEvent[] {
  const events: PartialEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = block["type"];

    if (blockType === "text" && typeof block["text"] === "string" && block["text"] !== "") {
      events.push({ type: "message", text: block["text"] });
    } else if (blockType === "tool_use") {
      const tool = typeof block["name"] === "string" ? block["name"] : "outil";
      const id = typeof block["id"] === "string" ? block["id"] : "";
      events.push({ type: "tool_use", tool, id, input_summary: summarizeToolInput(block["input"]), status: "started" });
    } else if (blockType === "thinking" && typeof block["thinking"] === "string" && block["thinking"] !== "") {
      // Vide dans la capture : l'API ne rend que la signature du raisonnement,
      // pas son texte. On ne pousse donc jamais un `thinking` creux — c'est
      // `system/thinking_tokens` qui porte le signal exploitable (voir plus bas).
      events.push({ type: "thinking", text: block["thinking"] });
    }
  }
  return events;
}

/** Le dernier bloc `text` d'un message `assistant`, s'il y en a un. */
function lastText(content: readonly unknown[]): string | undefined {
  let found: string | undefined;
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
      found = block["text"];
    }
  }
  return found;
}

/**
 * Traduit le flux `claude --print --output-format stream-json --verbose`.
 *
 * Toutes les formes traitées viennent de la capture réelle
 * (`test/fixtures/claude.jsonl`, une tâche qui écrit un fichier et lance une
 * commande) : `system` (sous-types `hook_started`, `hook_response`, `init`,
 * `thinking_tokens`), `assistant` (blocs `text`, `tool_use`, `thinking`),
 * `user` (blocs `tool_result`), `rate_limit_event`, et `result`.
 *
 * Ce que la bascule depuis `--output-format json` change : ce mode n'émettait
 * qu'un seul objet, à la toute fin. Un sous-agent claude était donc muet du
 * début à la fin — rien à suivre, ni dans `orch run`, ni dans `orch watch`.
 *
 * Ce qu'elle ne change pas, et c'est ce qui rendait la bascule sûre : la ligne
 * finale porte toujours `type: "result"`, `result` (le texte) et `is_error` au
 * premier niveau. Le repli d'extraction du rapport (`report_source:
 * "extracted"`, alimenté par `finalText`) garde donc exactement la même
 * source — vérifié sur la capture avant d'écrire une ligne de traduction.
 *
 * Les blocs `tool_result` ne portent que `tool_use_id`, jamais le nom de
 * l'outil, et `translate` est sans état par contrat : l'événement de
 * fermeture arrive avec `tool` vide et l'identifiant seul, à charge du
 * consommateur de le rapprocher de son ouverture (voir `OrchEvent.id` et
 * `foldActivity`).
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };
  const type = data["type"];

  if (type === "assistant") {
    const message = data["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) return { events: [] };
    const content = message["content"];
    const events = translateAssistant(content);
    const text = lastText(content);
    return text === undefined ? { events } : { events, finalText: text };
  }

  if (type === "user") {
    const message = data["message"];
    if (!isRecord(message) || !Array.isArray(message["content"])) return { events: [] };
    const events: PartialEvent[] = [];
    for (const block of message["content"]) {
      if (!isRecord(block) || block["type"] !== "tool_result") continue;
      const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
      events.push({ type: "tool_use", tool: "", id, input_summary: "", status: block["is_error"] === true ? "failed" : "succeeded" });
    }
    return { events };
  }

  if (type === "system" && data["subtype"] === "thinking_tokens") {
    // Le seul signal exploitable de réflexion : les blocs `thinking` du flux
    // arrivent avec leur texte vide. Sans lui, une longue phase de
    // raisonnement est indiscernable d'un agent figé.
    const tokens = data["estimated_tokens"];
    const suffix = typeof tokens === "number" ? ` (~${tokens} jetons)` : "";
    return { events: [{ type: "progress", message: `Réflexion en cours${suffix}` }] };
  }

  if (type === "result") {
    const events: PartialEvent[] = [];
    const text = data["result"];
    const hasText = typeof text === "string" && text.length > 0;
    if (hasText) events.push({ type: "message", text: text as string });
    events.push({ type: "finished", status: data["is_error"] === true ? "failed" : "success", summary: "", exit_code: null });
    return hasText ? { events, finalText: text as string } : { events };
  }

  return { events: [] };
}

export const claudeAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "Claude Code",
  bin: "claude",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
