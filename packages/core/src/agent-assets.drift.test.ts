/**
 * Test de dérive : re-marche les VRAIES sources sur disque
 * (`.claude/skills/orch/`, `.claude/commands/orch-*.md`) et compare le
 * résultat au catalogue importé (`AGENT_ASSETS`,
 * `agent-assets.generated.ts`).
 *
 * Oracle INDÉPENDANT — n'importe rien de `scripts/generate-agent-assets.mjs`
 * et ne lit pas son code : la dérivation ci-dessous est réécrite à partir de
 * zéro, uniquement à partir du contrat (parcours récursif trié, lecture des
 * commandes, normalisation CRLF→LF, règles id/path). Pourquoi ce doublon
 * délibéré plutôt qu'un import ou une copie du générateur : un test qui
 * réutiliserait sa logique ne vérifierait plus que les sources et le
 * catalogue sont synchrones, seulement que le générateur est cohérent AVEC
 * LUI-MÊME — un bug dans son tri, sa normalisation ou sa dérivation d'id se
 * retrouverait identique des deux côtés de l'égalité et ne serait jamais vu.
 * En reconstruisant la dérivation indépendamment, ce test met en regard deux
 * lectures faites par des chemins de code différents ; s'ils divergent un
 * jour — régression dans le générateur, ou markdown édité à la main sans
 * relancer `pnpm run assets:sync` — c'est précisément le bug qu'on veut voir.
 *
 * Pas de mkdtemp ici : c'est voulu (voir le brief de la tâche). Ce test lit
 * le dépôt réel, sur place — c'est le seul moyen de vérifier que ce qui est
 * committé dans `agent-assets.generated.ts` correspond à ce qui est
 * committé à côté, sous `.claude/`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_ASSETS } from "./agent-assets.generated.js";
import type { AgentAsset } from "./agent-assets.js";

// Racine du dépôt résolue depuis la position de CE fichier, jamais depuis
// process.cwd() (qui dépend d'où `pnpm test` a été invoqué — package, racine
// du monorepo, ou ailleurs).
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..");

const SKILL_DIR = join(REPO_ROOT, ".claude", "skills", "orch");
const COMMANDS_DIR = join(REPO_ROOT, ".claude", "commands");
// Les trois sous-agents du dépôt vivent ici — jamais dans le catalogue
// livré. Utilisé uniquement par la garde dédiée plus bas, jamais par la
// dérivation elle-même.
const AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");

function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Parcours récursif de `dir`, TRIÉ à chaque niveau : l'ordre de
 * `readdirSync` n'est garanti par aucun système de fichiers, et les deux
 * côtés de la comparaison (oracle, catalogue) doivent produire un ordre
 * stable et identique pour qu'une égalité d'ensembles ait un sens simple à
 * vérifier.
 */
function walkSorted(dir: string, relPrefix = ""): string[] {
  const entries = [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const results: string[] = [];
  for (const entry of entries) {
    // Chemin relatif POSIX construit à la main ("/" en dur) : c'est le
    // contrat d'AgentAsset.path (voir agent-assets.ts), indépendant du
    // séparateur du système de fichiers hôte.
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...walkSorted(join(dir, entry.name), rel));
    else if (entry.isFile()) results.push(rel);
  }
  return results;
}

/** La skill : un seul id fixe "orch" (le nom du dossier source, qui est aussi le nom du dossier d'installation — voir agent-assets.ts), un chemin par fichier trouvé sous SKILL_DIR. */
function deriveSkillAssets(): AgentAsset[] {
  if (!existsSync(SKILL_DIR)) {
    throw new Error(`Oracle de dérive : répertoire source introuvable "${SKILL_DIR}" — le dépôt semble incomplet ou la racine mal résolue.`);
  }
  return walkSorted(SKILL_DIR).map((rel) => ({
    kind: "skill",
    id: "orch",
    path: rel,
    content: toLf(readFileSync(join(SKILL_DIR, rel), "utf8")),
  }));
}

const COMMAND_PREFIX = "orch-";
const COMMAND_SUFFIX = ".md";

