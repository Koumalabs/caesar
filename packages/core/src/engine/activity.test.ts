import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OrchEvent, OrchEventInput } from "@orch/protocol";
import { EventSchema } from "@orch/protocol";
import { codexAgent } from "../adapters/codex.js";
import { claudeAgent } from "../adapters/claude.js";
import { describeActivity, emptyActivity, foldActivity, formatDuration, STALL_MS } from "./activity.js";
import type { ActivityState } from "./activity.js";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "test", "fixtures");

const T0 = Date.parse("2026-08-11T14:00:00.000Z");

/** Un événement complet, daté à `T0 + offsetMs`. */
function event(offsetMs: number, partial: Omit<OrchEventInput, "protocol" | "seq" | "at" | "task_id">): OrchEvent {
  return EventSchema.parse({
    protocol: "orch.event/v1",
    seq: 0,
    at: new Date(T0 + offsetMs).toISOString(),
    task_id: "t_test",
    ...partial,
  });
}

function fold(...events: OrchEvent[]): ActivityState {
  return events.reduce(foldActivity, emptyActivity());
}

describe("foldActivity — outils", () => {
  it("tient l'outil ouvert entre son départ et sa fin", () => {
    const open = fold(event(0, { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "started" }));
    expect(open.runningTools).toHaveLength(1);
    expect(open.runningTools[0]).toMatchObject({ tool: "shell", summary: "npm test" });

    const closed = foldActivity(
      open,
      event(5_000, { type: "tool_use", tool: "shell", id: "item_1", input_summary: "npm test", status: "succeeded" }),
    );
    expect(closed.runningTools).toEqual([]);
    expect(closed.lastTool).toEqual({ tool: "shell", summary: "npm test", ok: true });
  });

  it("ferme le bon appel quand la même commande tourne deux fois", () => {
    // Le cas que le recoupement sur (nom, résumé) seul ne sait pas trancher :
    // deux `ls` simultanés, dont un seul se termine.
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "ls", status: "started" }),
      event(1_000, { type: "tool_use", tool: "shell", id: "b", input_summary: "ls", status: "started" }),
      event(2_000, { type: "tool_use", tool: "shell", id: "b", input_summary: "ls", status: "succeeded" }),
    );
    expect(state.runningTools).toHaveLength(1);
    expect(state.runningTools[0]?.id).toBe("a");
  });

  it("ferme un outil dont la fin ne porte que l'identifiant — le cas de claude", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "Bash", id: "toolu_1", input_summary: "ls -1", status: "started" }),
      event(3_000, { type: "tool_use", tool: "", id: "toolu_1", input_summary: "", status: "succeeded" }),
    );
    expect(state.runningTools).toEqual([]);
    // Le nom et le résumé viennent de l'ouverture : la fermeture ne les porte pas.
    expect(state.lastTool).toEqual({ tool: "Bash", summary: "ls -1", ok: true });
  });

  it("ne laisse pas une fin sans départ retirer un outil au hasard", () => {
    // opencode ne signale ses outils qu'une fois terminés, jamais leur départ.
    const state = fold(event(0, { type: "tool_use", tool: "bash", id: "bash_1", input_summary: "ls -1", status: "succeeded" }));
    expect(state.runningTools).toEqual([]);
    expect(state.lastTool).toEqual({ tool: "bash", summary: "ls -1", ok: true });
  });

  it("borne le nombre d'outils tenus pour ouverts", () => {
    // Un adaptateur qui annoncerait des départs sans jamais les fermer ferait
    // sinon croître cette liste indéfiniment.
    const events = Array.from({ length: 20 }, (_, i) =>
      event(i * 100, { type: "tool_use", tool: "shell", id: `t${i}`, input_summary: `cmd ${i}`, status: "started" }),
    );
    expect(fold(...events).runningTools.length).toBeLessThanOrEqual(8);
  });

  it("oublie les outils encore ouverts quand la tâche se termine", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "sleep 99", status: "started" }),
      event(1_000, { type: "finished", status: "success", summary: "", exit_code: 0 }),
    );
    expect(state.runningTools).toEqual([]);
    expect(state.finished).toBe("success");
  });
});

