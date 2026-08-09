/**
 * `orch_cancel` : annule une tâche en cours — voir le brief de la tâche 7.
 *
 * Deux chemins, selon que la tâche a été lancée par cette session ou non :
 *
 * - connue de la session (le cas courant : c'est cette instance du serveur
 *   qui a lancé `runTask`) : on déclenche directement l'`AbortController`
 *   conservé par `orch_delegate` — le moteur (`runAgentProcess`) l'honore
 *   déjà (SIGTERM puis, à défaut de réponse, SIGKILL). On attend ensuite la
 *   promesse (jamais rejetée — voir `session.ts`) pour rendre le statut final
 *   réellement constaté, pas une supposition ;
 * - inconnue de la session (tâche lancée par un autre processus — `orch run`
 *   en CLI, ou une précédente instance du serveur) : repli sur le `pid`
 *   enregistré dans le store, exactement comme `orch cancel` en CLI
 *   (`packages/cli/src/commands/tasks.ts`) — même technique, dupliquée ici
 *   faute d'un point d'export commun (voir le rapport de la tâche 7).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskStatus } from "@orch/core";
import type { McpSession } from "../session.js";
import { errorResult, jsonResult } from "./result.js";

export const ORCH_CANCEL = "orch_cancel";

export const orchCancelDescription =
  "Cancel a task started by orch_delegate that is still running: signals the sub-agent process to stop " +
  "(SIGTERM, escalating to SIGKILL if it does not exit) and waits for the shutdown to complete before " +
  "returning. Safe to call on a task that already finished — it is then a no-op that just reports the final " +
  "status, cancelled: false.";

export const orchCancelInputShape = {
  task_id: z.string().min(1).describe("The task_id returned by orch_delegate."),
};

const OrchCancelInputSchema = z.object(orchCancelInputShape);
export type OrchCancelInput = z.infer<typeof OrchCancelInputSchema>;

const ACTIVE_STATUSES: readonly TaskStatus[] = ["pending", "running"];

export async function orchCancel(session: McpSession, input: OrchCancelInput): Promise<CallToolResult> {
  const entry = session.tasks.get(input.task_id);
  if (entry) {
    entry.controller.abort();
    const outcome = await entry.promise;
    return jsonResult({ task_id: input.task_id, cancelled: outcome.record.status === "cancelled", status: outcome.record.status });
  }

  const record = await session.store.get(input.task_id);
  if (!record) return errorResult(`Tâche inconnue : "${input.task_id}".`);

  if (!ACTIVE_STATUSES.includes(record.status)) {
    return jsonResult({ task_id: input.task_id, cancelled: false, status: record.status });
  }
  if (record.pid === undefined) {
    return errorResult(
      `Tâche "${input.task_id}" en cours, mais aucun identifiant de processus n'est enregistré : impossible de l'annuler depuis ce serveur.`,
    );
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      const updated = await session.store.update(input.task_id, { status: "cancelled", ended_at: new Date().toISOString(), pid: undefined });
      return jsonResult({ task_id: input.task_id, cancelled: true, status: updated.status });
    }
    throw error;
  }

  const updated = await session.store.update(input.task_id, { status: "cancelled", ended_at: new Date().toISOString() });
  return jsonResult({ task_id: input.task_id, cancelled: true, status: updated.status });
}

export function registerOrchCancel(server: McpServer, session: McpSession): void {
  server.registerTool(ORCH_CANCEL, { description: orchCancelDescription, inputSchema: orchCancelInputShape }, (args) =>
    orchCancel(session, args),
  );
}
