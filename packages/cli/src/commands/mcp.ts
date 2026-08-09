/**
 * `orch mcp serve` et `orch mcp install <client>`.
 *
 * `serve` démarre le serveur MCP construit par `@orch/mcp-server` sur le
 * transport stdio. Rien d'autre que le protocole ne doit toucher stdout —
 * l'erreur classique de ce genre de serveur, qui le casse de façon obscure
 * (voir le brief de la tâche 7) : tout diagnostic (le message d'accueil
 * compris) va sur `io.stderr`, jamais sur `io.stdout`.
 *
 * `install` enregistre l'orchestrateur auprès d'un client MCP. Le plan par
 * client (sous-commande native ou fichier de configuration), son
 * application et la lecture de son état (`checkMcpStatus`, utilisé par
 * l'écran Intégrations du TUI) vivent dans `@orch/core`
 * (`mcp-registration.ts`, déplacé depuis ce fichier au rapport de correction
 * de la tâche 8 — `packages/tui` en avait besoin sans dépendre de
 * `packages/cli`). Ce module ne garde que ce qui est propre au CLI :
 * `describePlan`/`planToJson` (le format d'affichage `--json`/texte) et la
 * forme `Io`/les codes de sortie d'`orch mcp install`.
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "@orch/mcp-server";
import type { InstallPlan } from "@orch/core";
import { SERVER_NAME, applyPlan, buildPlan, isMcpClient, MCP_CLIENTS } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, printJson, writeLine } from "../output.js";

export { checkMcpStatus, MCP_CLIENTS, type McpClient, type McpRegistrationState, type McpStatus } from "@orch/core";

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface McpServeOptions {
  /** Overrides de test : jamais renseignés en usage réel (défaut : `process.stdin`/`process.stdout`, voir `StdioServerTransport`). */
  stdin?: Readable;
  stdout?: Writable;
}

export async function runMcpServe(root: string, io: Io, options: McpServeOptions = {}): Promise<number> {
  const { server } = await buildServer(root);
  writeLine(io.stderr, `Serveur MCP "${SERVER_NAME}" démarré (racine du projet : ${root}). En écoute sur stdio…`);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

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
