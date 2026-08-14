/**
 * Invariants du catalogue livré (`AGENT_ASSETS`, `agent-assets.generated.ts`)
 * — indépendants de toute source : ce fichier ne relit rien sur disque, il
 * n'exerce que ce qui est déjà committé. C'est le filet qui protège le
 * chargement SILENCIEUX du catalogue chez cinq runtimes différents : un
 * frontmatter mal formé, un id avec le mauvais préfixe, ou une fuite d'un
 * outil MCP propre à un seul runtime ne fait planter aucun d'entre eux — ils
 * ignorent simplement la skill ou la commande, sans le dire. Ces tests
 * rendent visible ce que les runtimes eux-mêmes taisent.
 *
 * Complémentaire à `agent-assets.drift.test.ts` : la dérive vérifie que le
 * catalogue correspond aux sources, celui-ci vérifie que le catalogue
 * respecte son propre contrat de forme, quelle que soit son origine.
 */
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ASSETS } from "./agent-assets.generated.js";
import { ASSET_TARGETS, type AgentAsset } from "./agent-assets.js";

/** Lit un champ scalaire du frontmatter YAML (une ligne "clé: valeur"). Suffit ici : le frontmatter Claude Code de ce catalogue (voir `renderOpencodeCommand` dans agent-assets.ts) n'a que des scalaires sur une seule ligne. */
function frontmatterField(content: string, field: string): string | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return undefined;
  const block = match[1] ?? "";
  for (const line of block.split("\n")) {
    const found = new RegExp(`^${field}:\\s*(.*)$`).exec(line);
    if (found) return found[1];
  }
  return undefined;
}

describe("invariants du catalogue — non-vide", () => {
  it("AGENT_ASSETS n'est jamais vide", () => {
    expect(
      AGENT_ASSETS.length,
      'AGENT_ASSETS (packages/core/src/agent-assets.generated.ts) est vide — relancer "pnpm run assets:sync".',
    ).toBeGreaterThan(0);
  });

  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))("%s : content non vide", (_label, asset) => {
    expect(asset.content.length).toBeGreaterThan(0);
  });
});

describe("invariants du catalogue — SKILL.md", () => {
  const skill = AGENT_ASSETS.find((asset) => asset.kind === "skill" && asset.path === "SKILL.md");
  // Nom du dossier d'installation de la skill chez claude — c'est CE nom que
  // le frontmatter `name:` doit reproduire pour que le runtime la charge
  // (voir la table de faits en tête d'agent-assets.ts).
  const installedSkillName = basename(ASSET_TARGETS.find((target) => target.client === "claude")!.skillDir);

  it('l\'entrée "SKILL.md" existe', () => {
    expect(skill, 'aucune entrée { kind: "skill", path: "SKILL.md" } dans AGENT_ASSETS').toBeDefined();
  });

  it('ouvre sur "---\\n" (frontmatter requis)', () => {
    expect(skill!.content.startsWith("---\n")).toBe(true);
  });

  it(`frontmatter name === "${installedSkillName}" (le nom du dossier d'installation)`, () => {
    expect(frontmatterField(skill!.content, "name")).toBe(installedSkillName);
  });

  it('frontmatter description non vide, ≤ 1024 caractères, commence par "Use when"', () => {
    const description = frontmatterField(skill!.content, "description");
    expect(description, "SKILL.md : pas de champ description en frontmatter").toBeDefined();
    expect(description!.length).toBeGreaterThan(0);
    expect(description!.length).toBeLessThanOrEqual(1024);
    expect(description!.startsWith("Use when")).toBe(true);
  });
});

describe("invariants du catalogue — références (SKILL.md excepté)", () => {
  const references = AGENT_ASSETS.filter((asset) => asset.kind === "skill" && asset.path !== "SKILL.md");

  it("au moins une référence sous references/", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((asset) => asset.path.startsWith("references/"))).toBe(true);
  });

  // Exemptées, à la différence de SKILL.md : pas d'exigence de frontmatter
  // sur les fichiers de références (voir le brief) — aucune assertion ici
  // au-delà de leur existence, délibérément.
});

describe("invariants du catalogue — commandes", () => {
  const commands = AGENT_ASSETS.filter((asset) => asset.kind === "command");

  it("au moins une commande dans le catalogue", () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  it.each(commands.map((command) => [command.id, command] as const))(
    '"%s" : path === id + ".md", id non vide sans préfixe "caesar-", ouvre sur "---\\n"',
    (_id, command: AgentAsset) => {
      expect(command.path).toBe(`${command.id}.md`);
      expect(command.id.length).toBeGreaterThan(0);
      // Sans ce garde-fou, l'installation composerait `caesar-${id}.md` à
      // partir d'un id qui porte déjà le préfixe, produisant
      // "caesar-caesar-*.md" (voir agent-assets.ts, COMMAND_PREFIX).
      expect(command.id.startsWith("caesar-")).toBe(false);
      expect(command.content.startsWith("---\n")).toBe(true);
    },
  );
});

describe("invariants du catalogue — sécurité des chemins", () => {
  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    '%s : ni "..", ni chemin absolu, ni antislash, ni segment vide',
    (_label, asset: AgentAsset) => {
      expect(asset.path.includes("..")).toBe(false);
      expect(asset.path.startsWith("/")).toBe(false);
      expect(asset.path.includes("\\")).toBe(false);
      expect(asset.path.split("/").every((segment) => segment.length > 0)).toBe(true);
    },
  );
});

describe("invariants du catalogue — contenu multi-runtime", () => {
  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    '%s : aucune occurrence de "mcp__caesar__" (préfixe propre à un seul runtime, le catalogue est multi-runtime)',
    (_label, asset: AgentAsset) => {
      expect(asset.content.includes("mcp__caesar__")).toBe(false);
    },
  );

  it.each(AGENT_ASSETS.map((asset) => [`${asset.kind}:${asset.path}`, asset] as const))(
    "%s : aucun \\r (tout en LF)",
    (_label, asset: AgentAsset) => {
      expect(asset.content.includes("\r")).toBe(false);
    },
  );
});
