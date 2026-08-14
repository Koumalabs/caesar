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

const AGENT_ID = "codex";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: true,
  finalMessageFile: true,
  nativeReadOnly: true,
  resume: true,
  addDir: true,
  mcpInjection: "flag",
  model: true,
  // Codex's sandbox exposes its network setting only under
  // `sandbox_workspace_write`: there is no `sandbox_read_only`, so
  // `-s read-only` cuts the network with no recourse. Verified on codex 0.147.0.
  network: "write-only",
};

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    ctx.task.workspace,
    "-s",
    ctx.task.mode === "read-only" ? "read-only" : "workspace-write",
  ];

  // The task directory hosts the report and the final message; it must
  // remain writable even when the workspace itself is read-only.
  args.push("--add-dir", ctx.paths.dir);

  // `decideNetwork` never leaves `network` true in read-only mode for this
  // agent: the key exists only under `sandbox_workspace_write`, and setting
  // it under `-s read-only` would have no effect.
  if (ctx.task.network) args.push("-c", "sandbox_workspace_write.network_access=true");

  if (ctx.model) args.push("-m", ctx.model);
  if (ctx.reportVia === "schema" && ctx.schemaFile) {
    args.push("--output-schema", ctx.schemaFile);
  }
  if (ctx.finalMessageFile) args.push("-o", ctx.finalMessageFile);

  if (ctx.reportVia === "channel" && ctx.task.channel) {
    const { server_name, command, args: channelArgs } = ctx.task.channel;
    args.push("-c", `mcp_servers.${server_name}.command=${JSON.stringify(command)}`);
    args.push("-c", `mcp_servers.${server_name}.args=${JSON.stringify(channelArgs)}`);
  }

  // The prompt is positional and final in codex's grammar; the user's raw
  // arguments go after it, at the very end of the line.
  args.push(ctx.prompt);
  args.push(...ctx.extraArgs);

  return { command: "codex", args, cwd: ctx.task.workspace, env: {}, files: [] };
}

/** `kind` of a codex `file_change` → protocol action. */
function fileAction(kind: unknown): "created" | "modified" | "deleted" | "renamed" {
  if (kind === "add") return "created";
  if (kind === "delete") return "deleted";
  if (kind === "rename") return "renamed";
  // "update" is the value observed for a modification; any unknown `kind`
  // falls here rather than making the file vanish from the log.
  return "modified";
}

/** Translates `item.status` into a tool status. The first two values are observed. */
function toolStatus(status: unknown): "started" | "succeeded" | "failed" {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "started";
}

/**
 * Translates the `codex exec --json` stream.
 *
 * Shapes observed in the real capture (`test/fixtures/codex.jsonl`, a task
 * that writes a file and runs two commands): `thread.started`,
 * `turn.started`, `item.started` and `item.completed` for the
 * `agent_message`, `command_execution` and `file_change` items, and
 * `turn.completed`. The `error` item comes from an earlier capture.
 * `turn.failed` and the top-level `error` event remain derived from the
 * public documentation, never observed, handled strictly defensively.
 *
 * Deliberately absent: the `reasoning` item. The capture does carry
 * `reasoning_output_tokens: 91` in its `turn.completed`, but **no item of
 * that type was ever emitted** — writing the branch blind is exactly the
 * mistake that left opencode's branch inoperative for months.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const type = data["type"];
  if (typeof type !== "string") return { events: [] };

  // `item.started` as much as `item.completed`: that is the whole difference
  // between seeing a three-minute `npm install` start and discovering it at
  // the third minute. `item.updated` follows the same shape, handled alike.
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const completed = type === "item.completed";
    const item = data["item"];
    if (!isRecord(item)) return { events: [] };
    const itemType = item["type"];

    if (itemType === "agent_message" && completed && typeof item["text"] === "string") {
      const text = item["text"];
      return { events: [{ type: "message", text }], finalText: text };
    }

    if (itemType === "error" && completed && typeof item["message"] === "string") {
      const events: PartialEvent[] = [{ type: "error", message: item["message"], fatal: false }];
      return { events };
    }

    if (itemType === "command_execution") {
      const command = item["command"];
      const summary = typeof command === "string" ? command : Array.isArray(command) ? command.join(" ") : "";
      const events: PartialEvent[] = [
        {
          type: "tool_use",
          tool: "shell",
          id: typeof item["id"] === "string" ? item["id"] : "",
          input_summary: summary,
          status: toolStatus(item["status"]),
        },
      ];
      return { events };
    }

    if (itemType === "file_change") {
      // Only on completion: a `file_change` is instantaneous and its
      // `item.started` shape carries exactly the same changes — emitting them
      // twice would make every file appear duplicated in the log.
      if (!completed) return { events: [] };
      const changes = item["changes"];
      if (!Array.isArray(changes)) return { events: [] };
      const events: PartialEvent[] = [];
      for (const change of changes) {
        if (!isRecord(change) || typeof change["path"] !== "string") continue;
        events.push({ type: "file_changed", path: change["path"], action: fileAction(change["kind"]) });
      }
      return { events };
    }

    return { events: [] };
  }

  if (type === "turn.completed") {
    return { events: [{ type: "finished", status: "success", summary: "", exit_code: null }] };
  }

  if (type === "turn.failed") {
    return { events: [{ type: "finished", status: "failed", summary: "", exit_code: null }] };
  }

  if (type === "error" && typeof data["message"] === "string") {
    return { events: [{ type: "error", message: data["message"], fatal: true }] };
  }

  return { events: [] };
}

export const codexAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "Codex",
  bin: "codex",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
