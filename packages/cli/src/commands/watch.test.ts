import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaesarEventInput } from "@caesar/protocol";
import { EventSchema, taskPaths } from "@caesar/protocol";
import { writeQuestion } from "@caesar/mcp-channel";
import type { TaskRecord } from "@caesar/core";
import { fileTaskStore } from "@caesar/core";
import { makeIo, type CapturedIo } from "../../test/support.js";
import { runWatch } from "./watch.js";
import { EXIT_OK, EXIT_USAGE } from "../output.js";

let root: string;
let io: CapturedIo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-cli-watch-"));
  io = makeIo();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const id = overrides.id ?? "t_1";
  return {
    id,
    agent: "codex",
    objective: "Relire le parseur de configuration",
    status: "running",
    created_at: "2026-08-11T10:00:00.000Z",
    started_at: new Date(Date.now() - 5_000).toISOString(),
    task_dir: join(root, ".caesar", "tasks", id),
    workspace: root,
    isolation: "worktree",
    mode: "read-only",
    report_via: "file",
    depth: 0,
    ...overrides,
  };
}

/** Dépose une tâche dans le store et écrit son journal d'événements. */
async function plant(
  overrides: Partial<TaskRecord>,
  events: Omit<CaesarEventInput, "protocol" | "seq" | "at" | "task_id">[],
): Promise<TaskRecord> {
  const rec = record(overrides);
  await fileTaskStore(root).create(rec);
  const paths = taskPaths(rec.task_dir);
  await mkdir(paths.dir, { recursive: true });
  const lines = events.map((partial, seq) =>
    JSON.stringify(
      EventSchema.parse({
        protocol: "caesar.event/v1",
        seq,
        at: new Date(Date.now() - (events.length - seq) * 1_000).toISOString(),
        task_id: rec.id,
        ...partial,
      }),
    ),
  );
  await writeFile(paths.eventsPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  return rec;
}

describe("caesar watch --once", () => {
  it("montre ce que chaque tâche fait à l'instant", async () => {
    await plant({ id: "t_a", agent: "codex", role: "reviewer" }, [
      { type: "started", agent: "codex", command: "codex exec" },
      { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "started" },
    ]);
    await plant({ id: "t_b", agent: "opencode", objective: "Ajouter un test" }, [
      { type: "started", agent: "opencode", command: "opencode run" },
      { type: "file_changed", path: "src/a.ts", action: "modified" },
      { type: "message", text: "J'ai modifié le module de configuration." },
    ]);

    expect(await runWatch(root, [], { once: true }, io)).toBe(EXIT_OK);
    const out = io.stdoutText();

    expect(out).toContain("2 actives");
    expect(out).toContain("t_a");
    expect(out).toContain("▸ shell npm test");
    expect(out).toContain("t_b");
    expect(out).toContain("« J'ai modifié le module de configuration. »");
    // L'objectif accompagne toujours la tâche : un identifiant seul ne dit
    // pas ce qu'on regarde.
    expect(out).toContain("Relire le parseur de configuration");
    expect(out).toContain("Ajouter un test");
  });

  it("n'émet aucune séquence ANSI hors terminal", async () => {
    // La sortie capturée d'un test n'est pas un TTY, pas plus qu'une
    // redirection vers un fichier : ni couleur, ni écran alterné, ni
    // effacement d'écran ne doivent s'y glisser.
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "codex exec" }]);
    await runWatch(root, [], { once: true }, io);
    // eslint-disable-next-line no-control-regex
    expect(io.stdoutText()).not.toMatch(/\x1b\[/);
  });

  it("dit clairement qu'il n'y a rien à voir plutôt que d'afficher une page vide", async () => {
    expect(await runWatch(root, [], { once: true }, io)).toBe(EXIT_OK);
    expect(io.stdoutText()).toContain("Aucune tâche en cours");
  });

  it("met en avant une question en attente, et rappelle comment y répondre", async () => {
    // C'est l'état qui ressemble le plus à un blocage sans en être un : un
    // sous-agent qui attend une réponse paraît figé.
    const rec = await plant({ id: "t_q" }, [{ type: "started", agent: "codex", command: "codex exec" }]);
    // Déposée par la fonction du canal plutôt qu'à la main : la disposition
    // exacte (`<taskDir>/questions/<id>.json`) appartient à `@caesar/mcp-channel`,
    // et un test qui la recopie de mémoire vérifie sa propre supposition.
    await writeQuestion(taskPaths(rec.task_dir).dir, {
      id: "q1",
      question: "Dois-je supprimer le fichier obsolète ?",
      options: ["oui", "non"],
      asked_at: new Date().toISOString(),
    });

    await runWatch(root, [], { once: true }, io);
    const out = io.stdoutText();
    expect(out).toContain("Dois-je supprimer le fichier obsolète ?");
    // Le rappel nomme l'outil MCP, seul moyen de répondre aujourd'hui — il
    // n'existe aucune commande `caesar answer`, et l'inventer ici enverrait
    // l'utilisateur droit dans le mur.
    expect(out).toContain("caesar_answer");
    expect(out).toContain("q1");
    expect(out).not.toMatch(/caesar answer\b/);
  });

  it("garde les tâches terminées à l'écran, avec leur statut de rapport", async () => {
    // Une tâche qui disparaît au moment où elle finit est une tâche dont on
    // ne saura jamais comment elle s'est terminée.
    await plant(
      {
        id: "t_fin",
        status: "succeeded",
        report_status: "partial",
        ended_at: new Date(Date.now() - 10_000).toISOString(),
      },
      [{ type: "finished", status: "partial", summary: "", exit_code: 0 }],
    );

    await runWatch(root, [], { once: true }, io);
    const out = io.stdoutText();
    expect(out).toContain("Terminées récemment");
    expect(out).toContain("t_fin");
    expect(out).toContain("rapport partial");
  });

  it("ignore une tâche terminée depuis longtemps", async () => {
    // Sans cette borne, ouvrir la fenêtre déroulerait l'historique entier.
    await plant(
      { id: "t_vieux", status: "succeeded", report_status: "success", ended_at: "2026-08-01T10:00:00.000Z" },
      [{ type: "finished", status: "success", summary: "", exit_code: 0 }],
    );
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).not.toContain("t_vieux");
  });

  it("se restreint aux identifiants demandés", async () => {
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "c" }]);
    await plant({ id: "t_b" }, [{ type: "started", agent: "codex", command: "c" }]);
    await runWatch(root, ["t_a"], { once: true }, io);
    expect(io.stdoutText()).toContain("t_a");
    expect(io.stdoutText()).not.toContain("t_b");
  });

  it("refuse un identifiant inconnu au lieu de veiller sur rien", async () => {
    expect(await runWatch(root, ["t_fantome"], { once: true }, io)).toBe(EXIT_USAGE);
    expect(io.stderrText()).toContain("t_fantome");
  });

  it("compte les lignes illisibles au lieu de les taire", async () => {
    // Un moniteur qui crie à chaque ligne devient inutilisable ; un moniteur
    // qui les avale masque un désalignement de schéma.
    const rec = await plant({ id: "t_x" }, [{ type: "started", agent: "codex", command: "c" }]);
    const paths = taskPaths(rec.task_dir);
    await writeFile(paths.eventsPath, `{"pas":"un événement"}\nceci n'est pas du JSON\n`, { flag: "a" });
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).toContain("2 ligne(s) illisible(s)");
  });

  it("signale un silence prolongé", async () => {
    const rec = await plant({ id: "t_mute" }, []);
    const paths = taskPaths(rec.task_dir);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.eventsPath,
      JSON.stringify(
        EventSchema.parse({
          protocol: "caesar.event/v1",
          seq: 0,
          at: new Date(Date.now() - 120_000).toISOString(),
          task_id: "t_mute",
          type: "message",
          text: "Je commence.",
        }),
      ) + "\n",
      "utf8",
    );
    await runWatch(root, [], { once: true }, io);
    expect(io.stdoutText()).toMatch(/silence \d+m\d+s/);
  });
});

describe("caesar watch --json", () => {
  it("rend du NDJSON : un événement par ligne, relisible tel quel", async () => {
    await plant({ id: "t_a" }, [
      { type: "started", agent: "codex", command: "codex exec" },
      { type: "tool_use", tool: "shell", id: "item_1", input_summary: "ls", status: "started" },
    ]);

    expect(await runWatch(root, [], { once: true, json: true }, io)).toBe(EXIT_OK);
    const lines = io.stdoutText().split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; task_id: string });
    expect(parsed.map((e) => e.type)).toEqual(["started", "tool_use"]);
    expect(parsed.every((e) => e.task_id === "t_a")).toBe(true);
  });

  it("fusionne les journaux de plusieurs tâches dans un seul flux", async () => {
    await plant({ id: "t_a" }, [{ type: "started", agent: "codex", command: "c" }]);
    await plant({ id: "t_b" }, [{ type: "started", agent: "opencode", command: "c" }]);
    await runWatch(root, [], { once: true, json: true }, io);
    const ids = io.stdoutText().split("\n").filter((l) => l.trim()).map((l) => (JSON.parse(l) as { task_id: string }).task_id);
    expect(new Set(ids)).toEqual(new Set(["t_a", "t_b"]));
  });
});
