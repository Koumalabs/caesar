/**
 * Construction du serveur MCP : un `McpServer` du SDK, avec les dix tools de
 * délégation enregistrés — neuf pour la délégation elle-même (brief de la
 * tâche 7), plus `orch_answer` (canal retour, brief de la tâche 9).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSession } from "./session.js";
import type { McpSession } from "./session.js";
import { registerOrchAnswer } from "./tools/answer.js";
import { registerOrchApply } from "./tools/apply.js";
import { registerOrchAwait } from "./tools/await.js";
import { registerOrchCancel } from "./tools/cancel.js";
import { registerOrchDelegate } from "./tools/delegate.js";
import { registerOrchDiff } from "./tools/diff.js";
import { registerOrchListAgents } from "./tools/list-agents.js";
import { registerOrchListRoles } from "./tools/list-roles.js";
import { registerOrchLogs } from "./tools/logs.js";
import { registerOrchStatus } from "./tools/status.js";

const SERVER_NAME = "orch";
const SERVER_VERSION = "0.1.0";

export interface BuiltServer {
  server: McpServer;
  session: McpSession;
}

/** Construit le serveur MCP pour le projet enraciné à `root`, avec sa propre session (tâches en cours, store). */
export async function buildServer(root: string): Promise<BuiltServer> {
  const session = await createSession(root);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerOrchListAgents(server, session);
  registerOrchListRoles(server, session);
  registerOrchDelegate(server, session);
  registerOrchAwait(server, session);
  registerOrchStatus(server, session);
  registerOrchLogs(server, session);
  registerOrchCancel(server, session);
  registerOrchDiff(server, session);
  registerOrchApply(server, session);
  registerOrchAnswer(server, session);

  return { server, session };
}
