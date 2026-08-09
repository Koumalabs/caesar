/**
 * Point d'entrée du TUI de configuration. Lancé par Bun uniquement, jamais
 * importé par un package compilé par `tsc` — voir `orch config`
 * (`packages/cli/src/commands/config.ts`), qui résout ce chemin dynamiquement
 * et le lance en sous-processus avec la racine du projet en premier
 * argument (`bun main.tsx <root>`).
 *
 * `exitOnCtrlC` reste à sa valeur par défaut d'OpenTUI (pas de
 * surcharge) : Ctrl+C reste un échappatoire même si l'écran actif ne répond
 * plus — `App` gère lui-même la confirmation avant de quitter avec "q".
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
// Import sans extension, à la façon Bun/bundler : contrairement au reste du
// monorepo (NodeNext, extension ".js" obligatoire sur les imports relatifs),
// ce package n'est jamais compilé par `tsc` — Bun résout directement
// "./App" vers "./App.tsx". Voir le rapport de la tâche pour cette
// divergence assumée de convention.
import { App } from "./App";

const root = process.argv[2] ?? process.cwd();

const renderer = await createCliRenderer();
createRoot(renderer).render(<App root={root} renderer={renderer} />);
