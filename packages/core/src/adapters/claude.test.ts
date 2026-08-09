import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAgent } from "./claude.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("claude");

describe("claudeAgent.build", () => {
  it("choisit --permission-mode plan en lecture seule", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    const index = plan.args.indexOf("--permission-mode");
    expect(plan.args[index + 1]).toBe("plan");
  });

  it("choisit --permission-mode acceptEdits en écriture", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    const index = plan.args.indexOf("--permission-mode");
    expect(plan.args[index + 1]).toBe("acceptEdits");
  });

  it("utilise le workspace comme cwd, sans flag de répertoire explicite", () => {
    const plan = claudeAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("garde le répertoire de tâche accessible via --add-dir", () => {
    const plan = claudeAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("n'ajoute --model que si un modèle est fourni", () => {
    const sans = claudeAgent.build(sampleContext());
    expect(sans.args).not.toContain("--model");
    const avec = claudeAgent.build(sampleContext({ model: "sonnet" }));
    const index = avec.args.indexOf("--model");
    expect(avec.args[index + 1]).toBe("sonnet");
  });

  it("dépose une config MCP au palier channel, référencée par --mcp-config", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "orch" } });
    const plan = claudeAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file?.path).toBe(join(paths.dir, "claude-mcp-config.json"));
    const content = JSON.parse(file?.content ?? "{}");
    expect(content.mcpServers.orch).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
    const index = plan.args.indexOf("--mcp-config");
    expect(plan.args[index + 1]).toBe(file?.path);
  });

  it("ne dépose aucun fichier hors du palier channel", () => {
    const plan = claudeAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("place le prompt juste après --print, puis les arguments bruts en toute fin", () => {
    const plan = claudeAgent.build(sampleContext({ extraArgs: ["--debug"] }));
    const index = plan.args.indexOf("--print");
    expect(plan.args[index + 1]).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--debug");
  });
});

describe("claudeAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("choisit channel quand le canal est disponible", () => {
    expect(claudeAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("retombe sur file sans canal (outputSchema faux)", () => {
    expect(claudeAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("claudeAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "claude.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("reconnaît au moins un événement dans la capture réelle", () => {
    const all = lines.flatMap((line) => claudeAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("traduit la ligne result unique en message + finished, et porte finalText", () => {
    expect(lines).toHaveLength(1);
    const translation = claudeAgent.translate(lines[0] as string);
    expect(translation.events).toEqual([
      { type: "message", text: "OK" },
      { type: "finished", status: "success", summary: "", exit_code: null },
    ]);
    expect(translation.finalText).toBe("OK");
  });

  it("marque finished en échec quand is_error vaut true", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "Erreur" });
    const translation = claudeAgent.translate(line);
    expect(translation.events).toContainEqual({ type: "finished", status: "failed", summary: "", exit_code: null });
  });

  it("ignore silencieusement une ligne vide, du JSON invalide, ou du JSON inconnu", () => {
    expect(claudeAgent.translate("")).toEqual({ events: [] });
    expect(claudeAgent.translate("{not json")).toEqual({ events: [] });
    expect(claudeAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
