import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copilotAgent } from "./copilot.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("copilot");

describe("copilotAgent.build", () => {
  it("refuse write et shell en lecture seule, sans jamais autoriser tous les outils", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(plan.args).toContain("--deny-tool=write");
    expect(plan.args).toContain("--deny-tool=shell");
    expect(plan.args).not.toContain("--allow-all-tools");
  });

  it("autorise tous les outils en écriture, sans deny-tool", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(plan.args).toContain("--allow-all-tools");
    expect(plan.args.some((a) => a.startsWith("--deny-tool"))).toBe(false);
  });

  it("utilise le workspace comme cwd, sans flag de répertoire explicite", () => {
    const plan = copilotAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
  });

  it("garde le répertoire de tâche accessible via --add-dir", () => {
    const plan = copilotAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("n'ajoute --model que si un modèle est fourni", () => {
    const sans = copilotAgent.build(sampleContext());
    expect(sans.args).not.toContain("--model");
    const avec = copilotAgent.build(sampleContext({ model: "gpt-5.4" }));
    const index = avec.args.indexOf("--model");
    expect(avec.args[index + 1]).toBe("gpt-5.4");
  });

  it("dépose une config MCP additionnelle au palier channel, référencée par @<fichier>", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "orch" } });
    const plan = copilotAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0];
    expect(file?.path).toBe(join(paths.dir, "copilot-mcp-config.json"));
    const content = JSON.parse(file?.content ?? "{}");
    expect(content.mcpServers.orch).toEqual({ type: "local", command: "node", args: ["server.js"] });
    const index = plan.args.indexOf("--additional-mcp-config");
    expect(plan.args[index + 1]).toBe(`@${file?.path}`);
  });

  it("ne dépose aucun fichier hors du palier channel", () => {
    const plan = copilotAgent.build(sampleContext({ reportVia: "file" }));
    expect(plan.files).toEqual([]);
  });

  it("place le prompt juste après --prompt, puis les arguments bruts en toute fin", () => {
    const plan = copilotAgent.build(sampleContext({ extraArgs: ["--yolo"] }));
    const index = plan.args.indexOf("--prompt");
    expect(plan.args[index + 1]).toBe("PROMPT");
    expect(plan.args.at(-1)).toBe("--yolo");
  });
});

describe("copilotAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("choisit channel quand le canal est disponible", () => {
    expect(copilotAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("retombe sur file sans canal (outputSchema faux)", () => {
    expect(copilotAgent.preferredReportChannel(task, false)).toBe("file");
  });
});

describe("copilotAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "copilot.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("reconnaît au moins un événement dans la capture réelle (chemin d'erreur : quota Copilot dépassé)", () => {
    const all = lines.flatMap((line) => copilotAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("traduit session.error en événement error fatal", () => {
    const line = lines.find((l) => l.includes('"session.error"'));
    expect(line).toBeDefined();
    const translation = copilotAgent.translate(line as string);
    expect(translation.events).toEqual([
      { type: "error", message: "You have exceeded your monthly quota (Request ID: CC5D:8E19C:2879C5E:332DD51:6A788BC6)", fatal: true },
    ]);
  });

  it("traduit la ligne result terminale selon exitCode", () => {
    const line = lines.find((l) => l.includes('"type":"result"'));
    expect(line).toBeDefined();
    const translation = copilotAgent.translate(line as string);
    expect(translation.events).toEqual([{ type: "finished", status: "failed", summary: "", exit_code: 1 }]);
  });

  it("traduit assistant.message (dérivé de la documentation, non observé) en message", () => {
    const line = JSON.stringify({ type: "assistant.message", data: { content: "OK" } });
    const translation = copilotAgent.translate(line);
    expect(translation.events).toEqual([{ type: "message", text: "OK" }]);
    expect(translation.finalText).toBe("OK");
  });

  it("ignore les événements de session sans intérêt (mcp, skills, tools_updated)", () => {
    const mcpLine = lines.find((l) => l.includes('"session.mcp_server_status_changed"'));
    const skillsLine = lines.find((l) => l.includes('"session.skills_loaded"'));
    const toolsLine = lines.find((l) => l.includes('"session.tools_updated"'));

    for (const line of [mcpLine, skillsLine, toolsLine]) {
      expect(line).toBeDefined();
      expect(copilotAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  it("ignore silencieusement une ligne vide, du JSON invalide, ou du JSON inconnu", () => {
    expect(copilotAgent.translate("")).toEqual({ events: [] });
    expect(copilotAgent.translate("{not json")).toEqual({ events: [] });
    expect(copilotAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
