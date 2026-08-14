#!/usr/bin/env node
/**
 * Point d'entrée du binaire `caesar-channel` : `caesar-channel <taskDir>`, lancé
 * par un sous-agent comme n'importe quel serveur MCP local — voir le brief
 * de la tâche 9. `packages/core/src/engine/runner.ts` construit la commande
 * qui le lance dynamiquement (`resolveChannelEntry`), en passant toujours
 * `process.execPath` en commande plutôt que ce fichier directement : ce
 * binaire n'a donc pas besoin d'être exécutable par lui-même pour cet usage,
 * mais le reste avec son shebang pour un lancement direct (PATH, lien
 * global…).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildChannelServer } from "./server.js";

async function main(): Promise<void> {
  const taskDir = process.argv[2];
  if (!taskDir) {
    process.stderr.write("caesar-channel: répertoire de tâche manquant (usage : caesar-channel <taskDir>)\n");
    process.exitCode = 1;
    return;
  }

  const server = buildChannelServer(taskDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`caesar-channel: erreur inattendue : ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
