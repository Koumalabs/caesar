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
    "--output-format",
    "json",
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
 * Traduit le flux `claude --print --output-format json`.
 *
 * Ce mode (par opposition à `stream-json`) n'émet qu'un seul objet JSON final,
 * confirmé par la capture réelle (`test/fixtures/claude.jsonl`) : la ligne
 * `type: "result"` porte à la fois le texte de réponse (`result`) et le
 * statut (`is_error`). Elle produit donc à la fois l'événement `message` et
 * l'événement `finished`.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };
  if (data["type"] !== "result") return { events: [] };

  const events: PartialEvent[] = [];
  const text = data["result"];
  if (typeof text === "string" && text.length > 0) {
    events.push({ type: "message", text });
  }

  const status = data["is_error"] === true ? "failed" : "success";
  events.push({ type: "finished", status, summary: "", exit_code: null });

  return typeof text === "string" && text.length > 0 ? { events, finalText: text } : { events };
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
