import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexAgent } from "./codex.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("codex");

describe("codexAgent.build", () => {
  it("choisit le sandbox read-only en mode lecture seule", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ mode: "read-only" }) }));
    expect(plan.args).toContain("read-only");
    expect(plan.args).not.toContain("workspace-write");
  });

  it("choisit le sandbox workspace-write en mode écriture", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ mode: "write" }) }));
    expect(plan.args).toContain("workspace-write");
    expect(plan.args).not.toContain("read-only");
  });

  it("n'ajoute -m que si un modèle est fourni", () => {
    const sans = codexAgent.build(sampleContext());
    expect(sans.args).not.toContain("-m");

    const avec = codexAgent.build(sampleContext({ model: "o3" }));
    const index = avec.args.indexOf("-m");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(avec.args[index + 1]).toBe("o3");
  });

  it("n'ajoute --output-schema qu'au palier schema, avec un fichier fourni", () => {
    const fichier = codexAgent.build(sampleContext({ reportVia: "schema", schemaFile: "/tmp/task/schema.json" }));
    const index = fichier.args.indexOf("--output-schema");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(fichier.args[index + 1]).toBe("/tmp/task/schema.json");

    const sansFichier = codexAgent.build(sampleContext({ reportVia: "file" }));
    expect(sansFichier.args).not.toContain("--output-schema");
  });

  it("ajoute -o quand un chemin de message final est fourni, quel que soit le palier", () => {
    const plan = codexAgent.build(sampleContext({ reportVia: "channel", finalMessageFile: "/tmp/task/final.txt" }));
    const index = plan.args.indexOf("-o");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(plan.args[index + 1]).toBe("/tmp/task/final.txt");
  });

  it("branche le canal MCP par des -c au palier channel", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: ["server.js"], server_name: "orch" } });
    const plan = codexAgent.build(sampleContext({ task, reportVia: "channel" }));
    expect(plan.args).toContain("-c");
    expect(plan.args).toContain('mcp_servers.orch.command="node"');
    expect(plan.args).toContain('mcp_servers.orch.args=["server.js"]');
  });

  it("n'ajoute aucun -c quand le palier n'est pas channel, même si un canal existe", () => {
    const task = sampleTask({ channel: { transport: "mcp-stdio", command: "node", args: [], server_name: "orch" } });
    const plan = codexAgent.build(sampleContext({ task, reportVia: "file" }));
    expect(plan.args).not.toContain("-c");
  });

  it("garde le répertoire de tâche accessible via --add-dir", () => {
    const plan = codexAgent.build(sampleContext());
    const index = plan.args.indexOf("--add-dir");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(plan.args[index + 1]).toBe(paths.dir);
  });

  it("place le prompt en position positionnelle finale, puis les arguments bruts", () => {
    const plan = codexAgent.build(sampleContext({ extraArgs: ["--enable", "feature_x"] }));
    expect(plan.args.at(-3)).toBe("PROMPT");
    expect(plan.args.at(-2)).toBe("--enable");
    expect(plan.args.at(-1)).toBe("feature_x");
  });

  it("utilise le workspace comme cwd et comme -C", () => {
    const plan = codexAgent.build(sampleContext({ task: sampleTask({ workspace: "/tmp/wt" }) }));
    expect(plan.cwd).toBe("/tmp/wt");
    const index = plan.args.indexOf("-C");
    expect(plan.args[index + 1]).toBe("/tmp/wt");
  });
});

describe("codexAgent.preferredReportChannel", () => {
  const task = sampleTask();

  it("choisit channel quand le canal est disponible", () => {
    expect(codexAgent.preferredReportChannel(task, true)).toBe("channel");
  });

  it("retombe sur schema sans canal (outputSchema vrai)", () => {
    expect(codexAgent.preferredReportChannel(task, false)).toBe("schema");
  });
});

describe("codexAgent.translate", () => {
  const lines = readFileSync(join(FIXTURE_DIR, "codex.jsonl"), "utf8").split("\n").filter((l) => l.trim());

  it("reconnaît au moins un événement dans la capture réelle", () => {
    const all = lines.flatMap((line) => codexAgent.translate(line).events);
    expect(all.length).toBeGreaterThan(0);
  });

  it("traduit le message de l'agent en événement message, et porte finalText", () => {
    const messageLine = lines.find((l) => l.includes('"agent_message"'));
    expect(messageLine).toBeDefined();
    const translation = codexAgent.translate(messageLine as string);
    expect(translation.events).toEqual([{ type: "message", text: "OK" }]);
    expect(translation.finalText).toBe("OK");
  });

  it("traduit l'item error en événement error non fatal", () => {
    const errorLine = lines.find((l) => l.includes('"type":"error"') && l.includes('"item_0"'));
    expect(errorLine).toBeDefined();
    const translation = codexAgent.translate(errorLine as string);
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "error", fatal: false });
  });

  it("traduit turn.completed en finished réussi", () => {
    const turnLine = lines.find((l) => l.includes('"turn.completed"'));
    expect(turnLine).toBeDefined();
    const translation = codexAgent.translate(turnLine as string);
    expect(translation.events).toEqual([{ type: "finished", status: "success", summary: "", exit_code: null }]);
  });

  it("ignore silencieusement une ligne vide", () => {
    expect(codexAgent.translate("")).toEqual({ events: [] });
    expect(codexAgent.translate("   ")).toEqual({ events: [] });
  });

  it("ignore silencieusement du JSON invalide", () => {
    expect(codexAgent.translate("{not json")).toEqual({ events: [] });
  });

  it("ignore silencieusement du JSON valide mais inconnu", () => {
    expect(codexAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
    expect(codexAgent.translate('[1,2,3]')).toEqual({ events: [] });
  });
});
