/**
 * `sampleTask`/`sampleContext` de test, pour un agent donné — recopiés à
 * l'identique dans les cinq tests d'adaptateur (`src/adapters/*.test.ts`) et
 * `src/registry/generic.test.ts` jusqu'ici (tâche 10, B) : un champ
 * obligatoire ajouté à `Task` demandait six corrections identiques plutôt
 * qu'une seule ici. Seul `agent` varie d'un fichier à l'autre (l'identifiant
 * de l'agent testé) — `makeSampleFactory` le fixe une fois, le reste est
 * partagé tel quel.
 */
import { taskPaths, TaskSchema, TASK_PROTOCOL, type Task, type TaskPaths } from "@caesar/protocol";
import type { BuildContext } from "../src/registry/types.js";

/** `TaskPaths` de `sampleContext` — exporté séparément : plusieurs tests l'utilisent aussi directement (ex. `paths.dir`, `join(paths.dir, …)`). */
export const paths: TaskPaths = taskPaths("/tmp/task");

export function makeSampleFactory(defaultAgentId: string): {
  sampleTask: (overrides?: Partial<Task>) => Task;
  sampleContext: (overrides?: Partial<BuildContext>) => BuildContext;
} {
  function sampleTask(overrides: Partial<Task> = {}): Task {
    return TaskSchema.parse({
      protocol: TASK_PROTOCOL,
      id: "t_0001",
      created_at: "2026-08-09T10:00:00.000Z",
      agent: defaultAgentId,
      objective: "Corriger la régression",
      mode: "write",
      isolation: "worktree",
      workspace: "/tmp/wt",
      deadline_ms: 600_000,
      report_path: "/tmp/task/report.json",
      events_path: "/tmp/task/events.jsonl",
      ...overrides,
    });
  }

  function sampleContext(overrides: Partial<BuildContext> = {}): BuildContext {
    return {
      task: sampleTask(),
      paths,
      prompt: "PROMPT",
      reportVia: "file",
      model: undefined,
      extraArgs: [],
      ...overrides,
    };
  }

  return { sampleTask, sampleContext };
}
