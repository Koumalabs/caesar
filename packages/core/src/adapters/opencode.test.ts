import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeAgent } from "./opencode.js";
import { makeSampleFactory } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("opencode");

describe("opencodeAgent.build", () => {
  it("has no native read-only mode: --auto only appears in write mode", () => {
    const readOnly = opencodeAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(readOnly.args).not.toContain("--auto");

    const write = opencodeAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(write.args).toContain("--auto");
  });

  it("passes the workspace via --dir and via the plan's cwd", () => {
    const plan = opencodeAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    const index = plan.args.indexOf("--dir");
    expect(plan.args[index + 1]).toBe("/tmp/wt");
  });

  it("only adds --model when a model is provided", () => {
    const without = opencodeAgent.build(sampleContext());
    expect(without.args).not.toContain("--model");
    const withModel = opencodeAgent.build(sampleContext({ model: "anthropic/claude-opus-5" }));
    const index = withModel.args.indexOf("--model");
    expect(withModel.args[index + 1]).toBe("anthropic/claude-opus-5");
  });

  it("relays task.role to --agent", () => {
    const without = opencodeAgent.build(sampleContext());
    expect(without.args).not.toContain("--agent");
    const withRole = opencodeAgent.build(sampleContext({ task: sampleTask({ role: "reviewer" }) }));
    const index = withRole.args.indexOf("--agent");
    expect(withRole.args[index + 1]).toBe("reviewer");
  });

  it("drops an opencode.json into the workspace at the channel tier", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "caesar" } });
    const plan = opencodeAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.path).toBe(join("/tmp/wt", "opencode.json"));
    const content = JSON.parse(plan.files[0]?.content ?? "{}");
    expect(content.mcp.caesar).toEqual({ type: "local", command: ["node", "server.js"], enabled: true });
  });

  it("drops no file outside the channel tier", () => {
    const plan = opencodeAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("places the prompt in final positional position, then the raw arguments", () => {
    const plan = opencodeAgent.build(sampleContext({ extraArgs: ["--pure"] }));
    expect(plan.args.at(-2)).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--pure");
  });
});

describe("opencodeAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("picks channel when the channel is available (mcpInjection project-config is not none)", () => {
    expect(opencodeAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("falls back to file without a channel (outputSchema false)", () => {
    expect(opencodeAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("opencodeAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "opencode.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("recognizes at least one event in the real capture", () => {
    const all = lines.flatMap((line) => opencodeAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("translates a text-typed part into message, and carries finalText", () => {
    const line = lines.find((l) => l.includes('"type":"text"'));
    expect(line).toBeDefined();
    const translation = opencodeAgent.translate(line as string);
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "message" });
    expect(translation.finalText).toBe((translation.events[0] as { text: string }).text);
    expect(translation.finalText).not.toBe("");
  });

  it("ignores step_start / step_finish, which carry no recognized content", () => {
    const stepStart = lines.find((l) => l.includes('"type":"step_start"'));
    const stepFinish = lines.find((l) => l.includes('"type":"step_finish"'));

    for (const line of [stepStart, stepFinish]) {
      expect(line).toBeDefined();
      expect(opencodeAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  /**
   * This block replaces a test that built its own `type: "tool-bash"` part,
   * with `part.input` and a string-typed `part.state` — the shape assumed
   * from the Vercel AI SDK conventions. It passed green, and validated a
   * shape opencode does not emit: no `tool_use` was produced for real, and
   * an opencode sub-agent appeared to use no tools at all. The assertions
   * now target the real capture.
   */
  it("translates the tool parts of the real capture, with their call identifier", () => {
    const toolEvents = lines.flatMap((line) => opencodeAgent.translate(line).events).filter((e) => e.type === "tool_use");
    expect(toolEvents.length).toBeGreaterThanOrEqual(2);

    const bash = toolEvents.find((e) => (e as { tool: string }).tool === "bash");
    expect(bash).toMatchObject({ type: "tool_use", tool: "bash", input_summary: "ls -1", status: "succeeded" });
    expect((bash as { id: string }).id).toBe("bash_1");

    // `state.title` is preferred over the serialized input: the latter
    // carries the whole content of the written file, unreadable in a live view.
    const write = toolEvents.find((e) => (e as { tool: string }).tool === "write");
    expect((write as { input_summary: string }).input_summary).toBe("note.txt");
  });

  it("falls back to the serialized input when the part carries no title", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "grep", callID: "grep_0", state: { status: "completed", input: { pattern: "TODO" } } },
    });
    expect(opencodeAgent.translate(line).events).toEqual([
      { type: "tool_use", tool: "grep", id: "grep_0", input_summary: '{"pattern":"TODO"}', status: "succeeded" },
    ]);
  });

  it("silently ignores an empty line, invalid JSON, or unknown JSON", () => {
    expect(opencodeAgent.translate("")).toEqual({ events: [] });
    expect(opencodeAgent.translate("{not json")).toEqual({ events: [] });
    expect(opencodeAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
