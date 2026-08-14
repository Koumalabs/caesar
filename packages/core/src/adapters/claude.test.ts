import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAgent } from "./claude.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("claude");

describe("claudeAgent.build", () => {
  it("requests the stream, not the single final object", () => {
    // `json` emits one object, at the very end: the sub-agent was mute
    // for its entire run. `--verbose` must accompany `stream-json`
    // under `--print`.
    const plan = claudeAgent.build(sampleContext());
    const index = plan.args.indexOf("--output-format");
    expect(plan.args[index + 1]).toBe("stream-json");
    expect(plan.args).toContain("--verbose");
    // No fragments: one event per few-character snippet would drown
    // `events.jsonl` without teaching anything more.
    expect(plan.args).not.toContain("--include-partial-messages");
  });

  it("picks --permission-mode plan in read-only mode", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    const index = plan.args.indexOf("--permission-mode");
    expect(plan.args[index + 1]).toBe("plan");
  });

  it("picks --permission-mode acceptEdits in write mode", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    const index = plan.args.indexOf("--permission-mode");
    expect(plan.args[index + 1]).toBe("acceptEdits");
  });

  it("uses the workspace as cwd, without an explicit directory flag", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("keeps the task directory accessible via --add-dir", () => {
    const plan = claudeAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("only adds --model when a model is provided", () => {
    const without = claudeAgent.build(sampleContext());
    expect(without.args).not.toContain("--model");
    const withModel = claudeAgent.build(sampleContext({ model: "sonnet" }));
    const index = withModel.args.indexOf("--model");
    expect(withModel.args[index + 1]).toBe("sonnet");
  });

  it("drops an MCP config at the channel tier, referenced by --mcp-config", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "caesar" } });
    const plan = claudeAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file?.path).toBe(join(paths.dir, "claude-mcp-config.json"));
    const content = JSON.parse(file?.content ?? "{}");
    expect(content.mcpServers.caesar).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
    const index = plan.args.indexOf("--mcp-config");
    expect(plan.args[index + 1]).toBe(file?.path);
  });

  it("drops no file outside the channel tier", () => {
    const plan = claudeAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("places the prompt right after --print, then the raw arguments at the very end", () => {
    const plan = claudeAgent.build(sampleContext({ extraArgs: ["--debug"] }));
    const index = plan.args.indexOf("--print");
    expect(plan.args[index + 1]).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--debug");
  });
});

describe("claudeAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("picks channel when the channel is available", () => {
    expect(claudeAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("falls back to file without a channel (outputSchema false)", () => {
    expect(claudeAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("claudeAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "claude.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("recognizes at least one event in the real capture", () => {
    const all = lines.flatMap((line) => claudeAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("shows the agent at work well before the end of the task", () => {
    // The flaw the switch to `stream-json` fixes: in `json`, the whole
    // capture fit on **a single line**, emitted at the very end. A claude
    // sub-agent was mute from the start to the end of its run.
    expect(lines.length).toBeGreaterThan(10);
    const resultIndex = lines.findIndex((l) => l.includes('"type":"result"'));
    const beforeEnd = lines.slice(0, resultIndex).flatMap((line) => claudeAgent.translate(line).events);
    expect(beforeEnd.filter((e) => e.type === "tool_use").length).toBeGreaterThan(0);
    expect(beforeEnd.filter((e) => e.type === "message").length).toBeGreaterThan(0);
  });

  it("translates the final result line into message + finished, and carries finalText", () => {
    // What the switch does not change, and that is what made it safe: the
    // final line always carries `type`, `result` and `is_error` at the top
    // level. The report-extraction fallback thus keeps the same source.
    const line = lines.find((l) => l.includes('"type":"result"'));
    expect(line).toBeDefined();
    const translation = claudeAgent.translate(line as string);
    expect(translation.events).toHaveLength(2);
    expect(translation.events[0]).toMatchObject({ type: "message" });
    expect(translation.events[1]).toEqual({ type: "finished", status: "success", summary: "", exit_code: null });
    expect(translation.finalText).toBe((translation.events[0] as { text: string }).text);
    expect(translation.finalText).not.toBe("");
  });

  it("opens a tool on a tool_use block, with a readable summary", () => {
    const line = lines.find((l) => l.includes('"type":"tool_use"') && l.includes('"Bash"'));
    expect(line).toBeDefined();
    const events = claudeAgent.translate(line as string).events;
    expect(events).toHaveLength(1);
    // The summary comes from `input.command`, not the serialized input — for
    // `Write`, the latter would carry the whole content of the file.
    expect(events[0]).toMatchObject({ type: "tool_use", tool: "Bash", input_summary: "ls -1", status: "started" });
    expect((events[0] as { id: string }).id).toMatch(/^toolu_/);
  });

  it("closes the tool on the matching tool_result, by identifier alone", () => {
    // A `tool_result` block carries only `tool_use_id`, never the tool's
    // name, and `translate` is stateless by contract: the closing therefore
    // arrives with an empty `tool`. The identifier is what ties it to its
    // opening, not the name.
    const open = lines.find((l) => l.includes('"type":"tool_use"') && l.includes('"Bash"'));
    const close = lines.find((l) => l.includes('"tool_result"') && l.includes('"note.txt\\nREADME.md"'));
    expect(close).toBeDefined();
    const openEvent = claudeAgent.translate(open as string).events[0] as { id: string };
    const closeEvents = claudeAgent.translate(close as string).events;
    expect(closeEvents).toEqual([{ type: "tool_use", tool: "", id: openEvent.id, input_summary: "", status: "succeeded" }]);
  });

  it("marks the tool failed when the tool_result carries is_error", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "boom", is_error: true }] },
    });
    expect(claudeAgent.translate(line).events).toEqual([
      { type: "tool_use", tool: "", id: "toolu_x", input_summary: "", status: "failed" },
    ]);
  });

  it("translates thinking_tokens into progress — the only usable thinking signal", () => {
    // The stream's `thinking` blocks arrive with their text empty (the API
    // only returns their signature): without this line, a long reasoning
    // phase would be indistinguishable from a frozen agent.
    const line = lines.find((l) => l.includes('"thinking_tokens"'));
    expect(line).toBeDefined();
    const events = claudeAgent.translate(line as string).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "progress" });
    expect((events[0] as { message: string }).message).toContain("tokens");
  });

  it("never emits a hollow thinking", () => {
    const empty = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } });
    expect(claudeAgent.translate(empty).events).toEqual([]);
    const full = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "I am thinking." }] } });
    expect(claudeAgent.translate(full).events).toEqual([{ type: "thinking", text: "I am thinking." }]);
  });

  it("ignores setup system lines (hooks, init)", () => {
    for (const subtype of ["hook_started", "hook_response", "init"]) {
      const line = lines.find((l) => l.includes(`"subtype":"${subtype}"`));
      expect(line).toBeDefined();
      expect(claudeAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  it("marks finished as failed when is_error is true", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "Error" });
    const translation = claudeAgent.translate(line);
    expect(translation.events).toContainEqual({ type: "finished", status: "failed", summary: "", exit_code: null });
  });

  it("silently ignores an empty line, invalid JSON, or unknown JSON", () => {
    expect(claudeAgent.translate("")).toEqual({ events: [] });
    expect(claudeAgent.translate("{not json")).toEqual({ events: [] });
    expect(claudeAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
