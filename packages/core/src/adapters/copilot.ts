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
  // `--allow-all-urls` is a flag distinct from `--allow-all-tools` and holds
  // in both modes: opening URLs opens neither writing nor the shell.
  network: "toggle",
};

/** Additional MCP config, in the `mcpServers` format documented by `copilot mcp`. */
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

  // Distinct from `--allow-all-tools`, which does not cover URLs: without
  // this flag, copilot asked for confirmation on every network access — so,
  // in non-interactive execution, never got it. In read-only mode, the write
  // and shell denials above stay in place.
  if (ctx.task.network) args.push("--allow-all-urls");

  // The task directory hosts the report and the final message; it must
  // remain accessible even when the workspace itself is read-only.
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
 * Translates the `copilot --output-format json` stream.
 *
 * The `session.error` (envelope `{type, data, id, timestamp}`) and
 * `result` (`{type, exitCode, usage}`, without a `data` envelope) shapes come
 * from the real capture (`test/fixtures/copilot.jsonl`) — obtained via a
 * Copilot monthly quota failure, hence an authentic error path rather than a
 * success. The `assistant.message` (final text, `data.content` field) and
 * `tool.execution_start` / `tool.execution_complete` shapes are derived from
 * the public Copilot streaming documentation; they could not be observed for
 * lack of available quota and remain strictly defensive.
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
