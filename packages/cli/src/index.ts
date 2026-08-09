/**
 * Surface publique de `@orch/cli` en tant que bibliothèque — jusqu'ici
 * uniquement consommé comme exécutable (`bin: "orch"`). `packages/tui` en a
 * besoin pour l'écran Agents (capacités, statut vis-à-vis de la politique)
 * et l'écran Intégrations (catalogue et installation MCP) : la même règle
 * que `packages/cli/src/commands/doctor.ts` et `mcp.ts` appliquent déjà,
 * réutilisée telle quelle plutôt que recopiée dans le TUI (voir le brief de
 * la tâche 8 et la contrainte globale n°4).
 *
 * Volontairement sélectif plutôt qu'un `export *` par fichier de commande :
 * ce module n'expose que ce qu'un consommateur externe a besoin d'appeler,
 * pas les à-côtés propres à la sortie CLI (`Io`, `--json`, codes de sortie).
 */
export { describeAgentCapabilities, describeAgentPolicy } from "./commands/agents.js";
export {
  checkMcpStatus,
  MCP_CLIENTS,
  runMcpInstall,
  type McpClient,
  type McpInstallOptions,
  type McpRegistrationState,
  type McpStatus,
} from "./commands/mcp.js";
