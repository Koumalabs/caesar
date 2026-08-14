import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { antigravityAgent } from "./antigravity.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("antigravity");

describe("antigravityAgent.build", () => {
  it("picks plan mode in read-only, without --dangerously-skip-permissions", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    const index = plan.args.indexOf("--mode");
    expect(plan.args[index + 1]).toBe("plan");
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
  });

  it("picks accept-edits mode in write, with --dangerously-skip-permissions", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    const index = plan.args.indexOf("--mode");
    expect(plan.args[index + 1]).toBe("accept-edits");
    expect(plan.args).toContain("--dangerously-skip-permissions");
  });

  it("has no working-directory flag: the plan's cwd carries the workspace", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    expect(plan.args).not.toContain("--dir");
    expect(plan.args).not.toContain("-C");
    expect(plan.args).not.toContain("--cwd");
  });

  it("keeps the task directory accessible via --add-dir", () => {
    const plan = antigravityAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("only adds --model when a model is provided", () => {
    const without = antigravityAgent.build(sampleContext());
    expect(without.args).not.toContain("--model");
    const withModel = antigravityAgent.build(sampleContext({ model: "gemini-pro" }));
    const index = withModel.args.indexOf("--model");
    expect(withModel.args[index + 1]).toBe("gemini-pro");
  });

  it("only adds --json-schema at the schema tier", () => {
    const plan = antigravityAgent.build(sampleContext({ reportVia: "schema", schemaFile: "/tmp/task/schema.json" }));
    const index = plan.args.indexOf("--json-schema");
    expect(plan.args[index + 1]).toBe("/tmp/task/schema.json");

    const without = antigravityAgent.build(sampleContext({ reportVia: "file" }));
    expect(without.args).not.toContain("--json-schema");
  });

  it.each([
    [60_000, "1m"],
    [90_000, "90s"],
    [900_000, "15m"],
    [3_600_000, "1h"],
  ])("derives --print-timeout from deadline_ms=%i as %s", (deadlineMs, expected) => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ deadline_ms: deadlineMs }) }));
    const index = plan.args.indexOf("--print-timeout");
    expect(plan.args[index + 1]).toBe(expected);
  });
});

describe("antigravityAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("picks channel when the channel is available (mcpInjection global-config is not none)", () => {
    expect(antigravityAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("falls back to schema without a channel (outputSchema true)", () => {
    expect(antigravityAgent.preferredReportChannel(task, false)).toBe("schema");
  });
});

describe("antigravityAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "antigravity.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("recognizes at least one event in the real capture", () => {
    const all = lines.flatMap((line) => antigravityAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("translates a text-bearing agent_response step_update into message, and carries finalText", () => {
    // Reconstructed: the current capture is a quota failure, where the
    // `agent_response` steps arrive without `text_delta` (the model produced
    // nothing). The shape, though, comes from an earlier capture that had it.
    const line = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "c", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "OK\n" },
    });
    const translation = antigravityAgent.translate(line);
    expect(translation.events).toEqual([{ type: "message", text: "OK\n" }]);
    expect(translation.finalText).toBe("OK\n");
  });

  it("ignores an agent_response without text_delta rather than emitting an empty message", () => {
    const line = lines.find((l) => l.includes('"agent_response"'));
    expect(line).toBeDefined();
    expect(antigravityAgent.translate(line as string)).toEqual({ events: [] });
  });

  it("finally makes the error carried by result.error readable", () => {
    // The flaw this capture revealed: `result.error` carried the whole
    // explanation of the failure ("Individual quota reached…") and was not
    // read. Three errors came one after another with none of them visible.
    const line = lines.find((l) => l.includes('"event":"result"'));
    expect(line).toBeDefined();
    const translation = antigravityAgent.translate(line as string);
    expect(translation.events).toHaveLength(2);
    expect(translation.events[0]).toMatchObject({ type: "error", fatal: true });
    expect((translation.events[0] as { message: string }).message).toContain("quota");
    expect(translation.events[1]).toMatchObject({ type: "finished", status: "failed" });
    // The reason also accompanies the end of the task, not only the error.
    expect((translation.events[1] as { summary: string }).summary).toContain("quota");
  });

  it("translates a success's result line into a successful finished, and carries finalText", () => {
    const line = JSON.stringify({
      event: "result",
      result: { conversation_id: "c", status: "SUCCESS", response: "OK\n", duration_seconds: 5 },
    });
    const translation = antigravityAgent.translate(line);
    expect(translation.events).toEqual([{ type: "finished", status: "success", summary: "", exit_code: null }]);
    expect(translation.finalText).toBe("OK\n");
  });

  it("flags an error_message step, unable to say its content", () => {
    // These steps carry no text, not even an empty field. Keeping quiet about
    // them would let the task look silent while it is failing.
    const line = lines.find((l) => l.includes('"step_type":"error_message"'));
    expect(line).toBeDefined();
    const translation = antigravityAgent.translate(line as string);
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "error", fatal: false });
  });

  it("ignores uninteresting step_updates (init, user_input, unknown)", () => {
    const initLine = lines.find((l) => l.includes('"event":"init"'));
    const userInputLine = lines.find((l) => l.includes('"step_type":"user_input"'));
    const unknownLine = lines.find((l) => l.includes('"step_type":"unknown"'));

    for (const line of [initLine, userInputLine, unknownLine]) {
      expect(line).toBeDefined();
      expect(antigravityAgent.translate(line as string)).toEqual({ events: [] });
    }
    // `checkpoint` does not appear in this capture (it fails earlier);
    // its shape stays ignored in the same way.
    const checkpoint = JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "c", step_index: 4, state: "DONE", step_type: "checkpoint" },
    });
    expect(antigravityAgent.translate(checkpoint)).toEqual({ events: [] });
  });

  it("silently ignores an empty line, invalid JSON, or unknown JSON", () => {
    expect(antigravityAgent.translate("")).toEqual({ events: [] });
    expect(antigravityAgent.translate("{not json")).toEqual({ events: [] });
    expect(antigravityAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
