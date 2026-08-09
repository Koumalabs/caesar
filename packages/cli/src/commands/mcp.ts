/**
 * `orch mcp serve` et `orch mcp install <client>`.
 *
 * `serve` démarre le serveur MCP construit par `@orch/mcp-server` sur le
 * transport stdio. Rien d'autre que le protocole ne doit toucher stdout —
 * l'erreur classique de ce genre de serveur, qui le casse de façon obscure
 * (voir le brief de la tâche 7) : tout diagnostic (le message d'accueil
 * compris) va sur `io.stderr`, jamais sur `io.stdout`.
 *
 * `install` enregistre l'orchestrateur auprès d'un client MCP. Trois clients
 * exposent une sous-commande native (`claude mcp add`, `codex mcp add`) qui
 * connaît son propre format — on la préfère à l'édition d'un fichier de
 * configuration. Pour les deux autres (et pour `opencode`, voir la note plus
 * bas), on écrit dans le fichier concerné en préservant tout son contenu
 * existant.
 *
 * Note sur `opencode` : le brief de la tâche 7 le range parmi les clients à
 * sous-commande native (`opencode mcp add`). Vérification faite (`opencode
 * mcp add --help` sur cette machine, et confirmation dans un ticket amont —
 * https://github.com/anomalyco/opencode/issues/18581), cette sous-commande
 * ne connaît aucun moyen non interactif de fournir la commande d'un serveur
 * stdio local : elle ne fait que demander `name`, puis prompt interactivement
 * pour le reste. L'automatiser en devinant la séquence de prompts serait
 * justement le flag inventé que les contraintes du projet interdisent (« un
 * flag inexact produit un échec silencieux à l'exécution »). `opencode` est
 * donc traité ici comme les clients à fichier de configuration — signalé
 * dans le rapport de la tâche 7, pas décidé en silence.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "@orch/mcp-server";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, printJson, writeLine } from "../output.js";

const execFileAsync = promisify(execFile);

/** Nom sous lequel l'orchestrateur s'enregistre chez chaque client — cohérent avec `ChannelSchema.server_name` (`@orch/protocol`). */
const SERVER_NAME = "orch";

export const MCP_CLIENTS = ["claude", "codex", "copilot", "opencode", "antigravity"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface McpServeOptions {
  /** Overrides de test : jamais renseignés en usage réel (défaut : `process.stdin`/`process.stdout`, voir `StdioServerTransport`). */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runMcpServe(root: string, io: Io, options: McpServeOptions = {}): Promise<number> {
  const { server } = buildServer(root);
  writeLine(io.stderr, `Serveur MCP "${SERVER_NAME}" démarré (racine du projet : ${root}). En écoute sur stdio…`);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

function serveArgs(root: string): string[] {
  return ["mcp", "serve", "--root", root];
}

interface CommandInstallPlan {
  client: McpClient;
  kind: "command";
  bin: string;
  args: string[];
}

interface FileInstallPlan {
  client: McpClient;
  kind: "file";
  path: string;
  /** Clé sous laquelle fusionner `entry`, à la clé `SERVER_NAME` — "mcpServers" (Copilot, Antigravity) ou "mcp" (OpenCode). */
  mergeKey: string;
  entry: Record<string, unknown>;
}

type InstallPlan = CommandInstallPlan | FileInstallPlan;

function buildPlan(client: McpClient, root: string): InstallPlan {
  switch (client) {
    case "claude":
      return { client, kind: "command", bin: "claude", args: ["mcp", "add", SERVER_NAME, "--", "orch", ...serveArgs(root)] };
    case "codex":
      return { client, kind: "command", bin: "codex", args: ["mcp", "add", SERVER_NAME, "--", "orch", ...serveArgs(root)] };
    case "copilot":
      return {
        client,
        kind: "file",
        path: join(homedir(), ".copilot", "mcp-config.json"),
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
        path: join(homedir(), ".gemini", "antigravity-cli", "settings.json"),
        mergeKey: "mcpServers",
        entry: { command: "orch", args: serveArgs(root) },
      };
    case "opencode":
      // Voir la note en tête de fichier : sous-commande native écartée faute
      // d'un moyen non interactif vérifié de la piloter pour un serveur
      // stdio local. "command" est un tableau chez OpenCode, à la différence
      // de "command"/"args" séparés chez Copilot et Antigravity.
      return {
        client,
        kind: "file",
        path: join(homedir(), ".config", "opencode", "opencode.json"),
        mergeKey: "mcp",
        entry: { type: "local", command: ["orch", ...serveArgs(root)], enabled: true },
      };
  }
}

function describePlan(plan: InstallPlan): string {
  if (plan.kind === "command") {
    return `${plan.client} : exécuterait "${[plan.bin, ...plan.args].join(" ")}".`;
  }
  return `${plan.client} : écrirait l'entrée "${SERVER_NAME}" dans ${plan.path} (clé "${plan.mergeKey}"), en préservant le reste du fichier.`;
}

function planToJson(plan: InstallPlan): Record<string, unknown> {
  return plan.kind === "command"
    ? { client: plan.client, action: "run-command", command: [plan.bin, ...plan.args] }
    : { client: plan.client, action: "write-file", file: plan.path, key: plan.mergeKey, entry: plan.entry };
}

/** Vrai si `error` est un `ENOENT` (fichier ou répertoire absent). */
function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
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

/** Écriture atomique — fichier temporaire dans le même répertoire, puis `rename` — même motif que `@orch/core` (`config.ts`, `store.ts`). */
async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.orch-mcp-install.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** N'écrase jamais le fichier : ne modifie que la clé `mergeKey.orch`, tout le reste (dont, pour Antigravity, `trustedWorkspaces`) est préservé tel quel. */
async function applyPlan(plan: InstallPlan): Promise<void> {
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

export interface McpInstallOptions {
  dryRun?: boolean;
  json?: boolean;
}

export async function runMcpInstall(root: string, client: string, options: McpInstallOptions, io: Io): Promise<number> {
  if (!isMcpClient(client)) {
    printError(io, `Client MCP inconnu : "${client}" (attendu l'un de : ${MCP_CLIENTS.join(", ")}).`);
    return EXIT_USAGE;
  }

  const plan = buildPlan(client, root);

  if (options.dryRun) {
    if (options.json) printJson(io, { dry_run: true, ...planToJson(plan) });
    else writeLine(io.stdout, `[simulation] ${describePlan(plan)}`);
    return EXIT_OK;
  }

  try {
    await applyPlan(plan);
  } catch (error) {
    printError(io, `Échec de l'installation pour "${client}" : ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_RUNTIME;
  }

  if (options.json) printJson(io, { dry_run: false, ...planToJson(plan) });
  else writeLine(io.stdout, describePlan(plan));
  return EXIT_OK;
}
