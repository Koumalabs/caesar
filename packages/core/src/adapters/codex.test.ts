import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAgent } from "./codex.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("codex");

describe("codexAgent.build", () => {
  it("picks the read-only sandbox in read-only mode", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(plan.args).toContain("read-only");
    expect(plan.args).not.toContain("workspace-write");
  });

  it("picks the workspace-write sandbox in write mode", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(plan.args).toContain("workspace-write");
    expect(plan.args).not.toContain("read-only");
  });

  it("only adds -m when a model is provided", () => {
    const without = codexAgent.build(sampleContext());
    expect(without.args).not.toContain("-m");

    const withModel = codexAgent.build(sampleContext({ model: "o3" }));
    const index = withModel.args.indexOf("-m");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(withModel.args[index + 1]).toBe("o3");
  });

  it("only adds --output-schema at the schema tier, with a file provided", () => {
    const viaSchema = codexAgent.build(sampleContext({ reportVia: "schema", schemaFile: "/tmp/task/schema.json" }));
    const index = viaSchema.args.indexOf("--output-schema");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(viaSchema.args[index + 1]).toBe("/tmp/task/schema.json");

    const viaFile = codexAgent.build(sampleContext({ reportVia: "file" }));
    expect(viaFile.args).not.toContain("--output-schema");
  });

  it("adds -o when a final message path is provided, whatever the tier", () => {
    const plan = codexAgent.build(sampleContext({ reportVia: "channel", finalMessageFile: "/tmp/task/final.txt" }));
    const index = plan.args.indexOf("-o");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(plan.args[index + 1]).toBe("/tmp/task/final.txt");
  });

  it("wires the MCP channel with -c flags at the channel tier", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "caesar" } });
    const plan = codexAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.args).toContain("-c");
    expect(plan.args).toContain('mcp_servers.caesar.command="node"');
    expect(plan.args).toContain('mcp_servers.caesar.args=["server.js"]');
  });

  it("declares no MCP server when the tier is not channel, even if a channel exists", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: [], server_name: "caesar" } });
    const plan = codexAgent.build(sampleContext({ task, reportVia: "file" }));
    // The assertion used to check the absence of any "-c" — a shortcut no
    // longer valid since the network uses the same flag. What matters is
    // the content: no server declaration.
    expect(plan.args.filter((arg) => arg.startsWith("mcp_servers."))).toEqual([]);
  });

  it("opens the sandbox network when the task is entitled to it", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ network: true }) }));
    expect(plan.args).toContain("sandbox_workspace_write.network_access=true");
  });

  it("leaves the network alone when the task does not have it", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ network: false }) }));
    expect(plan.args.some((arg) => arg.includes("network_access"))).toBe(false);
  });

  it("keeps the task directory accessible via --add-dir", () => {
    const plan = codexAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("places the prompt in final positional position, then the raw arguments", () => {
    const plan = codexAgent.build(sampleContext({ extraArgs: ["--enable", "feature_x"] }));
    expect(plan.args.at(-3)).toBe("PROMPT");
    expect(plan.args.at(-2)).toBe("--enable");
    expect(plan.args.at(-1)).toBe("feature_x");
  });

  it("uses the workspace as cwd and as -C", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    const index = plan.args.indexOf("-C");
    expect(plan.args[index + 1]).toBe("/tmp/wt");
  });
});

describe("codexAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("picks channel when the channel is available", () => {
    expect(codexAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("falls back to schema without a channel (outputSchema true)", () => {
    expect(codexAgent.preferredReportChannel(task, false)).toBe("schema");
  });
});

describe("codexAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "codex.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("recognizes at least one event in the real capture", () => {
    const all = lines.flatMap((line) => codexAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("translates the agent's message into a message event, and carries finalText", () => {
    // The text is no longer asserted literally: the capture now carries a
    // real task (write a file, run two commands), whose messages are the
    // agent's successive reports. The shape is what matters — a single
    // `message` whose text feeds `finalText`.
    const messageLine = lines.find((l) => l.includes('"agent_message"'));
    expect(messageLine).toBeDefined();
    const translation = codexAgent.translate(messageLine as string);
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "message" });
    expect(translation.finalText).toBe((translation.events[0] as { text: string }).text);
    expect(translation.finalText).not.toBe("");
  });

  it("announces a command at its start, without waiting for it to finish", () => {
    // The main gain from re-reading the captures: `item.started` does
    // exist. Without it, a three-minute `npm install` only appeared at the
    // third minute — the task seemed frozen in the meantime.
    const startedLine = lines.find((l) => l.includes('"item.started"') && l.includes('"command_execution"'));
    expect(startedLine).toBeDefined();
    const translation = codexAgent.translate(startedLine as string);
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "tool_use", tool: "shell", status: "started" });
    expect((translation.events[0] as { id: string }).id).not.toBe("");
    expect((translation.events[0] as { input_summary: string }).input_summary).not.toBe("");
  });

  it("pairs the start and the end of a same command by their identifier", () => {
    const started = lines.find((l) => l.includes('"item.started"') && l.includes('"command_execution"'));
    const completed = lines.find((l) => l.includes('"item.completed"') && l.includes('"command_execution"'));
    const open = codexAgent.translate(started as string).events[0] as { id: string; status: string };
    const close = codexAgent.translate(completed as string).events[0] as { id: string; status: string };
    expect(open.status).toBe("started");
    expect(close.status).toBe("succeeded");
    expect(close.id).toBe(open.id);
  });

  it("translates a file_change item into file_changed, once only", () => {
    const started = lines.find((l) => l.includes('"item.started"') && l.includes('"file_change"'));
    const completed = lines.find((l) => l.includes('"item.completed"') && l.includes('"file_change"'));
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    // The `item.started` shape carries exactly the same changes: translating
    // it too would make every file appear duplicated.
    expect(codexAgent.translate(started as string).events).toEqual([]);
    expect(codexAgent.translate(completed as string).events).toEqual([
      { type: "file_changed", path: "/tmp/caesar-capture/note.txt", action: "created" },
    ]);
  });

  it("translates the error item into a non-fatal error event", () => {
    // Absent from the current capture — it succeeds — but observed in an
    // earlier capture. The line is therefore reconstructed here rather than
    // looked up in the fixture: the branch stays covered without pretending
    // the current stream contains it.
    const errorLine = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "The model refused the request." },
    });
    const translation = codexAgent.translate(errorLine);
    expect(translation.events).toEqual([{ type: "error", message: "The model refused the request.", fatal: false }]);
  });

  it("translates turn.completed into a successful finished", () => {
    const turnLine = lines.find((l) => l.includes('"turn.completed"'));
    expect(turnLine).toBeDefined();
    const translation = codexAgent.translate(turnLine as string);
    expect(translation.events).toEqual([{ type: "finished", status: "success", summary: "", exit_code: null }]);
  });

  it("silently ignores an empty line", () => {
    expect(codexAgent.translate("")).toEqual({ events: [] });
    expect(codexAgent.translate("   ")).toEqual({ events: [] });
  });

  it("silently ignores invalid JSON", () => {
    expect(codexAgent.translate("{not json")).toEqual({ events: [] });
  });

  it("silently ignores valid but unknown JSON", () => {
    expect(codexAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
    expect(codexAgent.translate('[1,2,3]')).toEqual({ events: [] });
  });
});
