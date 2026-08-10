#!/usr/bin/env bun
/**
 * Point d'entrée du binaire autonome `orch` (tâche 12, `bun build
 * --compile`) : le seul fichier de ce package que Bun bundle — voir
 * `scripts/build-binary.sh` à la racine du dépôt.
 *
 * Deux rôles :
 *
 * 1. Importer `@orch/tui` **statiquement** (`runTui`, ci-dessous) : c'est cet
 *    import qui le fait embarquer par le bundler dans le binaire final, avec
 *    OpenTUI et son cœur natif — plus besoin de Bun installé séparément sur
 *    la machine cible, il est dedans.
 * 2. Reconfigurer, avant de lancer le CLI, les deux points d'extension que
 *    `@orch/core` et `orch config` exposent pour cesser de résoudre des
 *    chemins de `node_modules` — absent dans un binaire compilé
 *    (`createRequire(...).resolve()` n'a plus rien à résoudre) :
 *      - `configureChannelLauncher` (`@orch/core`) : le canal retour
 *        s'auto-invoque (`orch channel serve --task-dir <dir>`) plutôt que
 *        de chercher `@orch/mcp-channel/dist/bin.js`.
 *      - `configureInProcessTui` (`./commands/config.js`) : `orch config`
 *        monte le TUI directement dans ce processus plutôt que de spawn un
 *        `bun` externe.
 *
 * Le chemin Node (`bin.ts`) n'appelle jamais ces deux fonctions : son
 * comportement par défaut (résolution de module pour le canal, sous-processus
 * Bun externe pour `orch config`) reste inchangé — c'est le chemin du
 * développement quotidien dans le monorepo, et il continue de fonctionner à
 * l'identique.
 *
 * `runCli` est importé depuis `./program.js`, **jamais** depuis `./bin.js` :
 * `bin.ts` porte son propre garde d'auto-invocation (`isMain`), pensé pour
 * Node, où chaque module garde un `import.meta.url` distinct. Dans un
 * exécutable compilé par Bun, `import.meta.url` vaut la même URL virtuelle
 * pour tous les modules du bundle — importer `bin.ts` ici ferait donc
 * tourner son garde une seconde fois (constaté en vérifiant le binaire réel :
 * `orch --version` répondait deux fois de suite). Voir l'en-tête de
 * `program.ts` pour le détail de cette découverte et de la séparation
 * qu'elle a motivée.
 *
 * Exclu de `packages/cli/tsconfig.json` (voir son `exclude`) : `tsc` ne
 * traite jamais ce fichier, seul `bun build --compile` le lit.
 */
import { CHANNEL_SERVER_NAME, configureChannelLauncher } from "@orch/core";
import { runTui } from "@orch/tui";
import { configureInProcessTui } from "./commands/config.js";
import { EXIT_OK } from "./output.js";
import { runCli } from "./program.js";

configureInProcessTui(async (root) => {
  await runTui(root);
  return EXIT_OK;
});

configureChannelLauncher((taskDir) => ({
  transport: "mcp-stdio",
  command: process.execPath,
  args: ["channel", "serve", "--task-dir", taskDir],
  server_name: CHANNEL_SERVER_NAME,
}));

const code = await runCli(process.argv);
process.exitCode = code;
