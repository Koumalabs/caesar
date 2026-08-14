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
  // `agy` does have a `--sandbox`, but it restricts the terminal, not the
  // network — its real capture (test/fixtures/antigravity.jsonl) shows, on
  // the contrary, `open_browser_url`, `read_url_content` and `search_web`
  // tools. We do not pass it, and we would not know how to close it.
  network: "open",
};

/** Converts a duration in milliseconds to the Go syntax expected by `--print-timeout`. */
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

  // Antigravity has no working-directory flag: the SpawnPlan's cwd carries
  // the workspace. --add-dir keeps the task directory accessible for the
  // report and the final message.
  args.push("--add-dir", ctx.paths.dir);

  if (ctx.model) args.push("--model", ctx.model);
  if (ctx.reportVia === "schema" && ctx.schemaFile) {
    args.push("--json-schema", ctx.schemaFile);
  }

  // The machine's global configuration is in agentMode "plan" with a
  // restricted trustedWorkspaces list: it must be overridden explicitly
  // for write mode to actually apply.
  if (ctx.task.mode === "write") args.push("--dangerously-skip-permissions");

  args.push(...ctx.extraArgs);

  return { command: "agy", args, cwd: ctx.task.workspace, env: {}, files: [] };
}

/**
 * Translates the `agy --output-format stream-json` stream.
 *
 * Shapes observed on two real captures: `init`, `step_update` (types
 * `user_input`, `unknown`, `agent_response`, `checkpoint`, `error_message`)
 * and `result`. The top-level `error` shape was observed on neither of the
 * two; it follows the same `event`/payload convention as the confirmed
 * shapes and remains strictly defensive.
 *
 * Two findings from the current capture (`test/fixtures/antigravity.jsonl`),
 * which is a quota failure:
 *
 * - `result.error` carries the entire explanation ("Individual quota reached…")
 *   and was **not read**: three errors came one after another and the
 *   translated stream showed none of them. Only the engine's synthesized
 *   fallback, which copies the end of the raw log, hinted at what happened.
 * - `error_message` steps carry **no text**, not even an empty field. We
 *   still flag them: "an error occurred and the CLI says no more" informs,
 *   silence does not.
 *
 * Neither of the two captures triggered a tool — the first was trivial, the
 * second failed before acting. The `step_type` of tool steps therefore
 * remains unknown, and this adapter emits no `tool_use`: a branch written
 * from a plausible convention would be exactly the mistake that left
 * opencode's branch inoperative.
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
          { type: "error", message: "Antigravity reported an error, without giving its text in its stream.", fatal: false },
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
    // The error first: it explains the `finished` that follows, and it is
    // what we want to read at the top of the log when the task has failed.
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
