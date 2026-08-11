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

  it("relit une mission écrite avant l'existence du champ « network »", () => {
    // Les task.json déjà présents dans .orch/tasks/ sont rouverts par
    // `orch ps`, `orch logs` et `orch diff` : sans défaut, ce champ les aurait
    // tous rendus illisibles d'un coup.
    const { network, ...ancienne } = sampleTask();
    expect(network).toBe(true);
    expect(TaskSchema.parse(ancienne).network).toBe(true);
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

  it("tout objet déclare `required` sur l'intégralité de ses propriétés, à toute profondeur", () => {
    // L'invariant que le fournisseur applique, et que rien ne vérifiait : une
    // seule propriété absente de `required`, si profonde soit-elle, fait
    // refuser la requête entière avant que le modèle ne réponde. Constaté sur
    // une délégation réelle à Codex, sur `commands_run.items.exit_code` :
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

  it("I2 (revue finale) : un champ purement optionnel est nullable plutôt qu'omis de `required`", () => {
    // L'intention d'I2 tient toujours — ne pas contraindre le modèle à
    // fabriquer un `usage.cost_usd` (un coût mesuré inventé) ni une
    // `findings[].line` (un `0` de repli échouait ensuite à la revalidation
    // par ReportSchema, exclusiveMinimum: 0) — mais elle se tient désormais
    // par la nullabilité, seul moyen compatible avec l'invariant ci-dessus.
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

    // Un champ porteur d'un défaut ne devient pas nullable : répéter le défaut
    // n'est jamais une fabrication.
    expect(acceptsNull(schema.properties.details)).toBe(false);
    expect(schema.required).toContain("changes");
    expect(schema.required).toContain("details");
  });

  it("un rapport dont les champs facultatifs valent `null` est accepté", () => {
    // La contrepartie du schéma nullable : ce que le modèle renvoie
    // effectivement doit rester validable, sans quoi le palier « schéma de
    // sortie natif » retomberait sur un palier dégradé pour rien.
    const report = parseReport({
      protocol: REPORT_PROTOCOL,
      status: "success",
      summary: "Fait.",
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

  it("prévient l'agent quand le réseau est coupé, plutôt que de le laisser s'y user", () => {
    const prompt = renderTaskPrompt(sampleTask({ network: false }), { reportVia: "file" });
    expect(prompt).toContain("No network access");
    expect(prompt).toContain("install packages");
  });

  it("n'affirme rien sur le réseau quand il est disponible", () => {
    // L'orchestrateur ne dit du réseau que ce qu'il garantit : pour un agent
    // dont il ne pilote pas le confinement, le champ reste vrai et le brief
    // reste muet.
    expect(renderTaskPrompt(sampleTask(), { reportVia: "file" })).not.toContain("network");
  });
});
