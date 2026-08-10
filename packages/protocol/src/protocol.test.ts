import { describe, expect, it } from "vitest";
import {
  EventSchema,
  ReportSchema,
  TaskSchema,
  extractReportFromText,
  jsonSchemaFor,
  makeEvent,
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
    objective: "Corriger la régression sur le parseur",
    mode: "write",
    isolation: "worktree",
    workspace: "/tmp/wt",
    deadline_ms: 600_000,
    report_path: "/tmp/task/report.json",
    events_path: "/tmp/task/events.jsonl",
    ...overrides,
  });
}

describe("mission", () => {
  it("complète les champs facultatifs avec des valeurs neutres", () => {
    const task = sampleTask();
    expect(task.context).toBe("");
    expect(task.constraints).toEqual([]);
    expect(task.depth).toBe(0);
  });

  it("refuse une version de protocole inconnue", () => {
    const result = TaskSchema.safeParse({ ...sampleTask(), protocol: "orch.task/v2" });
    expect(result.success).toBe(false);
  });
});

describe("rapport", () => {
  it("accepte un rapport minimal, tel qu'un agent extérieur le produirait", () => {
    const report = ReportSchema.parse({
      protocol: REPORT_PROTOCOL,
      status: "success",
      summary: "Fait.",
    });
    expect(report.changes).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.task_id).toBe("");
  });

  it("rejette un statut hors vocabulaire", () => {
    const result = ReportSchema.safeParse({
      protocol: REPORT_PROTOCOL,
      status: "presque",
      summary: "…",
    });
    expect(result.success).toBe(false);
  });
});

describe("extraction du rapport depuis du texte libre", () => {
  const valid = JSON.stringify({
    protocol: REPORT_PROTOCOL,
    status: "success",
    summary: "Deux fichiers modifiés.",
  });

  it("lit un bloc de code balisé", () => {
    const text = ["Voilà le résultat.", "", "```json orch:report", valid, "```"].join("\n");
    expect(extractReportFromText(text)?.summary).toBe("Deux fichiers modifiés.");
  });

  it("lit un bloc json ordinaire", () => {
    const text = ["Terminé.", "```json", valid, "```", "Bonne journée."].join("\n");
    expect(extractReportFromText(text)?.status).toBe("success");
  });

  it("retrouve un objet JSON noyé dans la prose", () => {
    const text = `blah blah ${valid} et voilà`;
    expect(extractReportFromText(text)?.summary).toBe("Deux fichiers modifiés.");
  });

  it("ne se laisse pas piéger par une accolade dans une chaîne", () => {
    const tricky = JSON.stringify({
      protocol: REPORT_PROTOCOL,
      status: "partial",
      summary: 'contient une accolade } et une "citation"',
    });
    expect(extractReportFromText(`prose ${tricky} fin`)?.status).toBe("partial");
  });

  it("retient le dernier rapport quand l'agent se reprend", () => {
    const first = JSON.stringify({ protocol: REPORT_PROTOCOL, status: "failed", summary: "raté" });
    const second = JSON.stringify({ protocol: REPORT_PROTOCOL, status: "success", summary: "finalement bon" });
    expect(extractReportFromText(`${first}\n\nCorrection:\n${second}`)?.status).toBe("success");
  });

  it("I1 (revue finale) : retrouve un rapport valide même quand \"protocol\" n'est pas la première clé, avec un objet imbriqué avant lui", () => {
    // Repro littéral du rapport de revue : un objet imbriqué (changes[0])
    // précède le champ "protocol" dans le même objet — avant I1, la
    // première "{" remontée depuis le marqueur était celle de cet objet
    // imbriqué, pas celle du rapport, et extractReportFromText rendait null.
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

  it("renvoie null quand il n'y a rien d'exploitable", () => {
    expect(extractReportFromText("j'ai fini, tout va bien")).toBeNull();
    expect(extractReportFromText(`{"protocol":"${REPORT_PROTOCOL}"`)).toBeNull();
  });
});

describe("événements", () => {
  it("construit un événement complet à partir des seuls champs utiles", () => {
    const event = makeEvent("t_1", 3, "tool_use", { tool: "bash", input_summary: "ls" });
    expect(event.protocol).toBe(EVENT_PROTOCOL);
    expect(event.seq).toBe(3);
    if (event.type === "tool_use") expect(event.status).toBe("started");
  });

  it("discrimine correctement les variantes", () => {
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

describe("publication du standard", () => {
  it("produit un JSON Schema pour chaque document", () => {
    for (const name of ["task", "report", "event"] as const) {
      expect(jsonSchemaFor(name)).toHaveProperty("$schema");
    }
  });

  it("verrouille le schéma strict pour les sorties structurées natives", () => {
    const schema = strictReportJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("summary");
    expect(schema.required).toContain("changes");
  });

  it("I2 (revue finale) : ne force pas les champs purement optionnels sans défaut (usage, findings[].file, findings[].line)", () => {
    // Avant I2, `required` valait `Object.keys(properties)` sans distinction :
    // le modèle devait fabriquer un `usage.cost_usd` (coût mesuré inventé)
    // et une `findings[].line` (un `0` de repli y échouait ensuite à la
    // revalidation par ReportSchema, exclusiveMinimum: 0).
    const schema = strictReportJsonSchema() as {
      properties: {
        findings: { items: { properties: Record<string, unknown>; required: string[] } };
        usage: { properties: Record<string, unknown> };
      };
      required: string[];
    };

    // `usage` reste une propriété déclarée (le modèle peut toujours la
    // fournir s'il a une vraie mesure) mais n'est plus dans `required`.
    expect(schema.properties.usage.properties).toHaveProperty("cost_usd");
    expect(schema.required).not.toContain("usage");

    const findingRequired = schema.properties.findings.items.required;
    expect(findingRequired).toContain("severity");
    expect(findingRequired).toContain("title");
    expect(findingRequired).not.toContain("file");
    expect(findingRequired).not.toContain("line");

    // Les champs porteurs d'un défaut (`changes`, `details`…) restent
    // obligatoires : répéter le défaut n'est jamais une fabrication.
    expect(schema.required).toContain("changes");
    expect(schema.required).toContain("details");
  });
});

describe("prompt de mission", () => {
  it("interdit explicitement l'écriture en mode lecture seule", () => {
    const prompt = renderTaskPrompt(sampleTask({ mode: "read-only" }), { reportVia: "file" });
    expect(prompt).toContain("read-only investigation");
  });

  it("indique le chemin du rapport au palier fichier", () => {
    const prompt = renderTaskPrompt(sampleTask(), { reportVia: "file" });
    expect(prompt).toContain("/tmp/task/report.json");
  });

  it("oriente vers le canal retour quand il est disponible", () => {
    const prompt = renderTaskPrompt(sampleTask(), { reportVia: "channel", channelServerName: "orch" });
    expect(prompt).toContain("submit_report");
    expect(prompt).toContain("ask_orchestrator");
  });
});