/** Les commandes : chaque `orch-<nom>.md` de COMMANDS_DIR devient `{ id: <nom>, path: "<nom>.md" }` — jamais un fichier sans ce préfixe (donc jamais rien sous .claude/agents/, qui n'a pas ce préfixe non plus). */
function deriveCommandAssets(): AgentAsset[] {
  if (!existsSync(COMMANDS_DIR)) {
    throw new Error(`Oracle de dérive : répertoire source introuvable "${COMMANDS_DIR}" — le dépôt semble incomplet ou la racine mal résolue.`);
  }
  const names = readdirSync(COMMANDS_DIR)
    .filter((name) => name.startsWith(COMMAND_PREFIX) && name.endsWith(COMMAND_SUFFIX) && name.length > COMMAND_PREFIX.length + COMMAND_SUFFIX.length)
    .sort();
  return names.map((name) => {
    const id = name.slice(COMMAND_PREFIX.length, -COMMAND_SUFFIX.length);
    return {
      kind: "command",
      id,
      path: `${id}${COMMAND_SUFFIX}`,
      content: toLf(readFileSync(join(COMMANDS_DIR, name), "utf8")),
    };
  });
}

// Calculé une fois, au chargement du module : si les répertoires sources
// sont absents, les fonctions ci-dessus lèvent immédiatement — tout le
// fichier de test échoue bruyamment plutôt que de continuer sur un oracle
// tronqué.
const oracle: AgentAsset[] = [...deriveSkillAssets(), ...deriveCommandAssets()];

function sortKey(asset: AgentAsset): string {
  return `${asset.kind}:${asset.id}:${asset.path}`;
}

function bySortKey(a: AgentAsset, b: AgentAsset): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

describe("catalogue d'assets agentiques — dérive contre les sources (oracle indépendant)", () => {
  it("catalogue non vide (jamais un passage à vide) : ni l'oracle, ni AGENT_ASSETS", () => {
    // Une égalité entre deux tableaux vides passerait trivialement — c'est
    // exactement le passage à vide que ce test doit interdire.
    expect(
      oracle.length,
      "L'oracle de dérive n'a rien trouvé sous .claude/skills/orch/ et .claude/commands/orch-*.md : le dépôt semble incomplet, ou les chemins de la garde ont changé.",
    ).toBeGreaterThan(0);
    expect(
      AGENT_ASSETS.length,
      'AGENT_ASSETS (packages/core/src/agent-assets.generated.ts) est vide — relancer "pnpm run assets:sync" pour régénérer le catalogue depuis les sources.',
    ).toBeGreaterThan(0);
  });

  it("sources et catalogue sont synchrones : mêmes entrées, mêmes contenus", () => {
    const sortedOracle = [...oracle].sort(bySortKey);
    const sortedActual = [...AGENT_ASSETS].sort(bySortKey);
    expect(
      sortedActual,
      'Le catalogue (agent-assets.generated.ts) a divergé des sources sur disque (.claude/skills/orch/, .claude/commands/orch-*.md). Relancer "pnpm run assets:sync" pour le régénérer.',
    ).toEqual(sortedOracle);
  });

  it("garde dédiée : .claude/agents/ (les sous-agents du dépôt) n'entre jamais dans le catalogue", () => {
    // Assertion à part entière, pas seulement une conséquence de l'égalité
    // ci-dessus : l'égalité passerait aussi bien si le générateur ET
    // l'oracle lisaient tous deux .claude/agents/ par erreur (le même bug
    // des deux côtés). Cette garde compare au contraire le catalogue au
    // contenu RÉEL de .claude/agents/, une source que ni l'oracle ni le
    // générateur ne sont censés toucher.
    expect(existsSync(AGENTS_DIR)).toBe(true);
    const agentFiles = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"));
    expect(
      agentFiles.length,
      "aucun fichier .md trouvé sous .claude/agents/ — cette garde ne contrôle plus rien, vérifier le chemin.",
    ).toBeGreaterThan(0);

    for (const name of agentFiles) {
      // Nom de fichier complet sans l'extension, PAS la règle "sans préfixe
      // orch-" des commandes : le sous-agent "orch-race.md" (agents) et la
      // commande "race" (commandes, id="race") sont deux choses distinctes,
      // à ne surtout pas confondre dans cette garde.
      const bareName = name.slice(0, -".md".length);
      const content = readFileSync(join(AGENTS_DIR, name), "utf8");

      expect(oracle.some((asset) => asset.id === bareName)).toBe(false);
      expect(oracle.some((asset) => asset.content === content)).toBe(false);
      expect(AGENT_ASSETS.some((asset) => asset.id === bareName)).toBe(false);
      expect(AGENT_ASSETS.some((asset) => asset.content === content)).toBe(false);
    }
  });
});
