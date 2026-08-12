/**
 * Catalogue des assets agentiques (skill + commandes) — généré par
 * `scripts/generate-agent-assets.mjs` à partir de `.claude/skills/orch/`
 * et `.claude/commands/orch-*.md`. NE PAS ÉDITER À LA MAIN : relancer
 * `pnpm run assets:sync` pour le régénérer.
 *
 * Pourquoi passer par un fichier `.ts` généré plutôt que de lire les
 * sources `.md` au runtime :
 *
 * - `tsc` ne copie pas les fichiers non-`.ts` dans `dist/` — un import
 *   relatif vers un `.md` serait introuvable une fois `@orch/core` compilé.
 * - `bun build --compile` (consommé par `packages/tui`) n'embarque dans le
 *   binaire unique que ce que le bundler voit statiquement suivre depuis les
 *   imports JS/TS ; un `readFile` relatif au source ne survit pas à cette
 *   compilation, et casserait le binaire en silence.
 * - `import contenu from "./x.md" with { type: "text" }` (import
 *   attributes) passe sous Bun mais échoue sous Node 24
 *   (`ERR_UNKNOWN_FILE_EXTENSION`) — or npm/Node est le chemin principal de
 *   ce monorepo (voir `engines.node` à la racine).
 *
 * L'annotation de type explicite ci-dessous (`: readonly AgentAsset[]`) est
 * obligatoire, pas cosmétique : sans elle, `declaration: true` (actif dans
 * `tsconfig.base.json`) inférerait un type littéral portant chaque contenu
 * markdown en toutes lettres dans les `.d.ts` générés — un alourdissement
 * pur, puisque rien n'a besoin de connaître ce contenu au niveau des types.
 */
import type { AgentAsset } from "./agent-assets.js";

export const AGENT_ASSETS: readonly AgentAsset[] = [];