describe("foldActivity — parole", () => {
  it("recolle les fragments consécutifs, comme antigravity en émet", () => {
    const state = fold(
      event(0, { type: "message", text: "Je regarde " }),
      event(100, { type: "message", text: "d'abord la " }),
      event(200, { type: "message", text: "configuration." }),
    );
    expect(state.speech).toBe("Je regarde d'abord la configuration.");
  });

  it("referme le paragraphe dès qu'autre chose survient", () => {
    const state = fold(
      event(0, { type: "message", text: "Premier propos." }),
      event(100, { type: "tool_use", tool: "shell", id: "a", input_summary: "ls", status: "succeeded" }),
      event(200, { type: "message", text: "Second propos." }),
    );
    expect(state.speech).toBe("Second propos.");
  });

  it("ne garde que la fin d'un long monologue", () => {
    const state = fold(...Array.from({ length: 50 }, (_, i) => event(i, { type: "message", text: `phrase ${i}. ` })));
    expect(state.speech.length).toBeLessThanOrEqual(401);
    expect(state.speech.startsWith("…")).toBe(true);
    expect(state.speech.endsWith("phrase 49. ")).toBe(true);
  });

  it("lit le résumé d'un rapport plutôt que d'afficher son JSON — le cas de codex", () => {
    // codex n'envoie pas de prose : chacun de ses `agent_message` est un
    // rapport sérialisé. Tel quel, c'est un mur de JSON là où l'on attend
    // une phrase.
    const rapport = JSON.stringify({ protocol: "orch.report/v1", status: "partial", summary: "Je crée le fichier demandé." });
    expect(fold(event(0, { type: "message", text: rapport })).speech).toBe("Je crée le fichier demandé.");
  });

  it("laisse intacte une phrase qui commence par une accolade sans être du JSON", () => {
    const state = fold(event(0, { type: "message", text: "{ceci n'est pas du JSON" }));
    expect(state.speech).toBe("{ceci n'est pas du JSON");
  });
});

