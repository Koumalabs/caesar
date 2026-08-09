import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { antigravityAgent } from "./antigravity.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("antigravity");

describe("antigravityAgent.build", () => {
  it("choisit le mode plan en lecture seule, sans --dangerously-skip-permissions", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    const index = plan.args.indexOf("--mode");
    expect(plan.args[index + 1]).toBe("plan");
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
  });

  it("choisit le mode accept-edits en écriture, avec --dangerously-skip-permissions", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    const index = plan.args.indexOf("--mode");
    expect(plan.args[index + 1]).toBe("accept-edits");
    expect(plan.args).toContain("--dangerously-skip-permissions");
  });

  it("n'a aucun flag de répertoire de travail : le cwd du plan porte le workspace", () => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    expect(plan.args).not.toContain("--dir");
    expect(plan.args).not.toContain("-C");
    expect(plan.args).not.toContain("--cwd");
  });

  it("garde le répertoire de tâche accessible via --add-dir", () => {
    const plan = antigravityAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("n'ajoute --model que si un modèle est fourni", () => {
    const sans = antigravityAgent.build(sampleContext());
    expect(sans.args).not.toContain("--model");
    const avec = antigravityAgent.build(sampleContext({ model: "gemini-pro" }));
    const index = avec.args.indexOf("--model");
    expect(avec.args[index + 1]).toBe("gemini-pro");
  });

  it("n'ajoute --json-schema qu'au palier schema", () => {
    const plan = antigravityAgent.build(sampleContext({ reportVia: "schema", schemaFile: "/tmp/task/schema.json" }));
    const index = plan.args.indexOf("--json-schema");
    expect(plan.args[index + 1]).toBe("/tmp/task/schema.json");

    const sans = antigravityAgent.build(sampleContext({ reportVia: "file" }));
    expect(sans.args).not.toContain("--json-schema");
  });

  it.each([
    [60_000, "1m"],
    [90_000, "90s"],
    [900_000, "15m"],
    [3_600_000, "1h"],
  ])("dérive --print-timeout de deadline_ms=%i en %s", (deadlineMs, expected) => {
    const plan = antigravityAgent.build(sampleContext({ task: sampleTask({ deadline_ms: deadlineMs }) }));
    const index = plan.args.indexOf("--print-timeout");
    expect(plan.args[index + 1]).toBe(expected);
  });
});

describe("antigravityAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("choisit channel quand le canal est disponible (mcpInjection global-config n'est pas none)", () => {
    expect(antigravityAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("retombe sur schema sans canal (outputSchema vrai)", () => {
    expect(antigravityAgent.preferredReportChannel(task, false)).toBe("schema");
  });
});

describe("antigravityAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "antigravity.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("reconnaît au moins un événement dans la capture réelle", () => {
    const all = lines.flatMap((line) => antigravityAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("traduit un step_update agent_response en message, et porte finalText", () => {
    const line = lines.find((l) => l.includes('"agent_response"'));
    expect(line).toBeDefined();
    const translation = antigravityAgent.translate(line as string);
    expect(translation.events).toEqual([{ type: "message", text: "OK\n" }]);
    expect(translation.finalText).toBe("OK\n");
  });

  it("traduit la ligne result en finished réussi, et porte finalText", () => {
    const line = lines.find((l) => l.includes('"event":"result"'));
    expect(line).toBeDefined();
    const translation = antigravityAgent.translate(line as string);
    expect(translation.events).toEqual([{ type: "finished", status: "success", summary: "", exit_code: null }]);
    expect(translation.finalText).toBe("OK\n");
  });

  it("ignore les step_update sans intérêt (init, user_input, unknown, checkpoint)", () => {
    const initLine = lines.find((l) => l.includes('"event":"init"'));
    const userInputLine = lines.find((l) => l.includes('"step_type":"user_input"'));
    const unknownLine = lines.find((l) => l.includes('"step_type":"unknown"'));
    const checkpointLine = lines.find((l) => l.includes('"step_type":"checkpoint"'));

    for (const line of [initLine, userInputLine, unknownLine, checkpointLine]) {
      expect(line).toBeDefined();
      expect(antigravityAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  it("ignore silencieusement une ligne vide, du JSON invalide, ou du JSON inconnu", () => {
    expect(antigravityAgent.translate("")).toEqual({ events: [] });
    expect(antigravityAgent.translate("{not json")).toEqual({ events: [] });
    expect(antigravityAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
