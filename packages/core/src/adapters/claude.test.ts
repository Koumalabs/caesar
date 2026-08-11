import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAgent } from "./claude.js";
import { makeSampleFactory, paths } from "../../test/sample-task.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const { sampleTask, sampleContext } = makeSampleFactory("claude");

describe("claudeAgent.build", () => {
  it("demande le flux, pas l'objet final unique", () => {
    // `json` n'émet qu'un objet, à la toute fin : le sous-agent était muet
    // pendant toute son exécution. `--verbose` accompagne obligatoirement
    // `stream-json` sous `--print`.
    const plan = claudeAgent.build(sampleContext());
    const index = plan.args.indexOf("--output-format");
    expect(plan.args[index + 1]).toBe("stream-json");
    expect(plan.args).toContain("--verbose");
    // Pas de fragments : un événement par bribe de quelques caractères
    // noierait `events.jsonl` sans rien apprendre de plus.
    expect(plan.args).not.toContain("--include-partial-messages");
  });

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

  it("montre l'agent au travail bien avant la fin de la tâche", () => {
    // Le défaut que la bascule vers `stream-json` corrige : en `json`, la
    // capture entière tenait sur **une seule ligne**, émise à la toute fin.
    // Un sous-agent claude était muet du début à la fin de son exécution.
    expect(lines.length).toBeGreaterThan(10);
    const resultIndex = lines.findIndex((l) => l.includes('"type":"result"'));
    const avantLaFin = lines.slice(0, resultIndex).flatMap((line) => claudeAgent.translate(line).events);
    expect(avantLaFin.filter((e) => e.type === "tool_use").length).toBeGreaterThan(0);
    expect(avantLaFin.filter((e) => e.type === "message").length).toBeGreaterThan(0);
  });

  it("traduit la ligne result finale en message + finished, et porte finalText", () => {
    // Ce que la bascule ne change pas, et c'est ce qui la rendait sûre : la
    // ligne finale porte toujours `type`, `result` et `is_error` au premier
    // niveau. Le repli d'extraction du rapport garde donc la même source.
    const line = lines.find((l) => l.includes('"type":"result"'));
    expect(line).toBeDefined();
    const translation = claudeAgent.translate(line as string);
    expect(translation.events).toHaveLength(2);
    expect(translation.events[0]).toMatchObject({ type: "message" });
    expect(translation.events[1]).toEqual({ type: "finished", status: "success", summary: "", exit_code: null });
    expect(translation.finalText).toBe((translation.events[0] as { text: string }).text);
    expect(translation.finalText).not.toBe("");
  });

  it("ouvre un outil sur un bloc tool_use, avec un résumé lisible", () => {
    const line = lines.find((l) => l.includes('"type":"tool_use"') && l.includes('"Bash"'));
    expect(line).toBeDefined();
    const events = claudeAgent.translate(line as string).events;
    expect(events).toHaveLength(1);
    // Le résumé vient de `input.command`, pas de l'entrée sérialisée — pour
    // `Write`, celle-ci porterait le contenu entier du fichier.
    expect(events[0]).toMatchObject({ type: "tool_use", tool: "Bash", input_summary: "ls -1", status: "started" });
    expect((events[0] as { id: string }).id).toMatch(/^toolu_/);
  });

  it("ferme l'outil sur le tool_result correspondant, par identifiant seul", () => {
    // Un bloc `tool_result` ne porte que `tool_use_id`, jamais le nom de
    // l'outil, et `translate` est sans état par contrat : la fermeture arrive
    // donc avec `tool` vide. C'est l'identifiant qui la rattache à son
    // ouverture, pas le nom.
    const open = lines.find((l) => l.includes('"type":"tool_use"') && l.includes('"Bash"'));
    const close = lines.find((l) => l.includes('"tool_result"') && l.includes('"note.txt\\nREADME.md"'));
    expect(close).toBeDefined();
    const openEvent = claudeAgent.translate(open as string).events[0] as { id: string };
    const closeEvents = claudeAgent.translate(close as string).events;
    expect(closeEvents).toEqual([{ type: "tool_use", tool: "", id: openEvent.id, input_summary: "", status: "succeeded" }]);
  });

  it("marque l'outil en échec quand le tool_result porte is_error", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "boom", is_error: true }] },
    });
    expect(claudeAgent.translate(line).events).toEqual([
      { type: "tool_use", tool: "", id: "toolu_x", input_summary: "", status: "failed" },
    ]);
  });

  it("traduit thinking_tokens en progression — le seul signal de réflexion exploitable", () => {
    // Les blocs `thinking` du flux arrivent avec leur texte vide (l'API n'en
    // rend que la signature) : sans cette ligne, une longue phase de
    // raisonnement serait indiscernable d'un agent figé.
    const line = lines.find((l) => l.includes('"thinking_tokens"'));
    expect(line).toBeDefined();
    const events = claudeAgent.translate(line as string).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "progress" });
    expect((events[0] as { message: string }).message).toContain("jetons");
  });

  it("n'émet jamais un thinking creux", () => {
    const vide = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } });
    expect(claudeAgent.translate(vide).events).toEqual([]);
    const plein = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Je réfléchis." }] } });
    expect(claudeAgent.translate(plein).events).toEqual([{ type: "thinking", text: "Je réfléchis." }]);
  });

  it("ignore les lignes system de mise en place (hooks, init)", () => {
    for (const subtype of ["hook_started", "hook_response", "init"]) {
      const line = lines.find((l) => l.includes(`"subtype":"${subtype}"`));
      expect(line).toBeDefined();
      expect(claudeAgent.translate(line as string)).toEqual({ events: [] });
    }
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
