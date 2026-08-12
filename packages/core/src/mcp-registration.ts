/**
 * Enregistrement de l'orchestrateur auprès des clients MCP (`claude`,
 * `codex`, `copilot`, `opencode`, `antigravity`) : le plan d'installation
 * par client, son application (sous-commande native ou écriture de
 * fichier), et la lecture de son état actuel.
 *
 * Déplacé depuis `packages/cli/src/commands/mcp.ts` (tâche 8, rapport de
 * correction) : `packages/tui` (écran Intégrations) avait besoin de cette
 * même logique, et la faire dépendre de `packages/cli` pour l'obtenir
 * créait une dépendance de workspace cyclique avec le sens `cli → tui`
 * qu'`orch config` a légitimement besoin (résolution dynamique du chemin de
 * `@orch/tui`, jamais un import statique). Ramener ce module ici, à côté de
 * `config.ts`/`policy.ts`, rétablit une seule direction de dépendance —
 * même raisonnement que `resolveDelegation` (`delegation.ts`) à la tâche
 * précédente.
 *
 * `packages/cli` (`commands/mcp.ts`) garde un habillage fin par-dessus ce
 * module : le format d'affichage propre au CLI (`describePlan`/`planToJson`,
 * spécifiques à `--json`/texte) et la forme `Io`/codes de sortie d'
 * `orch mcp install`. Ce module-ci ne connaît ni l'un ni l'autre — il
 * construit un plan, l'applique, ou lit un statut, et rien de plus.
 *
 * Note sur `opencode` (héritée du brief de la tâche 7, reprise telle
 * quelle) : rangé parmi les clients à sous-commande native par ce brief,
 * mais `opencode mcp add --help` (vérifié sur la machine de développement)
 * ne connaît aucun moyen non interactif de fournir la commande d'un serveur
 * stdio local — seulement un prompt interactif. L'automatiser en devinant la
 * séquence de prompts serait le flag inventé que les contraintes du projet
 * interdisent ; `opencode` est donc traité ici comme les clients à fichier.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { homeDirectory, isEnoent } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";

const execFileAsync = promisify(execFile);

/** Nom sous lequel l'orchestrateur s'enregistre chez chaque client — cohérent avec `ChannelSchema.server_name` (`@orch/protocol`). */
export const SERVER_NAME = "orch";

export const MCP_CLIENTS = ["claude", "codex", "copilot", "opencode", "antigravity"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

function serveArgs(root: string): string[] {
  return ["mcp", "serve", "--root", root];
}

export interface CommandInstallPlan {
  client: McpClient;
  kind: "command";
  bin: string;
  args: string[];
}

export interface FileInstallPlan {
  client: McpClient;
  kind: "file";
  path: string;
  /** Clé sous laquelle fusionner `entry`, à la clé `SERVER_NAME` — "mcpServers" (Copilot, Antigravity) ou "mcp" (OpenCode). */
  mergeKey: string;
  entry: Record<string, unknown>;
}

export type InstallPlan = CommandInstallPlan | FileInstallPlan;

export function buildPlan(client: McpClient, root: string): InstallPlan {
  switch (client) {
    case "claude":
      return { client, kind: "command", bin: "claude", args: ["mcp", "add", SERVER_NAME, "--", "orch", ...serveArgs(root)] };
    case "codex":
      return { client, kind: "command", bin: "codex", args: ["mcp", "add", SERVER_NAME, "--", "orch", ...serveArgs(root)] };
    case "copilot":
      return {
        client,
        kind: "file",
        path: join(homeDirectory(), ".copilot", "mcp-config.json"),
        mergeKey: "mcpServers",
        entry: { type: "stdio", command: "orch", args: serveArgs(root) },
      };
    case "antigravity":
      return {
        client,
        kind: "file",
        // Chemin donné par le brief de la tâche 7 : ce fichier porte déjà des
        // réglages personnels de l'utilisateur (dont `trustedWorkspaces`),
        // préservés par la fusion ci-dessous (`applyPlan`).
        path: join(homeDirectory(), ".gemini", "antigravity-cli", "settings.json"),
        mergeKey: "mcpServers",
        entry: { command: "orch", args: serveArgs(root) },
      };
    case "opencode":
      // "command" est un tableau chez OpenCode, à la différence de
      // "command"/"args" séparés chez Copilot et Antigravity.
      return {
        client,
        kind: "file",
        path: join(homeDirectory(), ".config", "opencode", "opencode.json"),
        mergeKey: "mcp",
        entry: { type: "local", command: ["orch", ...serveArgs(root)], enabled: true },
      };
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return {};
    throw new Error(`Impossible de lire ${path} : ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Fichier JSON invalide : ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Sérialisation JSON lisible (indentée) par-dessus `writeFileAtomic` (`fs-atomic.ts`). */
async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

/** N'écrase jamais le fichier : ne modifie que la clé `mergeKey.orch`, tout le reste (dont, pour Antigravity, `trustedWorkspaces`) est préservé tel quel. */
export async function applyPlan(plan: InstallPlan): Promise<void> {
  if (plan.kind === "command") {
    await execFileAsync(plan.bin, plan.args);
    return;
  }
  const existing = await readJsonFile(plan.path);
  const bucket = (existing[plan.mergeKey] as Record<string, unknown> | undefined) ?? {};
  const merged = { ...existing, [plan.mergeKey]: { ...bucket, [SERVER_NAME]: plan.entry } };
  await writeJsonFileAtomic(plan.path, merged);
}

/**
 * État d'enregistrement d'un client MCP, utilisé par l'écran Intégrations du
 * TUI (voir le brief de la tâche 8) — pas de bouton "installer" qui ignore
 * ce qui est déjà en place.
 *
 * Pour les clients à fichier (`copilot`, `antigravity`, `opencode`), l'état
 * se lit honnêtement : le fichier existe-t-il, porte-t-il déjà l'entrée
 * `SERVER_NAME` ? Pour les clients à sous-commande (`claude`, `codex`),
 * aucune lecture fiable et sans effet de bord n'est disponible : `claude mcp
 * list` fait un health-check des serveurs approuvés (effet de bord réseau) et
 * ne publie pas de `--json` ; `codex mcp list --json` existe mais reste
 * asymétrique avec `claude`. Plutôt que de deviner ou d'invoquer l'un et pas
 * l'autre (l'incohérence serait pire que l'absence d'info — voir la
 * contrainte globale n°3 sur les flags non vérifiés), `registered` vaut
 * `"unknown"` pour les deux, avec un motif qui nomme la sous-commande à
 * lancer soi-même.
 */
export type McpRegistrationState = "registered" | "not-registered" | "unknown";

export interface McpStatus {
  client: McpClient;
  registered: McpRegistrationState;
  detail: string;
}

export async function checkMcpStatus(client: McpClient, root: string): Promise<McpStatus> {
  const plan = buildPlan(client, root);
  if (plan.kind === "command") {
    return {
      client,
      registered: "unknown",
      detail: `Statut non vérifiable sans effet de bord : lancez "${plan.bin} mcp list" pour le consulter vous-même.`,
    };
  }

  const existing = await readJsonFile(plan.path);
  const bucket = existing[plan.mergeKey] as Record<string, unknown> | undefined;
  const registered = bucket !== undefined && Object.prototype.hasOwnProperty.call(bucket, SERVER_NAME);
  return {
    client,
    registered: registered ? "registered" : "not-registered",
    detail: registered ? `Déjà enregistré dans ${plan.path}.` : `Absent de ${plan.path}.`,
  };
}
