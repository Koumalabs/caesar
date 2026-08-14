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

const AGENT_ID = "opencode";

const CAPABILITIES: AgentCapabilities = {
  jsonEvents: true,
  outputSchema: false,
  finalMessageFile: false,
  nativeReadOnly: false,
  resume: true,
  addDir: false,
  mcpInjection: "project-config",
  model: true,
  // No confinement in the `opencode run` command line: the network is open
  // and we do not know how to close it.
  network: "open",
};

/**
 * Project MCP config, in the format documented by opencode (`opencode.json`,
 * `mcp` key). Written at the workspace root — the only location where
 * opencode discovers it (`mcpInjection: "project-config"`, no flag to point
 * it elsewhere, unlike `--mcp-config`/`--additional-mcp-config` for
 * claude/copilot): unlike theirs, this file is therefore not under
 * `ctx.paths.dir`, which belongs to the orchestrator.
 *
 * `restoreAfter: true` (see C5 of the final review): in `"inplace"`
 * isolation, `workspace` is the user's real directory — without this
 * marker, an existing `opencode.json` there was silently overwritten, with
 * no backup nor restore, including for a read-only task.
 * `runAgentProcess` (`spawn.ts`) restores the previous content after the
 * run, or deletes the file if it did not exist before. The same marker
 * also excludes this path from the diff/reconciliation computation
 * (`runner.ts`): in `worktree` isolation, where this file still lands in
 * the disposable worktree's tree (`workspace` there is the worktree
 * path), it must not pass itself off as a write made by the agent.
 */
function mcpConfigFile(workspace: string, channel: NonNullable<Task["channel"]>): PreparedFile {
  return {
    path: join(workspace, "opencode.json"),
    content:
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            [channel.server_name]: {
              type: "local",
              command: [channel.command, ...channel.args],
              enabled: true,
            },
          },
        },
        null,
        2,
      ) + "\n",
    restoreAfter: true,
  };
}

function build(ctx: BuildContext): SpawnPlan {
  const args: string[] = ["run", "--format", "json", "--dir", ctx.task.workspace];

  if (ctx.model) args.push("--model", ctx.model);
  // `task.role` carries the requested profile; opencode has its own concept
  // of a named agent (persona/config), which is the natural anchor point.
  if (ctx.task.role) args.push("--agent", ctx.task.role);
  if (ctx.task.mode === "write") args.push("--auto");

  // The prompt is positional and final; the user's raw arguments go after
  // it, at the very end of the line.
  args.push(ctx.prompt);
  args.push(...ctx.extraArgs);

  const files: PreparedFile[] = [];
  if (ctx.reportVia === "channel" && ctx.task.channel) {
    files.push(mcpConfigFile(ctx.task.workspace, ctx.task.channel));
  }

  return { command: "opencode", args, cwd: ctx.task.workspace, env: {}, files };
}

/**
 * Translates the `opencode run --format json` stream.
 *
 * All shapes handled here come from the real capture
 * (`test/fixtures/opencode.jsonl`, a task that writes a file and runs a
 * command): `step_start`, `text`, `step_finish`, and the `tool` parts.
 *
 * The previous version looked for a `part.type` prefixed with `tool-`, a
 * `part.input` and a string-typed `part.state` — three shapes derived from
 * the conventions of the Vercel AI SDK, on which opencode is built, and
 * **never observed**. None matches: the real shape is `part.type ===
 * "tool"`, the name in `part.tool`, the input and state in `part.state`.
 * No `tool_use` was therefore emitted, and an opencode sub-agent appeared
 * to use no tools at all.
 *
 * Two limits of this stream, observed rather than assumed: opencode only
 * reports a tool **once finished** (never its start, unlike codex — a long
 * tool stays invisible there while it runs), and it reports no end of
 * session, which the engine infers from the process exit code.
 */
function translate(line: string): Translation {
  const data = parseJsonLine(line);
  if (!isRecord(data)) return { events: [] };

  const part = data["part"];
  if (!isRecord(part)) return { events: [] };
  const partType = part["type"];
  if (typeof partType !== "string") return { events: [] };

  if (partType === "text" && typeof part["text"] === "string") {
    const text = part["text"];
    return { events: [{ type: "message", text }], finalText: text };
  }

  if (partType === "tool") {
    const tool = typeof part["tool"] === "string" ? part["tool"] : "tool";
    const state = isRecord(part["state"]) ? part["state"] : undefined;
    // `state.title` is already the summary a human wants to read — "ls -1",
    // "note.txt" — whereas the serialized input carries the whole content of
    // a written file. We only fall back to it when there is no title.
    const title = state && typeof state["title"] === "string" && state["title"] !== "" ? state["title"] : undefined;
    const input = state?.["input"];
    const summary = title ?? (input === undefined ? "" : JSON.stringify(input).slice(0, 200));
    // Only "completed" has been observed; the other two remain defensive.
    const rawStatus = state?.["status"];
    const status = rawStatus === "completed" ? "succeeded" : rawStatus === "error" ? "failed" : "started";
    const callId = typeof part["callID"] === "string" ? part["callID"] : "";
    const events: PartialEvent[] = [{ type: "tool_use", tool, id: callId, input_summary: summary, status }];
    return { events };
  }

  return { events: [] };
}

export const opencodeAgent: AgentDefinition = {
  id: AGENT_ID,
  displayName: "OpenCode",
  bin: "opencode",
  capabilities: CAPABILITIES,
  preferredReportChannel: (_task: Task, channelAvailable: boolean): ReportChannel =>
    defaultPreferredReportChannel(CAPABILITIES, channelAvailable),
  build,
  translate,
};
