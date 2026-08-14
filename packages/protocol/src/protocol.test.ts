import { describe, expect, it } from "vitest";
import {
  EventSchema,
  ReportSchema,
  TaskSchema,
  extractReportFromText,
  jsonSchemaFor,
  makeEvent,
  parseReport,
  renderTaskPrompt,
  strictReportJsonSchema,
  REPORT_PROTOCOL,
  TASK_PROTOCOL,
  EVENT_PROTOCOL,
  type Task,
} from "./index.js";

function sampleTask(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_0001",
    created_at: "2026-08-09T10:00:00.000Z",
    agent: "codex",
    objective: "Fix the regression in the parser",
    mode: "write",
    isolation: "worktree",
    workspace: "/tmp/wt",
    deadline_ms: 600_000,
    report_path: "/tmp/task/report.json",
    events_path: "/tmp/task/events.jsonl",
    ...overrides,
  });
}

describe("task", () => {
  it("fills the optional fields with neutral values", () => {
    const task = sampleTask();
    expect(task.context).toBe("");
    expect(task.constraints).toEqual([]);
    expect(task.depth).toBe(0);
  });

  it("rejects an unknown protocol version", () => {
    const result = TaskSchema.safeParse({ ...sampleTask(), protocol: "caesar.task/v2" });
    expect(result.success).toBe(false);
  });

  it('reads back a task written before the "network" field existed', () => {
    // The task.json files already present in .caesar/tasks/ are reopened by
    // `caesar ps`, `caesar logs` and `caesar diff`: without a default, this field
    // would have made them all unreadable at once.
    const { network, ...old } = sampleTask();
    expect(network).toBe(true);
    expect(TaskSchema.parse(old).network).toBe(true);
  });
});

describe("report", () => {
  it("accepts a minimal report, such as an outside agent would produce", () => {
    const report = ReportSchema.parse({
      protocol: REPORT_PROTOCOL,
      status: "success",
      summary: "Done.",
    });
    expect(report.changes).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.task_id).toBe("");
  });

  it("rejects a status outside the vocabulary", () => {
    const result = ReportSchema.safeParse({
      protocol: REPORT_PROTOCOL,
      status: "almost",
      summary: "…",
    });
    expect(result.success).toBe(false);
  });
});

