// Génère `packages/core/src/agent-assets.generated.ts` à partir des sources
// markdown du dépôt (skill Agent Skills + commandes, au format Claude Code).
//
// JavaScript pur, sans import du monorepo (uniquement node:fs/node:path/
// node:url) : ce script doit pouvoir tourner avant tout `tsc -b`, puisque
// c'est lui qui produit un fichier que `tsc -b` consomme ensuite. Voir
// `agent-assets.generated.ts` pour le pourquoi complet du détour par un
// fichier `.ts` généré plutôt qu'une lecture des `.md` au runtime — répété
// ici en tête du fichier produit.
//
// Invocation : `node scripts/generate-agent-assets.mjs` (aussi exposé via
// `pnpm run assets:sync`), depuis n'importe quel répertoire — la racine du
// dépôt est résolue depuis la position de ce script (`import.meta.url`),
// jamais depuis le cwd.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL_ROOT = join(ROOT, ".claude", "skills", "orch");
const COMMANDS_DIR = join(ROOT, ".claude", "commands");
const OUTPUT_PATH = join(ROOT, "packages", "core", "src", "agent-assets.generated.ts");

/** Préfixe que porte chaque commande source sur disque. Retiré à l'`id`/au `path` du catalogue : c'est `agent-assets.ts` (`dest = join(dir, "orch-" + asset.path)`) qui le rajoute lui-même à l'installation — le catalogue ne doit JAMAIS le porter, sous peine d'installer "orch-orch-delegate.md". */
const COMMAND_PREFIX = "orch-";

function toLf(content) {
  return content.replace(/\r\n/g, "\n");
}

function readTextFile(path) {
  return toLf(readFileSync(path, "utf8"));
}

/**
 * Comparaison par code unit, jamais `localeCompare` : un tri dont l'ordre
 * dépendrait de la locale ICU de la machine qui lance le script romprait le
 * déterminisme (même sources, machines différentes → fichiers différents).
 */
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Parcourt récursivement `dir`, en triant les entrées à CHAQUE niveau
 * (sinon l'ordre dépend de l'ordre de retour du système de fichiers, et le
 * fichier généré churne dans git sans que les sources aient changé). Ne
 * retient que les fichiers réguliers : `entry.isFile()`/`isDirectory()`
 * renvoient tous deux `false` pour un lien symbolique (readdirSync avec
 * `withFileTypes` ne le résout pas), ce qui l'exclut naturellement sans
 * jamais le suivre.
 */
function walkSkillFiles(dir, relPrefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true }).sort(byName);
  const files = [];
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkSkillFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push({ path: rel, content: readTextFile(join(dir, entry.name)) });
    }
    // Ni fichier ni dossier (lien symbolique, socket, ...) : ignoré.
  }
  return files;
}

/** `.claude/skills/orch/**`, absent → catalogue vide sans erreur (les sources n'existent pas encore, une tâche ultérieure les rédigera). */
function collectSkillAssets() {
  if (!existsSync(SKILL_ROOT)) return [];
  return walkSkillFiles(SKILL_ROOT).map(({ path, content }) => ({ kind: "skill", id: "orch", path, content }));
}

/** `.claude/commands/orch-*.md`, à plat (pas de récursion) et trié ; absent → catalogue vide sans erreur. */
function collectCommandAssets() {
  if (!existsSync(COMMANDS_DIR)) return [];
  const entries = readdirSync(COMMANDS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(COMMAND_PREFIX) && entry.name.endsWith(".md"))
    .sort(byName);
  return entries.map((entry) => {
    const id = entry.name.slice(COMMAND_PREFIX.length, -".md".length);
    return { kind: "command", id, path: `${id}.md`, content: readTextFile(join(COMMANDS_DIR, entry.name)) };
  });
}

/**
 * Sérialise un asset en littéral d'objet TypeScript via `JSON.stringify` sur
 * chaque champ — le seul procédé sûr face à un contenu markdown qui peut
 * contenir des backticks ou des `${...}` : un gabarit à backticks les
 * laisserait s'échapper de la chaîne et casserait le fichier généré (ou,
 * pire, y injecterait de l'interpolation). Appliqué uniformément aux quatre
 * champs, pas seulement à `content`, pour une seule règle à vérifier plutôt
 * que deux façons de faire.
 */
function serializeAsset(asset) {
  return `  { kind: ${JSON.stringify(asset.kind)}, id: ${JSON.stringify(asset.id)}, path: ${JSON.stringify(asset.path)}, content: ${JSON.stringify(asset.content)} },`;
}

function renderCatalog(assets) {
  if (assets.length === 0) return "[]";
  return `[\n${assets.map(serializeAsset).join("\n")}\n]`;
}

const HEADER = `/**
 * Catalogue des assets agentiques (skill + commandes) — généré par
 * \`scripts/generate-agent-assets.mjs\` à partir de \`.claude/skills/orch/\`
 * et \`.claude/commands/orch-*.md\`. NE PAS ÉDITER À LA MAIN : relancer
 * \`pnpm run assets:sync\` pour le régénérer.
 *
 * Pourquoi passer par un fichier \`.ts\` généré plutôt que de lire les
 * sources \`.md\` au runtime :
 *
 * - \`tsc\` ne copie pas les fichiers non-\`.ts\` dans \`dist/\` — un import
 *   relatif vers un \`.md\` serait introuvable une fois \`@orch/core\` compilé.
 * - \`bun build --compile\` (consommé par \`packages/tui\`) n'embarque dans le
 *   binaire unique que ce que le bundler voit statiquement suivre depuis les
 *   imports JS/TS ; un \`readFile\` relatif au source ne survit pas à cette
 *   compilation, et casserait le binaire en silence.
 * - \`import contenu from "./x.md" with { type: "text" }\` (import
 *   attributes) passe sous Bun mais échoue sous Node 24
 *   (\`ERR_UNKNOWN_FILE_EXTENSION\`) — or npm/Node est le chemin principal de
 *   ce monorepo (voir \`engines.node\` à la racine).
 *
 * L'annotation de type explicite ci-dessous (\`: readonly AgentAsset[]\`) est
 * obligatoire, pas cosmétique : sans elle, \`declaration: true\` (actif dans
 * \`tsconfig.base.json\`) inférerait un type littéral portant chaque contenu
 * markdown en toutes lettres dans les \`.d.ts\` générés — un alourdissement
 * pur, puisque rien n'a besoin de connaître ce contenu au niveau des types.
 */
`;

function render(skillAssets, commandAssets) {
  const catalog = renderCatalog([...skillAssets, ...commandAssets]);
  return `${HEADER}import type { AgentAsset } from "./agent-assets.js";

export const AGENT_ASSETS: readonly AgentAsset[] = ${catalog};
`;
}

function main() {
  const skillAssets = collectSkillAssets();
  const commandAssets = collectCommandAssets();
  const generated = render(skillAssets, commandAssets);

  const previous = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : undefined;
  const unchanged = previous === generated;
  // N'écrit que si le contenu diffère : une réécriture à l'identique ferait
  // rebâtir `tsc -b` pour rien (mtime avancé sans que rien n'ait changé).
  if (!unchanged) writeFileSync(OUTPUT_PATH, generated);

  console.log(
    `${skillAssets.length} fichier(s) skill, ${commandAssets.length} commande(s), ${unchanged ? "inchangé" : "écrit"} (${OUTPUT_PATH}).`,
  );
}

main();