describe("foldActivity — fichiers, erreurs, progression", () => {
  it("accumule les chemins touchés sans doublon, dans l'ordre", () => {
    const state = fold(
      event(0, { type: "file_changed", path: "a.ts", action: "created" }),
      event(100, { type: "file_changed", path: "b.ts", action: "modified" }),
      event(200, { type: "file_changed", path: "a.ts", action: "modified" }),
    );
    expect(state.filesTouched).toEqual(["a.ts", "b.ts"]);
  });

  it("retient la dernière erreur et la dernière progression", () => {
    const state = fold(
      event(0, { type: "progress", message: "Réflexion en cours (~50 jetons)" }),
      event(100, { type: "error", message: "Quota atteint.", fatal: true }),
    );
    expect(state.lastProgress).toBe("Réflexion en cours (~50 jetons)");
    expect(state.lastError).toBe("Quota atteint.");
  });

  it("ne modifie jamais l'état qu'on lui passe", () => {
    const before = emptyActivity();
    const snapshot = JSON.stringify(before);
    foldActivity(before, event(0, { type: "file_changed", path: "a.ts", action: "created" }));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("describeActivity", () => {
  it("préfère un outil en cours à la dernière parole", () => {
    // « ▸ shell npm test, 12s » situe la tâche ; une phrase générale non.
    const state = fold(
      event(0, { type: "message", text: "Je vais lancer les tests." }),
      event(1_000, { type: "tool_use", tool: "shell", id: "a", input_summary: "npm test", status: "started" }),
    );
    const { headline } = describeActivity(state, T0 + 13_000);
    expect(headline).toBe("▸ shell npm test — 12s");
  });

  it("signale les outils supplémentaires plutôt que de n'en montrer qu'un", () => {
    const state = fold(
      event(0, { type: "tool_use", tool: "shell", id: "a", input_summary: "npm test", status: "started" }),
      event(0, { type: "tool_use", tool: "shell", id: "b", input_summary: "npm run lint", status: "started" }),
    );
    expect(describeActivity(state, T0 + 1_000).headline).toContain("(+1)");
  });

  it("rend la parole quand rien ne tourne", () => {
    const state = fold(event(0, { type: "message", text: "J'ai fini de lire le parseur." }));
    expect(describeActivity(state, T0 + 1_000).headline).toBe("« J'ai fini de lire le parseur. »");
  });

  it("compte le silence, et le signale au-delà du seuil", () => {
    const state = fold(event(0, { type: "message", text: "…" }));
    const court = describeActivity(state, T0 + 5_000);
    expect(court.silentMs).toBe(5_000);
    expect(court.stalled).toBe(false);

    const long = describeActivity(state, T0 + STALL_MS + 1_000);
    expect(long.stalled).toBe(true);
  });

  it("ne signale aucun silence sur une tâche dont rien n'est encore arrivé", () => {
    // Sans cette garde, une tâche qui vient d'être créée paraîtrait muette
    // depuis 1970.
    const { silentMs, stalled, headline } = describeActivity(emptyActivity(), T0);
    expect(silentMs).toBe(0);
    expect(stalled).toBe(false);
    expect(headline).toBe("aucun événement pour l'instant");
  });

  it("annonce la fin avec le statut déclaré par l'agent", () => {
    const state = fold(event(0, { type: "finished", status: "partial", summary: "", exit_code: 0 }));
    expect(describeActivity(state, T0 + 1_000).headline).toBe("terminé — rapport « partial »");
  });

  it("met une erreur en avant quand plus rien ne tourne", () => {
    const state = fold(
      event(0, { type: "message", text: "Je tente l'installation." }),
      event(1_000, { type: "error", message: "Quota atteint.", fatal: true }),
    );
    expect(describeActivity(state, T0 + 2_000).headline).toBe("⚠ Quota atteint.");
  });
});

describe("formatDuration", () => {
  it("rend une durée courte lisible", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(47_000)).toBe("47s");
    expect(formatDuration(134_000)).toBe("2m14s");
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

/**
 * L'épreuve qui compte : le pli appliqué aux vraies captures. Un test sur des
 * événements fabriqués à la main prouve la mécanique ; celui-ci prouve
 * qu'elle rend quelque chose de sensé sur ce que les agents émettent
 * réellement.
 */
describe("foldActivity sur les captures réelles", () => {
  function foldFixture(name: string, agent: typeof codexAgent): ActivityState {
    const lines = readFileSync(join(FIXTURE_DIR, name), "utf8").split("\n").filter((l) => l.trim());
    let seq = 0;
    let state = emptyActivity();
    for (const line of lines) {
      for (const partial of agent.translate(line).events) {
        state = foldActivity(state, event(seq * 1_000, partial as never));
        seq += 1;
      }
    }
    return state;
  }

  it("codex : les deux commandes et le fichier écrit sont restitués", () => {
    const state = foldFixture("codex.jsonl", codexAgent);
    expect(state.filesTouched).toEqual(["/tmp/orch-capture/note.txt"]);
    // Chaque commande a été ouverte puis refermée : rien ne reste en suspens.
    expect(state.runningTools).toEqual([]);
    expect(state.lastTool?.tool).toBe("shell");
    expect(state.finished).toBe("success");
    // La parole est le résumé du rapport, pas son JSON.
    expect(state.speech).not.toContain("orch.report");
  });

  it("claude : les outils s'apparient malgré une fermeture anonyme", () => {
    const state = foldFixture("claude.jsonl", claudeAgent);
    expect(state.runningTools).toEqual([]);
    expect(state.finished).toBe("success");
    expect(state.lastProgress).toContain("Réflexion");
    expect(state.speech).not.toBe("");
  });
});