describe("report extraction from free-form text", () => {
  const valid = JSON.stringify({
    protocol: REPORT_PROTOCOL,
    status: "success",
    summary: "Two files modified.",
  });

  it("reads a fenced code block", () => {
    const text = ["Here is the result.", "", "```json caesar:report", valid, "```"].join("\n");
    expect(extractReportFromText(text)?.summary).toBe("Two files modified.");
  });

  it("reads an ordinary json block", () => {
    const text = ["Finished.", "```json", valid, "```", "Have a nice day."].join("\n");
    expect(extractReportFromText(text)?.status).toBe("success");
  });

  it("recovers a JSON object drowned in prose", () => {
    const text = `blah blah ${valid} and there you go`;
    expect(extractReportFromText(text)?.summary).toBe("Two files modified.");
  });

  it("is not fooled by a brace inside a string", () => {
    const tricky = JSON.stringify({
      protocol: REPORT_PROTOCOL,
      status: "partial",
      summary: 'contains a brace } and a "quote"',
    });
    expect(extractReportFromText(`prose ${tricky} end`)?.status).toBe("partial");
  });

  it("keeps the last report when the agent corrects itself", () => {
    const first = JSON.stringify({ protocol: REPORT_PROTOCOL, status: "failed", summary: "missed" });
    const second = JSON.stringify({ protocol: REPORT_PROTOCOL, status: "success", summary: "good in the end" });
    expect(extractReportFromText(`${first}\n\nCorrection:\n${second}`)?.status).toBe("success");
  });

  it("I1 (final review): recovers a valid report even when \"protocol\" is not the first key, with a nested object before it", () => {
    // Literal repro from the review report: a nested object (changes[0])
    // precedes the "protocol" field in the same object — before I1, the
    // first "{" walked back from the marker was that nested object's,
    // not the report's, and extractReportFromText returned null.
    const text = JSON.stringify({
      task_id: "t1",
      status: "success",
      summary: "done",
      changes: [{ path: "a.ts", action: "modified", summary: "x" }],
      protocol: REPORT_PROTOCOL,
    });
    const parsed = extractReportFromText(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe("success");
    expect(parsed?.changes).toEqual([{ path: "a.ts", action: "modified", summary: "x" }]);
  });

  it("returns null when there is nothing usable", () => {
    expect(extractReportFromText("I am done, everything is fine")).toBeNull();
    expect(extractReportFromText(`{"protocol":"${REPORT_PROTOCOL}"`)).toBeNull();
  });
});

describe("events", () => {
  it("builds a complete event from only the useful fields", () => {
    const event = makeEvent("t_1", 3, "tool_use", { tool: "bash", input_summary: "ls" });
    expect(event.protocol).toBe(EVENT_PROTOCOL);
    expect(event.seq).toBe(3);
    if (event.type === "tool_use") expect(event.status).toBe("started");
  });

  it("discriminates the variants correctly", () => {
    const result = EventSchema.safeParse({
      protocol: EVENT_PROTOCOL,
      seq: 0,
      at: "2026-08-09T10:00:00.000Z",
      task_id: "t_1",
      type: "finished",
      status: "success",
    });
    expect(result.success).toBe(true);
  });
});

describe("publishing the standard", () => {
  it("produces a JSON Schema for each document", () => {
    for (const name of ["task", "report", "event"] as const) {
      expect(jsonSchemaFor(name)).toHaveProperty("$schema");
    }
  });

  it("locks down the strict schema for native structured outputs", () => {
    const schema = strictReportJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("changes");
  });

  it("every object declares `required` over the entirety of its properties, at any depth", () => {
    // The invariant the provider enforces, and that nothing was checking: a
    // single property missing from `required`, however deep, gets the
    // entire request rejected before the model answers. Observed on a real
    // delegation to Codex, on `commands_run.items.exit_code`:
    //   Invalid schema for response_format 'codex_output_schema':
    //   In context=('properties', 'commands_run', 'items'), 'required' is
    //   required to be supplied and to be an array including every key in
    //   properties. Missing 'exit_code'.
    const incomplete: string[] = [];
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      const properties = schema["properties"];
      if (properties && typeof properties === "object") {
        const declared = Object.keys(properties as Record<string, unknown>);
        const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
        const missing = declared.filter((key) => !required.has(key));
        if (missing.length > 0) incomplete.push(`${path} → ${missing.join(", ")}`);
      }
      for (const [key, value] of Object.entries(schema)) visit(value, `${path}/${key}`);
    };
    visit(strictReportJsonSchema(), "#");

    expect(incomplete).toEqual([]);
  });

  it("I2 (final review): a purely optional field is nullable rather than omitted from `required`", () => {
    // I2's intent still holds — not forcing the model to fabricate a
    // `usage.cost_usd` (an invented measured cost) nor a `findings[].line`
    // (a fallback `0` then failed revalidation by ReportSchema,
    // exclusiveMinimum: 0) — but it now holds through nullability, the only
    // means compatible with the invariant above.
    const schema = strictReportJsonSchema() as {
      properties: {
        findings: { items: { properties: Record<string, unknown>; required: string[] } };
        details: Record<string, unknown>;
      };
      required: string[];
    };

    const acceptsNull = (node: unknown): boolean => {
      const anyOf = (node as { anyOf?: unknown[] }).anyOf;
      return Array.isArray(anyOf) && anyOf.some((branch) => (branch as { type?: string }).type === "null");
    };

    expect(schema.required).toContain("usage");
    expect(acceptsNull(schema.properties["usage" as keyof typeof schema.properties])).toBe(true);

    const finding = schema.properties.findings.items;
    expect(finding.required).toEqual(expect.arrayContaining(["severity", "title", "file", "line"]));
    expect(acceptsNull(finding.properties["file"])).toBe(true);
    expect(acceptsNull(finding.properties["line"])).toBe(true);

    // A field carrying a default does not become nullable: repeating the
    // default is never a fabrication.
    expect(acceptsNull(schema.properties.details)).toBe(false);
    expect(schema.required).toContain("changes");
    expect(schema.required).toContain("details");
  });

  it("accepts a report whose optional fields are `null`", () => {
    // The counterpart of the nullable schema: what the model actually
    // returns must remain validatable, otherwise the "native output schema"
    // tier would fall back to a degraded tier for nothing.
    const report = parseReport({
      protocol: REPORT_PROTOCOL,
      status: "success",
      summary: "Done.",
      usage: null,
      findings: [{ severity: "info", title: "Note", file: null, line: null, detail: "" }],
      commands_run: [{ command: "ls", exit_code: null, note: "" }],
    });

    expect(report.usage).toBeUndefined();
    expect(report.findings[0]?.file).toBeUndefined();
    expect(report.findings[0]?.line).toBeUndefined();
    expect(report.commands_run[0]?.command).toBe("ls");
  });
});

describe("task prompt", () => {
  it("explicitly forbids writing in read-only mode", () => {
    const prompt = renderTaskPrompt(sampleTask({ mode: "read-only" }), { reportVia: "file" });
    expect(prompt).toContain("read-only investigation");
  });

  it("states the report path on the file tier", () => {
    const prompt = renderTaskPrompt(sampleTask(), { reportVia: "file" });
    expect(prompt).toContain("/tmp/task/report.json");
  });

  it("points to the return channel when it is available", () => {
    const prompt = renderTaskPrompt(sampleTask(), { reportVia: "channel", channelServerName: "caesar" });
    expect(prompt).toContain("submit_report");
    expect(prompt).toContain("ask_orchestrator");
  });

  it("warns the agent when the network is cut off, rather than letting it wear itself out on it", () => {
    const prompt = renderTaskPrompt(sampleTask({ network: false }), { reportVia: "file" });
    expect(prompt).toContain("No network access");
    expect(prompt).toContain("install packages");
  });

  it("asserts nothing about the network when it is available", () => {
    // The orchestrator only says about the network what it can guarantee:
    // for an agent whose confinement it does not control, the field stays
    // true and the brief stays silent.
    expect(renderTaskPrompt(sampleTask(), { reportVia: "file" })).not.toContain("network");
  });
});
