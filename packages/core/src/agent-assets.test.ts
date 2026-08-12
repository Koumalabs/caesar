/**
 * Sur fixtures fabriquées, jamais sur le catalogue réel (encore vide, voir
 * `agent-assets.generated.ts`) : ce module n'a besoin de rien de plus qu'un
 * `AgentAsset[]` de test pour être exercé en entier — c'est tout l'intérêt du
 * catalogue en paramètre plutôt qu'importé.
 *
 * `withFakeHome` recréé localement (motif de `packages/cli/test/support.ts`,
 * ce test-ci vivant dans `core`) : aucun test ne doit toucher au
 * `~/.claude/`, `~/.agents/`, `~/.config/opencode/` réels de la machine.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_TARGETS,
  installAgentAssets,
  planAgentAssets,
  renderClaudeCommand,
  renderOpencodeCommand,
  type AgentAsset,
} from "./agent-assets.js";
import { MCP_CLIENTS } from "./mcp-registration.js";

async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "orch-assets-home-"));
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

const SKILL_ONLY_CATALOG: AgentAsset[] = [{ kind: "skill", id: "orch", path: "SKILL.md", content: "# Orch\nContenu de la skill.\n" }];

const COMMAND_SOURCE = "---\ndescription: Liste les agents.\nallowed-tools: Bash(orch:*)\nargument-hint: [filtre]\n---\nContenu de la commande.\n";

const FULL_CATALOG: AgentAsset[] = [
  { kind: "skill", id: "orch", path: "SKILL.md", content: "# Orch\nContenu de la skill.\n" },
  { kind: "skill", id: "orch", path: "references/cli.md", content: "# CLI\nRéférence.\n" },
  { kind: "command", id: "list-agents", path: "list-agents.md", content: COMMAND_SOURCE },
];

const SIX_TOOLS = [
  "mcp__orch__orch_list_agents",
  "mcp__orch__orch_list_roles",
  "mcp__orch__orch_status",
  "mcp__orch__orch_await",
  "mcp__orch__orch_logs",
  "mcp__orch__orch_diff",
];

describe("ASSET_TARGETS", () => {
  it("une ligne par client de MCP_CLIENTS, sans doublon ni omission", () => {
    const clients = ASSET_TARGETS.map((t) => t.client);
    expect(new Set(clients).size).toBe(clients.length);
    expect([...clients].sort()).toEqual([...MCP_CLIENTS].sort());
  });

  it("claude a un skillDir dédié, distinct du partagé ; les quatre autres cibles partagent le même skillDir", () => {
    const claude = ASSET_TARGETS.find((t) => t.client === "claude")!;
    const others = ASSET_TARGETS.filter((t) => t.client !== "claude");
    expect(others.every((t) => t.skillDir === others[0]!.skillDir)).toBe(true);
    expect(claude.skillDir).not.toBe(others[0]!.skillDir);
  });

  it("seuls claude et opencode déclarent un commandsDir", () => {
    const withCommands = ASSET_TARGETS.filter((t) => t.commandsDir !== undefined).map((t) => t.client);
    expect(withCommands.sort()).toEqual(["claude", "opencode"]);
  });

  it("les chemins littéraux correspondent exactement à la table vérifiée du brief", () => {
    expect(ASSET_TARGETS.find((t) => t.client === "claude")).toMatchObject({ skillDir: ".claude/skills/orch", commandsDir: ".claude/commands" });
    expect(ASSET_TARGETS.find((t) => t.client === "codex")).toMatchObject({ skillDir: ".agents/skills/orch" });
    expect(ASSET_TARGETS.find((t) => t.client === "copilot")).toMatchObject({ skillDir: ".agents/skills/orch" });
    expect(ASSET_TARGETS.find((t) => t.client === "opencode")).toMatchObject({ skillDir: ".agents/skills/orch", commandsDir: ".opencode/commands" });
    expect(ASSET_TARGETS.find((t) => t.client === "antigravity")).toMatchObject({ skillDir: ".agents/skills/orch" });
  });
});

describe("planAgentAssets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("le partagé est produit une seule fois même quand plusieurs cibles le désignent", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: ["codex", "antigravity", "copilot"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files.map((f) => f.path)).toEqual([join(root, ".agents/skills/orch/SKILL.md")]);
  });

  it("claude reçoit sa copie dédiée, jamais mêlée au partagé", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files.map((f) => f.path)).toEqual([join(root, ".claude/skills/orch/SKILL.md")]);
  });

  it("aucune destination ne sort de la racine visée", () => {
    const plan = planAgentAssets({ root, scope: "project", clients: [...MCP_CLIENTS], catalog: FULL_CATALOG });
    expect(plan.files.length).toBeGreaterThan(0);
    for (const file of plan.files) expect(file.path.startsWith(root + sep)).toBe(true);
  });

  it('chemin d\'asset invalide (".." absolu, segment vide) : erreur claire, pas d\'écriture ailleurs', () => {
    const withPath = (path: string): AgentAsset[] => [{ kind: "skill", id: "orch", path, content: "x" }];
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("../evil.md") })).toThrow(/\.\./);
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("/etc/passwd") })).toThrow(/absolu/);
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("a//b.md") })).toThrow(/vide/);
  });

  it("chemin d'asset invalide : contournement par antislash rejeté (segment antislash pur, et mélangé à des '/')", () => {
    // Le contrat d'AgentAsset.path promet des séparateurs POSIX uniquement :
    // un antislash n'est jamais une donnée légitime. Un découpage naïf sur
    // "/" seul laisserait passer cette valeur (aucun "/", donc un unique
    // segment opaque, ni ".." ni vide) alors qu'elle sort bel et bien de la
    // racine une fois recombinée par path.join sous Windows — défaut
    // signalé en revue.
    const withPath = (path: string): AgentAsset[] => [{ kind: "skill", id: "orch", path, content: "x" }];
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("..\\..\\..\\..\\evil.md") })).toThrow(/antislash/);
    // Mélange "/" et "\" : la moitié POSIX du chemin ne doit pas suffire à le faire passer.
    expect(() => planAgentAssets({ root, scope: "project", clients: ["claude"], catalog: withPath("references/..\\..\\evil.md") })).toThrow(
      /antislash/,
    );
    // N'écrit rien sous root/ : l'échec est levé avant tout accès disque.
    expect(readdirSync(root)).toEqual([]);
  });

  it("strictement pur : l'arbre reste intact après l'appel", () => {
    planAgentAssets({ root, scope: "project", clients: [...MCP_CLIENTS], catalog: FULL_CATALOG });
    expect(readdirSync(root)).toEqual([]);
  });

  it("contenu CRLF sur disque vs LF au catalogue → unchanged", async () => {
    const dest = join(root, ".agents", "skills", "orch", "SKILL.md");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, "# Orch\r\nContenu de la skill.\r\n", "utf8");

    const plan = planAgentAssets({ root, scope: "project", clients: ["codex"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.action).toBe("unchanged");
  });

  it("stale : nomme un orphelin orch sans le supprimer", async () => {
    const orphan = join(root, ".agents", "skills", "orch", "references", "old.md");
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, "obsolète\n", "utf8");

    const plan = planAgentAssets({ root, scope: "project", clients: ["codex"], catalog: SKILL_ONLY_CATALOG });
    expect(plan.stale).toContainEqual({ kind: "skill", id: "orch", path: orphan });
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("installAgentAssets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("crée l'arborescence par cible (dédié, partagé, commandes)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude", "opencode"], catalog: FULL_CATALOG });

    expect(await readFile(join(root, ".claude/skills/orch/SKILL.md"), "utf8")).toContain("# Orch");
    expect(await readFile(join(root, ".claude/skills/orch/references/cli.md"), "utf8")).toContain("# CLI");
    expect(await readFile(join(root, ".agents/skills/orch/SKILL.md"), "utf8")).toContain("# Orch");
    expect(await readFile(join(root, ".claude/commands/orch-list-agents.md"), "utf8")).toContain("allowed-tools");
    const opencodeCommand = await readFile(join(root, ".opencode/commands/orch-list-agents.md"), "utf8");
    expect(opencodeCommand).toContain("description:");
    expect(opencodeCommand).not.toContain("allowed-tools");
  });

  it("idempotence : un second install identique ne touche pas mtimeMs, et rend \"unchanged\"", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "orch", "SKILL.md");
    const before = (await stat(target)).mtimeMs;

    const second = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const after = (await stat(target)).mtimeMs;

    expect(after).toBe(before);
    expect(second.files.find((f) => f.path === target)?.action).toBe("unchanged");
  });

  it("fichier divergent effectivement remplacé (update)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "orch", "SKILL.md");
    await writeFile(target, "modifié à la main\n", "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(result.files.find((f) => f.path === target)?.action).toBe("update");
    expect(await readFile(target, "utf8")).toBe("# Orch\nContenu de la skill.\n");
  });

  it("fichier supprimé recréé", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });
    const target = join(root, ".claude", "skills", "orch", "SKILL.md");
    await rm(target);

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(existsSync(target)).toBe(true);
    expect(result.files.find((f) => f.path === target)?.action).toBe("create");
  });

  it("portée globale sous HOME factice : rien n'est écrit sous root/, tout va sous HOME", async () => {
    await withFakeHome(async (home) => {
      await installAgentAssets({ root, scope: "global", clients: ["claude"], catalog: FULL_CATALOG });

      expect(existsSync(join(root, ".claude"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
      expect(await readFile(join(home, ".claude", "skills", "orch", "SKILL.md"), "utf8")).toContain("# Orch");
    });
  });

  it("stale : orphelin orch-* nommé, jamais supprimé", async () => {
    const commandsDir = join(root, ".claude", "commands");
    await mkdir(commandsDir, { recursive: true });
    const orphan = join(commandsDir, "orch-obsolete.md");
    await writeFile(orphan, "# obsolète\n", "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: FULL_CATALOG });

    expect(result.stale).toContainEqual({ kind: "command", id: "obsolete", path: orphan });
    expect(existsSync(orphan)).toBe(true);
  });
});

describe("renderClaudeCommand / renderOpencodeCommand", () => {
  const source: AgentAsset = { kind: "command", id: "list-agents", path: "list-agents.md", content: COMMAND_SOURCE };

  it("claude : la source, telle quelle", () => {
    expect(renderClaudeCommand(source)).toBe(COMMAND_SOURCE);
  });

  it("opencode : retire allowed-tools et argument-hint, conserve description et le corps", () => {
    const rendered = renderOpencodeCommand(source);
    expect(rendered).toContain("description: Liste les agents.");
    expect(rendered).not.toContain("allowed-tools");
    expect(rendered).not.toContain("argument-hint");
    expect(rendered).toContain("Contenu de la commande.");
  });
});

describe("fusion de <root>/.claude/settings.json", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-assets-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("absent : créé avec les six tools", async () => {
    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    expect(result.settings?.action).toBe("create");
    const written = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    expect(written.permissions.allow).toEqual(SIX_TOOLS);
  });

  it("append-si-absent, dédoublonnage, tout le reste du fichier préservé (clés inconnues comprises)", async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ permissions: { allow: ["mcp__orch__orch_status", "Bash(ls:*)"], deny: ["Bash(rm:*)"] }, unknownTopLevel: { keep: true } }),
      "utf8",
    );

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    expect(result.settings?.action).toBe("update");
    expect([...result.settings!.added].sort()).toEqual(SIX_TOOLS.filter((t) => t !== "mcp__orch__orch_status").sort());

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.unknownTopLevel).toEqual({ keep: true });
    expect(written.permissions.deny).toEqual(["Bash(rm:*)"]);
    expect(written.permissions.allow).toContain("Bash(ls:*)");
    expect(written.permissions.allow.filter((t: string) => t === "mcp__orch__orch_status")).toHaveLength(1);
    for (const tool of SIX_TOOLS) expect(written.permissions.allow).toContain(tool);
  });

  it("deuxième passage : idempotence stricte, aucune écriture (mtimeMs)", async () => {
    await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    const path = join(root, ".claude", "settings.json");
    const before = (await stat(path)).mtimeMs;

    const second = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });
    const after = (await stat(path)).mtimeMs;

    expect(after).toBe(before);
    expect(second.settings?.action).toBe("unchanged");
    expect(second.settings?.added).toEqual([]);
  });

  it("JSON invalide : avertissement rendu à l'appelant, fichier intact", async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ ceci n'est pas du JSON", "utf8");
    const before = await readFile(path, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions" présent mais non-objet (chaîne) : avertissement, fichier intact, pas de fusion silencieuse', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: "foo" });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path) && w.includes("permissions"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions": null (posé à la main par l\'utilisateur) : avertissement, jamais écrasé silencieusement', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: null });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it('"permissions.allow" présent mais non-liste : avertissement, fichier intact', async () => {
    const path = join(root, ".claude", "settings.json");
    await mkdir(dirname(path), { recursive: true });
    const before = JSON.stringify({ permissions: { allow: "tout" } });
    await writeFile(path, before, "utf8");

    const result = await installAgentAssets({ root, scope: "project", clients: ["claude"], catalog: [] });

    expect(result.settings?.action).toBe("skip");
    expect(result.warnings.some((w) => w.includes(path) && w.includes("allow"))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("portée globale : ~/.claude/settings.json n'est jamais touché", async () => {
    await withFakeHome(async (home) => {
      const result = await installAgentAssets({ root, scope: "global", clients: ["claude"], catalog: [] });
      expect(result.settings).toBeUndefined();
      expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    });
  });

  it("scope projet mais claude absent des cibles : pas de fusion", async () => {
    const result = await installAgentAssets({ root, scope: "project", clients: ["codex"], catalog: [] });
    expect(result.settings).toBeUndefined();
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
  });
});
