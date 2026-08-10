/**
 * `orch config` : lance le TUI de configuration (OpenTUI, sous Bun — voir le
 * brief de la tâche 8).
 *
 * OpenTUI rend via le FFI de Bun ; Node 24 ne le permet pas (il faudrait
 * Node 26.4 avec `--experimental-ffi`, absent de cette machine). Cette
 * commande cherche donc `bun` dans le `PATH` — réutilise `findBinaryInPath`
 * de `@orch/core`, la même recherche que `orch doctor` fait pour chaque
 * agent, plutôt que d'en écrire une seconde — et, s'il est absent, explique
 * la situation et renvoie vers les sous-commandes équivalentes au lieu
 * d'échouer sèchement.
 *
 * `packages/tui` n'est jamais importé statiquement ici : ce module est
 * compilé par `tsc`, qui ne doit jamais tenter de traiter le `.tsx` destiné
 * à Bun. Son chemin est résolu dynamiquement via `@orch/tui/package.json`,
 * déclaré en dépendance dans `package.json` pour que la résolution Node le
 * trouve dans `node_modules`.
 *
 * Ce chemin (spawn d'un `bun` externe) est celui du développement dans le
 * monorepo, et celui d'une installation classique : il reste inchangé par
 * défaut. Le binaire compilé (tâche 12) n'a plus de `node_modules` où
 * résoudre quoi que ce soit — `resolveTuiEntry` y échouerait toujours.
 * `configureInProcessTui`, appelée une seule fois par
 * `packages/cli/src/bun-entry.ts` (qui, lui, importe `@orch/tui`
 * statiquement — c'est ce qui l'embarque dans le binaire), fournit un
 * lanceur qui monte le TUI directement dans le processus courant plutôt que
 * dans un sous-processus : un seul binaire, aucune résolution de chemin, Bun
 * n'a plus besoin d'être installé séparément puisqu'il est dedans.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findBinaryInPath } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_RUNTIME, printError, writeLine } from "../output.js";

/** Lanceur in-process du TUI (tâche 12) : monte le renderer dans le processus courant et rend le code de sortie une fois le TUI fermé. */
export type InProcessTuiLauncher = (root: string) => Promise<number>;

let inProcessTui: InProcessTuiLauncher | undefined;

/**
 * Point d'extension appelé par `bun-entry.ts` au démarrage du binaire
 * compilé. Tant qu'elle n'est jamais appelée — le cas du chemin Node,
 * `bin.ts` ne l'appelle jamais — `runConfig` garde son comportement
 * historique (spawn d'un `bun` externe, ci-dessous), à l'identique.
 */
export function configureInProcessTui(launcher: InProcessTuiLauncher | undefined): void {
  inProcessTui = launcher;
}

/** `<...>/packages/tui/src/main.tsx`, à partir du `package.json` de `@orch/tui` tel que Node le résout. */
function resolveTuiEntry(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@orch/tui/package.json");
  return join(dirname(packageJsonPath), "src", "main.tsx");
}

function explainMissingBun(io: Io): void {
  printError(
    io,
    'Le TUI de configuration exige Bun : OpenTUI rend via son FFI, que Node 24 ne permet pas (il faudrait Node 26.4 avec "--experimental-ffi"). "bun" est introuvable dans le PATH.',
  );
  writeLine(io.stderr, "Installez Bun (https://bun.sh), ou utilisez les sous-commandes équivalentes :");
  writeLine(io.stderr, "  - orch policy show   Politique effective (allow/deny, provenance).");
  writeLine(io.stderr, "  - orch role list     Rôles, agents de repli, agent retenu aujourd'hui.");
  writeLine(io.stderr, "  - orch agents list   Catalogue des agents : présence, capacités, autorisation.");
}

export async function runConfig(root: string, io: Io): Promise<number> {
  if (inProcessTui) {
    return inProcessTui(root);
  }

  const bunPath = await findBinaryInPath("bun");
  if (!bunPath) {
    explainMissingBun(io);
    return EXIT_RUNTIME;
  }

  let entry: string;
  try {
    entry = resolveTuiEntry();
  } catch (error) {
    printError(
      io,
      `Impossible de localiser le TUI ("@orch/tui" introuvable dans les dépendances) : ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_RUNTIME;
  }

  // Trois flux hérités (stdio: "inherit") : le TUI prend directement le
  // terminal, `io` n'entre pas en jeu ici (il ne sert qu'aux diagnostics
  // avant le lancement, ci-dessus). Le code de sortie du TUI devient celui
  // de la commande.
  return await new Promise<number>((resolvePromise) => {
    const child = spawn(bunPath, [entry, root], { stdio: "inherit" });
    child.on("error", (error) => {
      printError(io, `Échec du lancement du TUI : ${error.message}`);
      resolvePromise(EXIT_RUNTIME);
    });
    child.on("exit", (code) => {
      resolvePromise(code ?? EXIT_RUNTIME);
    });
  });
}
