import { join } from "node:path";
import type { ReportChannel, Task } from "@caesar/protocol";
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

const AGENT_ID = "copilot";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: true,
  resume: true,
  addDir: true,
  mcpInjection: "flag",
  model: true,
  // `--allow-all-urls` est un drapeau distinct de `--allow-all-tools` et vaut
  // dans les deux modes : ouvrir les URL n'ouvre ni l'écriture ni le shell.
  network: "toggle",
};

/** Config MCP additionnelle, au format `mcpServers` documenté par `copilot mcp`. */
function mcpConfigFile(taskDir: string, channel: NonNullable<Task["channel"]>): PreparedFile {
  return {
    path: join(taskDir, "copilot-mcp-config.json"),
    content:
      JSON.stringify(
        {
          mcpServers: {
            [channel.server_name]: {
              type: "local",
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
    "--prompt",
    ctx.prompt,
    "--output-format",
    "json",
    "--no-color",
    "--log-level",
    "none",
  ];

  if (ctx.task.mode === "write") {
    args.push("--allow-all-tools");
  } else {
    args.push("--deny-tool=write", "--deny-tool=shell");
  }

  // Distinct de `--allow-all-tools`, qui ne couvre pas les URL : sans ce
  // drapeau, copilot demandait confirmation pour chaque accès réseau — donc,
  // en exécution non interactive, ne l'obtenait jamais. En lecture seule, les
  // refus d'écriture et de shell ci-dessus restent en place.
  if (ctx.task.network) args.push("--allow-all-urls");

  // Le répertoire de tâche héberge le rapport et le message final ; il doit
  // rester accessible même quand le workspace, lui, est en lecture seule.
  args.push("--add-dir", ctx.paths.dir);

  if (ctx.model) args.push("--model", ctx.model);

  const files: PreparedFile[] = [];
  if (ctx.reportVia === "channel" && ctx.task.channel) {
    const file = mcpConfigFile(ctx.paths.dir, ctx.task.channel);
    files.push(file);
    args.push("--additional-mcp-config", `@${file.path}`);
  }

  args.push(...ctx.extraArgs);

  return { command: "copilot", args, cwd: ctx.task.workspace, env: {}, files };
}

/**
 * Traduit le flux `copilot --output-format json`.
 *
 * Les formes `session.error` (enveloppe `{type, data, id, timestamp}`) et
 * `result` (`{type, exitCode, usage}`, sans enveloppe `data`) viennent de la
 * capture réelle (`test/fixtures/copilot.jsonl`) — obtenue via un échec de
 * quota mensuel Copilot, donc un chemin d'erreur authentique plutôt qu'un
 * succès. Les formes `assistant.message` (texte final, champ `data.content`)
 * et `tool.execution_start` / `tool.execution_complete` sont dérivées de la
 * documentation publique du streaming Copilot ; elles n'ont pas pu être
 * observées faute de quota disponible et restent strictement défensives.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const type = data["type"];
  if (typeof type !== "string") return { events: [] };

  if (type === "result") {
    const exitCode = data["exitCode"];
    const status = exitCode === 0 ? "success" : "failed";
    const events: PartialEvent[] = [
      {
        type: "finished",
        status,
        summary: "",
        exit_code: typeof exitCode === "number" ? exitCode : null,
      },
    ];
    return { events };
  }

  const payload = data["data"];
  if (!isRecord(payload)) return { events: [] };

  if (type === "session.error" && typeof payload["message"] === "string") {
    return { events: [{ type: "error", message: payload["message"], fatal: true }] };
  }

  if (type === "assistant.message" && typeof payload["content"] === "string") {
    const text = payload["content"];
    return { events: [{ type: "message", text }], finalText: text };
  }

  if (type === "tool.execution_start" || type === "tool.execution_complete") {
    const tool = typeof payload["tool"] === "string" ? payload["tool"] : typeof payload["name"] === "string" ? payload["name"] : "";
    const events: PartialEvent[] = [
      {
        type: "tool_use",
        tool,
        input_summary: "",
        status: type === "tool.execution_complete" ? "succeeded" : "started",
      },
    ];
    return { events };
  }

  return { events: [] };
}

export const copilotAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "GitHub Copilot",
  bin: "copilot",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
