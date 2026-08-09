/**
 * Point d'entrée du TUI de configuration. Lancé par Bun uniquement, jamais
 * importé par un package compilé par `tsc` — voir `orch config`
 * (`packages/cli/src/commands/config.ts`), qui résout ce chemin dynamiquement
 * et le lance en sous-processus avec la racine du projet en premier
 * argument (`bun main.tsx <root>`).
 *
 * `exitOnCtrlC: false` : par défaut, `CliRenderer` intercepte Ctrl+C dans
 * son propre gestionnaire interne et appelle `this.destroy()` sur
 * `process.nextTick`, **inconditionnellement** — avant même que l'événement
 * n'atteigne le `useKeyboard` d'`App`, et quel que soit ce que ce dernier en
 * ferait. Avec des modifications en attente, un Ctrl+C (un réflexe de
 * sortie de terminal au moins aussi répandu que "q") les perdrait donc
 * silencieusement, sans jamais passer par la confirmation que le brief
 * exige. La désactivation ici, combinée à l'interception explicite de
 * Ctrl+C dans `App` (même chemin que "q" : `isDirty` puis confirmation),
 * est ce qui rend cette confirmation réellement incontournable — trouvé en
 * revue de cette tâche, voir le rapport de correction.
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

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App root={root} renderer={renderer} />);
