/**
 * Construction du serveur MCP : un `McpServer` du SDK, avec les neuf tools
 * de délégation enregistrés — voir le brief de la tâche 7. `orch_answer`
 * (canal retour) n'est pas de cette tâche.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSession } from "./session.js";
import type { McpSession } from "./session.js";
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
export function buildServer(root: string): BuiltServer {
  const session = createSession(root);
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

  return { server, session };
}
