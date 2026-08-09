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
