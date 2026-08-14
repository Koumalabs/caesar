import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copilotAgent } from "./copilot.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("copilot");

describe("copilotAgent.build", () => {
  it("denies write and shell in read-only, without ever allowing all tools", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(plan.args).toContain("--deny-tool=write");
    expect(plan.args).toContain("--deny-tool=shell");
    expect(plan.args).not.toContain("--allow-all-tools");
  });

  it("allows all tools in write mode, without deny-tool", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(plan.args).toContain("--allow-all-tools");
    expect(plan.args.some((a) => a.startsWith("--deny-tool"))).toBe(false);
  });

  it("opens URLs separately from tools — --allow-all-tools does not cover them", () => {
    // The original flaw: in write mode, copilot received --allow-all-tools
    // and still asked for confirmation on every network access — so, in
    // non-interactive execution, never got it.
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "write", network: true }) }));
    expect(plan.args).toContain("--allow-all-urls");
  });

  it("also opens URLs in read-only, without lifting the write denials", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "read-only", network: true }) }));
    expect(plan.args).toContain("--allow-all-urls");
    expect(plan.args).toContain("--deny-tool=write");
    expect(plan.args).toContain("--deny-tool=shell");
  });

  it("leaves URLs closed when the task does not have network access", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ network: false }) }));
    expect(plan.args).not.toContain("--allow-all-urls");
  });

  it("uses the workspace as cwd, without an explicit directory flag", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("keeps the task directory accessible via --add-dir", () => {
    const plan = copilotAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("only adds --model when a model is provided", () => {
    const without = copilotAgent.build(sampleContext());
    expect(without.args).not.toContain("--model");
    const withModel = copilotAgent.build(sampleContext({ model: "gpt-5.4" }));
    const index = withModel.args.indexOf("--model");
    expect(withModel.args[index + 1]).toBe("gpt-5.4");
  });

  it("drops an additional MCP config at the channel tier, referenced by @<file>", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "caesar" } });
    const plan = copilotAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file?.path).toBe(join(paths.dir, "copilot-mcp-config.json"));
    const content = JSON.parse(file?.content ?? "{}");
    expect(content.mcpServers.caesar).toEqual({ type: "local", command: "node", args: ["server.js"] });
    const index = plan.args.indexOf("--additional-mcp-config");
    expect(plan.args[index + 1]).toBe(`@${file?.path}`);
  });

  it("drops no file outside the channel tier", () => {
    const plan = copilotAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("places the prompt right after --prompt, then the raw arguments at the very end", () => {
    const plan = copilotAgent.build(sampleContext({ extraArgs: ["--yolo"] }));
    const index = plan.args.indexOf("--prompt");
    expect(plan.args[index + 1]).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--yolo");
  });
});

describe("copilotAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("picks channel when the channel is available", () => {
    expect(copilotAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("falls back to file without a channel (outputSchema false)", () => {
    expect(copilotAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("copilotAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "copilot.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("recognizes at least one event in the real capture (error path: Copilot quota exceeded)", () => {
    const all = lines.flatMap((line) => copilotAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("translates session.error into a fatal error event", () => {
    const line = lines.find((l) => l.includes('"session.error"'));
    expect(line).toBeDefined();
    const translation = copilotAgent.translate(line as string);
    expect(translation.events).toEqual([
      { type: "error", message: "You have exceeded your monthly quota (Request ID: CC5D:8E19C:2879C5E:332DD51:6A788BC6)", fatal: true },
    ]);
  });

  it("translates the terminal result line according to exitCode", () => {
    const line = lines.find((l) => l.includes('"type":"result"'));
    expect(line).toBeDefined();
    const translation = copilotAgent.translate(line as string);
    expect(translation.events).toEqual([{ type: "finished", status: "failed", summary: "", exit_code: 1 }]);
  });

  it("translates assistant.message (derived from the documentation, not observed) into message", () => {
    const line = JSON.stringify({ type: "assistant.message", data: { content: "OK" } });
    const translation = copilotAgent.translate(line);
    expect(translation.events).toEqual([{ type: "message", text: "OK" }]);
    expect(translation.finalText).toBe("OK");
  });

  it("ignores uninteresting session events (mcp, skills, tools_updated)", () => {
    const mcpLine = lines.find((l) => l.includes('"session.mcp_server_status_changed"'));
    const skillsLine = lines.find((l) => l.includes('"session.skills_loaded"'));
    const toolsLine = lines.find((l) => l.includes('"session.tools_updated"'));

    for (const line of [mcpLine, skillsLine, toolsLine]) {
      expect(line).toBeDefined();
      expect(copilotAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  it("silently ignores an empty line, invalid JSON, or unknown JSON", () => {
    expect(copilotAgent.translate("")).toEqual({ events: [] });
    expect(copilotAgent.translate("{not json")).toEqual({ events: [] });
    expect(copilotAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
