import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { taskPaths, TaskSchema, TASK_PROTOCOL, type Task, type TaskPaths } from "@orch/protocol";
import { describe, expect, it } from "vitest";
import type { BuildContext } from "../registry/types.js";
import { opencodeAgent } from "./opencode.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

function sampleTask(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    protocol: TASK_PROTOCOL,
    id: "t_0001",
    created_at: "2026-08-09T10:00:00.000Z",
    agent: "opencode",
    objective: "Corriger la régression",
    mode: "write",
    isolation: "worktree",
    workspace: "/tmp/wt",
    deadline_ms: 600_000,
    report_path: "/tmp/task/report.json",
    events_path: "/tmp/task/events.jsonl",
    ...overrides,
  });
}

const paths: TaskPaths = taskPaths("/tmp/task");

function sampleContext(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    task: sampleTask(),
    paths,
    prompt: "PROMPT",
    reportVia: "file",
    extraArgs: [],
    ...overrides,
  };
}

describe("opencodeAgent.build", () => {
  it("n'a pas de mode lecture seule natif : --auto n'apparaît qu'en écriture", () => {
    const readOnly = opencodeAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(readOnly.args).not.toContain("--auto");

    const write = opencodeAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(write.args).toContain("--auto");
  });

  it("passe le workspace par --dir et par le cwd du plan", () => {
    const plan = opencodeAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    const index = plan.args.indexOf("--dir");
    expect(plan.args[index + 1]).toBe("/tmp/wt");
  });

  it("n'ajoute --model que si un modèle est fourni", () => {
    const sans = opencodeAgent.build(sampleContext());
    expect(sans.args).not.toContain("--model");
    const avec = opencodeAgent.build(sampleContext({ model: "anthropic/claude-opus-5" }));
    const index = avec.args.indexOf("--model");
    expect(avec.args[index + 1]).toBe("anthropic/claude-opus-5");
  });

  it("relaie task.role vers --agent", () => {
    const sans = opencodeAgent.build(sampleContext());
    expect(sans.args).not.toContain("--agent");
    const avec = opencodeAgent.build(sampleContext({ task: sampleTask({ role: "reviewer" }) }));
    const index = avec.args.indexOf("--agent");
    expect(avec.args[index + 1]).toBe("reviewer");
  });

  it("dépose un opencode.json dans le workspace au palier channel", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "orch" } });
    const plan = opencodeAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.path).toBe(join("/tmp/wt", "opencode.json"));
    const content = JSON.parse(plan.files[0]?.content ?? "{}");
    expect(content.mcp.orch).toEqual({ type: "local", command: ["node", "server.js"], enabled: true });
  });

  it("ne dépose aucun fichier hors du palier channel", () => {
    const plan = opencodeAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("place le prompt en position positionnelle finale, puis les arguments bruts", () => {
    const plan = opencodeAgent.build(sampleContext({ extraArgs: ["--pure"] }));
    expect(plan.args.at(-2)).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--pure");
  });
});

describe("opencodeAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("choisit channel quand le canal est disponible (mcpInjection project-config n'est pas none)", () => {
    expect(opencodeAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("retombe sur file sans canal (outputSchema faux)", () => {
    expect(opencodeAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("opencodeAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "opencode.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("reconnaît au moins un événement dans la capture réelle", () => {
    const all = lines.flatMap((line) => opencodeAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("traduit une part de type text en message, et porte finalText", () => {
    const line = lines.find((l) => l.includes('"type":"text"'));
    expect(line).toBeDefined();
    const translation = opencodeAgent.translate(line as string);
    expect(translation.events).toEqual([{ type: "message", text: "OK" }]);
    expect(translation.finalText).toBe("OK");
  });

  it("ignore step_start / step_finish, qui ne portent pas de contenu reconnu", () => {
    const line = lines.find((l) => l.includes('"type":"step_start"'));
    expect(line).toBeDefined();
    expect(opencodeAgent.translate(line as string)).toEqual({ events: [] });
  });

  it("traduit une part tool-<nom> de façon défensive", () => {
    const line = JSON.stringify({
      type: "tool",
      part: { type: "tool-bash", input: { command: "ls" }, state: "output-available" },
    });
    const translation = opencodeAgent.translate(line);
    expect(translation.events).toEqual([
      { type: "tool_use", tool: "bash", input_summary: '{"command":"ls"}', status: "succeeded" },
    ]);
  });

  it("ignore silencieusement une ligne vide, du JSON invalide, ou du JSON inconnu", () => {
    expect(opencodeAgent.translate("")).toEqual({ events: [] });
    expect(opencodeAgent.translate("{not json")).toEqual({ events: [] });
    expect(opencodeAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
