/**
 * Reconstruit le `WorktreeHandle` d'une tâche à partir de son enregistrement,
 * pour `orch_diff`/`orch_apply`/le repli d'`orch_status` sur le store.
 *
 * Même logique que le helper privé homonyme de `packages/cli/src/commands/tasks.ts`
 * (`orch diff`/`orch apply`) : les deux façades en ont besoin indépendamment,
 * et `@orch/core` ne l'exporte pas. Une dizaine de lignes sans état, dupliquées
 * une seule fois plutôt qu'importées à travers une dépendance CLI→MCP qui
 * n'existe pas dans l'autre sens — voir le rapport de la tâche 7 : bon
 * candidat à remonter dans `@orch/core` si un troisième consommateur
 * (le TUI, tâche 9) en a besoin à son tour.
 */
import type { TaskRecord, WorktreeHandle } from "@orch/core";
import { readTask, taskPaths } from "@orch/protocol";

export async function loadWorktreeHandle(record: TaskRecord): Promise<WorktreeHandle | null> {
  if (record.isolation !== "worktree" || !record.branch) return null;
  const task = await readTask(taskPaths(record.task_dir));
  return { path: record.workspace, branch: record.branch, baseRef: task.base_ref ?? "HEAD" };
}
