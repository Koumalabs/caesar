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
  // Our arguments set up no sandbox: the network is open, and we have
  // nothing to close it with. `claude` can confine itself, but through
  // machine-level settings the orchestrator does not control — announcing
  // "toggle" would promise a closure we would not obtain.
  network: "open",
};

/** MCP config, in the `mcpServers` format documented by Claude Code (`--mcp-config`). */
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
    // `stream-json` and not `json`: the latter emits a single object, at the
    // very end. A claude sub-agent was therefore mute from the start to the
    // end of its run — nothing to display in `caesar run`, nothing to follow
    // in `caesar logs --follow`, nothing in `caesar watch`. Stream mode yields
    // each assistant message as soon as it is complete.
    //
    // `--verbose` must accompany `stream-json` under `--print`.
    // No `--include-partial-messages`: it would split each response into
    // fragments of a few characters, i.e. one event per fragment in
    // `events.jsonl` — the useful grain is the whole message.
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    ctx.task.mode === "read-only" ? "plan" : "acceptEdits",
  ];

  // The task directory hosts the report and the final message; it must
  // remain accessible even when the workspace itself is read-only.
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
 * Tool input keys that carry, on their own, what a human wants to read —
 * in order of preference. Mirrors the schemas of Claude Code's tools
 * (`Bash.command`, `Write.file_path`, `Grep.pattern`…); otherwise, the
 * serialized input serves as fallback.
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

/** The content blocks of an `assistant` message, translated one by one. */
function translateAssistant(content: readonly unknown[]): PartialEvent[] {
  const events: PartialEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = block["type"];

    if (blockType === "text" && typeof block["text"] === "string" && block["text"] !== "") {
      events.push({ type: "message", text: block["text"] });
    } else if (blockType === "tool_use") {
      const tool = typeof block["name"] === "string" ? block["name"] : "tool";
      const id = typeof block["id"] === "string" ? block["id"] : "";
      events.push({ type: "tool_use", tool, id, input_summary: summarizeToolInput(block["input"]), status: "started" });
    } else if (blockType === "thinking" && typeof block["thinking"] === "string" && block["thinking"] !== "") {
      // Empty in the capture: the API returns only the reasoning's signature,
      // not its text. So we never push a hollow `thinking` — it is
      // `system/thinking_tokens` that carries the usable signal (see below).
      events.push({ type: "thinking", text: block["thinking"] });
    }
  }
  return events;
}

/** The last `text` block of an `assistant` message, if there is one. */
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
 * Translates the `claude --print --output-format stream-json --verbose` stream.
 *
 * All handled shapes come from the real capture
 * (`test/fixtures/claude.jsonl`, a task that writes a file and runs a
 * command): `system` (subtypes `hook_started`, `hook_response`, `init`,
 * `thinking_tokens`), `assistant` (`text`, `tool_use`, `thinking` blocks),
 * `user` (`tool_result` blocks), `rate_limit_event`, and `result`.
 *
 * What the switch away from `--output-format json` changes: that mode emitted
 * a single object, at the very end. A claude sub-agent was therefore mute from
 * start to finish — nothing to follow, in `caesar run` or in `caesar watch`.
 *
 * What it does not change, and that is what made the switch safe: the final
 * line always carries `type: "result"`, `result` (the text) and `is_error` at
 * the top level. The report-extraction fallback (`report_source:
 * "extracted"`, fed by `finalText`) therefore keeps exactly the same
 * source — verified on the capture before writing a single line of translation.
 *
 * `tool_result` blocks carry only `tool_use_id`, never the tool's name, and
 * `translate` is stateless by contract: the closing event arrives with an
 * empty `tool` and the identifier alone, leaving it to the consumer to match
 * it with its opening (see `CaesarEvent.id` and `foldActivity`).
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
    // The only usable thinking signal: the stream's `thinking` blocks arrive
    // with their text empty. Without it, a long reasoning phase is
    // indistinguishable from a frozen agent.
    const tokens = data["estimated_tokens"];
    const suffix = typeof tokens === "number" ? ` (~${tokens} tokens)` : "";
    return { events: [{ type: "progress", message: `Thinking in progress${suffix}` }] };
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
