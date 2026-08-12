/**
 * Catalogue des assets agentiques (skill + commandes) — généré par
 * `scripts/generate-agent-assets.mjs` (tâche suivante), jamais écrit à la
 * main : ce fichier-ci n'est qu'un placeholder vide, en attendant ce
 * générateur.
 *
 * Pourquoi passer par un fichier `.ts` généré plutôt que de lire les sources
 * `.md` au runtime :
 *
 * - `tsc` ne copie pas les fichiers non-`.ts` dans `dist/` — un import
 *   relatif vers un `.md` serait introuvable une fois `@orch/core` compilé.
 * - `bun build --compile` (consommé par `packages/tui`) n'embarque dans le
 *   binaire unique que ce que le bundler voit statiquement suivre depuis les
 *   imports JS/TS ; un fichier lu via `fs` à un chemin relatif au source ne
 *   survit pas à cette compilation.
 * - `import contenu from "./x.md" with { type: "text" }` (import attributes)
 *   échoue sous Node 24, le runtime de ce monorepo (voir `engines.node` à la
 *   racine) : pas de support pour `type: "text"`.
 *
 * Le générateur transformera donc chaque fichier source (skill et commandes,
 * au format Claude Code) en littéraux de chaîne TypeScript, réunis ici sous
 * `AGENT_ASSETS`.
 *
 * L'annotation de type explicite ci-dessous (`: readonly AgentAsset[]`) est
 * obligatoire, pas cosmétique : sans elle, `declaration: true` (actif dans
 * `tsconfig.base.json`) inférerait un type littéral portant chaque contenu
 * markdown en toutes lettres dans les `.d.ts` générés — un alourdissement
 * pur, puisque rien n'a besoin de connaître ce contenu au niveau des types.
 */
import type { AgentAsset } from "./agent-assets.js";

export const AGENT_ASSETS: readonly AgentAsset[] = [];
