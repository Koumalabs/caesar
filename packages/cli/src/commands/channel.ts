/**
 * `caesar channel serve --task-dir <dir>` : démarre le serveur du canal retour
 * (`@caesar/mcp-channel`) sur stdio, à l'intérieur du binaire `caesar` lui-même.
 *
 * Sous-commande interne (tâche 12), masquée de l'aide (`bin.ts`) : elle n'a
 * pas vocation à être tapée par un humain, seulement atteinte par
 * auto-invocation. Le point d'entrée Bun (`bun-entry.ts`) la relie à
 * `@caesar/core` via `configureChannelLauncher` — un binaire compilé n'a plus
 * de `node_modules` où résoudre `@caesar/mcp-channel` (voir le brief). Le
 * chemin Node ne l'emprunte jamais par défaut : `defaultChannelLauncher`
 * (`packages/core/src/engine/runner.ts`) continue de résoudre et lancer
 * `@caesar/mcp-channel/dist/bin.js` en sous-processus séparé, comportement
 * inchangé — cette sous-commande existe malgré tout dans les deux mondes
 * (même programme commander, voir `bin.ts`), simplement inutilisée par le
 * chemin Node par défaut.
 *
 * Reprend le corps de `packages/mcp-channel/src/bin.ts` (le binaire
 * `caesar-channel` autonome, toujours résolu tel quel par le chemin Node) :
 * même construction du serveur, même transport stdio. Rien d'autre que le
 * protocole MCP n'écrit sur stdout ici — même exigence que `caesar mcp serve`
 * (voir `mcp.ts`).
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildChannelServer } from "@caesar/mcp-channel";
import { EXIT_OK } from "../output.js";

export interface ChannelServeOptions {
  /** Overrides de test : jamais renseignés en usage réel (défaut : `process.stdin`/`process.stdout`, voir `StdioServerTransport`). */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runChannelServe(taskDir: string, options: ChannelServeOptions = {}): Promise<number> {
  const server = buildChannelServer(taskDir);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return EXIT_OK;
}
