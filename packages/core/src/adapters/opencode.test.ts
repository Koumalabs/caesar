import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeAgent } from "./opencode.js";
import { makeSampleFactory } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("opencode");

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
    expect(translation.events).toHaveLength(1);
    expect(translation.events[0]).toMatchObject({ type: "message" });
    expect(translation.finalText).toBe((translation.events[0] as { text: string }).text);
    expect(translation.finalText).not.toBe("");
  });

  it("ignore step_start / step_finish, qui ne portent pas de contenu reconnu", () => {
    const stepStart = lines.find((l) => l.includes('"type":"step_start"'));
    const stepFinish = lines.find((l) => l.includes('"type":"step_finish"'));

    for (const line of [stepStart, stepFinish]) {
      expect(line).toBeDefined();
      expect(opencodeAgent.translate(line as string)).toEqual({ events: [] });
    }
  });

  /**
   * Ce bloc remplace un test qui construisait lui-même une part
   * `type: "tool-bash"`, avec `part.input` et `part.state` de type chaîne —
   * la forme supposée d'après les conventions du Vercel AI SDK. Il passait au
   * vert, et validait une forme qu'opencode n'émet pas : aucun `tool_use`
   * n'était produit en vrai, et un sous-agent opencode paraissait n'utiliser
   * aucun outil. Les assertions portent désormais sur la capture réelle.
   */
  it("traduit les parts tool de la capture réelle, avec leur identifiant d'appel", () => {
    const toolEvents = lines.flatMap((line) => opencodeAgent.translate(line).events).filter((e) => e.type === "tool_use");
    expect(toolEvents.length).toBeGreaterThanOrEqual(2);

    const bash = toolEvents.find((e) => (e as { tool: string }).tool === "bash");
    expect(bash).toMatchObject({ type: "tool_use", tool: "bash", input_summary: "ls -1", status: "succeeded" });
    expect((bash as { id: string }).id).toBe("bash_1");

    // `state.title` est préféré à l'entrée sérialisée : celle-ci porte le
    // contenu entier du fichier écrit, illisible dans une vue en direct.
    const write = toolEvents.find((e) => (e as { tool: string }).tool === "write");
    expect((write as { input_summary: string }).input_summary).toBe("note.txt");
  });

  it("retombe sur l'entrée sérialisée quand la part ne porte pas de titre", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "grep", callID: "grep_0", state: { status: "completed", input: { pattern: "TODO" } } },
    });
    expect(opencodeAgent.translate(line).events).toEqual([
      { type: "tool_use", tool: "grep", id: "grep_0", input_summary: '{"pattern":"TODO"}', status: "succeeded" },
    ]);
  });

  it("ignore silencieusement une ligne vide, du JSON invalide, ou du JSON inconnu", () => {
    expect(opencodeAgent.translate("")).toEqual({ events: [] });
    expect(opencodeAgent.translate("{not json")).toEqual({ events: [] });
    expect(opencodeAgent.translate('{"hello":"world"}')).toEqual({ events: [] });
  });
});
