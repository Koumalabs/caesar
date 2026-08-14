/**
 * Point d'entrée du TUI de configuration. `runTui` monte le renderer sur la
 * racine donnée dans le processus courant ; exportée pour être importée
 * statiquement par `packages/cli/src/bun-entry.ts` (tâche 12, le point
 * d'entrée du binaire `caesar` autonome) — c'est cet import statique qui fait
 * embarquer le TUI dans le binaire compilé par Bun. `@caesar/tui` déclare ce
 * fichier comme `"main"` de son `package.json` : `import { runTui } from
 * "@caesar/tui"` s'y résout sans détour.
 *
 * Lancé directement (`bun main.tsx <root>` — le chemin que `caesar config`
 * spawn en sous-processus quand Bun est sur le `PATH`, voir
 * `packages/cli/src/commands/config.ts`), ce fichier s'auto-invoque via
 * `import.meta.main`, l'équivalent Bun natif du garde `isMain` que
 * `packages/cli/src/bin.ts` construit à la main pour Node (`process.argv[1]`
 * comparé à `fileURLToPath(import.meta.url)`) : `runTui` ne tourne donc
 * qu'une fois, jamais une seconde fois quand ce module est seulement importé
 * (par `bun-entry.ts`, ou par un test qui lirait ce fichier).
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

export async function runTui(root: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App root={root} renderer={renderer} />);
}

if (import.meta.main) {
  await runTui(process.argv[2] ?? process.cwd());
}
