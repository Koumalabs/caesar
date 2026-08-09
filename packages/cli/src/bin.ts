#!/usr/bin/env node
/**
 * Point d'entrée du binaire `orch` : câblage commander des sous-commandes
 * décrites par le brief de la tâche 6, autour de `@orch/core`.
 *
 * `buildProgram` construit le programme sans jamais analyser `process.argv`
 * ni appeler `process.exit` : c'est ce qui permet de l'importer depuis un
 * test sans effet de bord. Seul le bloc final (exécuté uniquement quand ce
 * fichier est lancé directement, pas quand il est importé) fait réellement
 * tourner le CLI.
 */
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { runAgentsDisable, runAgentsEnable, runAgentsList, runAgentsTest } from "./commands/agents.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMcpInstall, runMcpServe } from "./commands/mcp.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./commands/policy.js";
import { runProtocolSchema } from "./commands/protocol.js";
import { runRoleAdd, runRoleList, runRoleRemove, runRoleShow } from "./commands/role.js";
import { runRun } from "./commands/run.js";
import { runApply, runCancel, runDiff, runLogs, runPs } from "./commands/tasks.js";
import type { Io } from "./output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, processIo } from "./output.js";
import { resolveRoot } from "./root.js";

interface GlobalOptions {
  root?: string;
  json?: boolean;
}

/** Vrai si `error` porte un `.code` système (erreur `fs`, sous-processus…) plutôt qu'un `Error` métier écrit à la main. */
function hasSystemErrorCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Options communes à toute commande : `--root` (racine explicite) et `--json` (sortie machine). */
function withCommonOptions(command: Command): Command {
  return command
    .option("--root <dir>", "Racine du projet (défaut : recherche automatique depuis le répertoire courant)")
    .option("--json", "Sortie JSON, sans couleur ni mise en forme");
}

/**
 * Construit le programme commander. Ne parse rien : `exitCodeRef` reçoit le
 * code de sortie de la commande exécutée, lu par l'appelant après
 * `parseAsync`.
 */
export function buildProgram(io: Io, exitCodeRef: { value: number }): Command {
  const program = new Command();
  program
    .name("orch")
    .description("Orchestrateur de sous-agents de code (Antigravity, Codex, OpenCode, Copilot, Claude).")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout.write(str),
      writeErr: (str) => io.stderr.write(str),
    });

  async function run(action: () => Promise<number>): Promise<void> {
    try {
      exitCodeRef.value = await action();
    } catch (error) {
      // Filet de sécurité : chaque commande retourne déjà son propre code
      // pour ses échecs attendus (refus de politique, argument invalide,
      // tâche inconnue…). Une exception qui remonte jusqu'ici est donc
      // inattendue, et de deux natures possibles, distinguées ici plutôt que
      // toutes deux mappées sur le code 2 (tâche 10, C) :
      //  - le plus souvent, `loadConfig` qui échoue sur un fichier de
      //    configuration mal formé (TOML invalide, schéma non respecté) — ce
      //    reste, par nature, une erreur de configuration/usage : code 2.
      //    Ces erreurs sont toujours des `Error` écrites à la main, sans
      //    `.code` (voir `config.ts`, qui réenveloppe systématiquement les
      //    erreurs système avant de les relever).
      //  - un vrai échec d'exécution (E/S, sous-processus git, etc.) porte
      //    au contraire un `.code` système — celui-là relève du code 1.
      printError(io, error instanceof Error ? error.message : String(error));
      exitCodeRef.value = !(error instanceof CommanderError) && hasSystemErrorCode(error) ? EXIT_RUNTIME : EXIT_USAGE;
    }
  }

  // ---------------------------------------------------------------------
  // init / doctor
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("init"))
    .description("Crée <root>/.orch/config.toml et les prompts système par défaut de chaque rôle.")
    .option("--force", "Écrase une configuration de projet existante.")
    .action(async (options: GlobalOptions & { force?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { force?: boolean }>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runInit(root, { force: opts.force, json: opts.json }, io);
      });
    });

  withCommonOptions(program.command("doctor"))
    .description("Diagnostic d'installation : présence, version, capacités et statut de chaque agent du catalogue.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runDoctor(root, { json: opts.json }, io);
      });
    });

  withCommonOptions(program.command("config"))
    .description("Lance le TUI de configuration (OpenTUI, sous Bun). Sans Bun : renvoie vers les sous-commandes équivalentes.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => {
        // `withCommonOptions` aligne cette commande sur toutes les autres
        // (tâche 10, C2), ce qui lui fait accepter `--json` — mais cette
        // commande lance un TUI interactif, sans sortie machine à produire.
        // L'accepter en silence laisserait croire qu'il a été honoré :
        // refusé explicitement plutôt qu'ignoré (revue de la tâche 10).
        if (opts.json) {
          printError(io, '--json n\'a pas de sens pour "orch config" : cette commande lance un TUI interactif, pas une sortie machine.');
          return EXIT_USAGE;
        }
        return runConfig(await resolveRoot(opts.root), io);
      });
    });

  // ---------------------------------------------------------------------
  // agents
  // ---------------------------------------------------------------------

  const agents = program.command("agents").description("Catalogue des agents : présence, autorisation, capacités.");

  withCommonOptions(agents.command("list"))
    .description("Liste le catalogue des agents.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runAgentsList(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withCommonOptions(agents.command("enable"))
    .description("Retire un agent de la liste \"denied\" de la politique.")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runAgentsEnable(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(agents.command("disable"))
    .description("Ajoute un agent à la liste \"denied\" de la politique.")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runAgentsDisable(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(agents.command("test"))
    .description("Lance une micro-tâche en lecture seule pour vérifier qu'un agent répond. Consomme son quota réel.")
    .argument("<id>", "Identifiant de l'agent")
    .option("--yes", "Confirme l'exécution réelle (obligatoire, sans confirmation interactive).")
    .action(async (id: string, options: GlobalOptions & { yes?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { yes?: boolean }>();
      await run(async () => runAgentsTest(await resolveRoot(opts.root), id, { yes: opts.yes, json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // policy
  // ---------------------------------------------------------------------

  const policy = program.command("policy").description("Politique de délégation : listes allow/deny, provenance.");

  withCommonOptions(policy.command("show"))
    .description("Affiche la politique effective, avec la provenance de chaque valeur (global, projet, défaut).")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runPolicyShow(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withCommonOptions(policy.command("allow"))
    .description("Ajoute un agent à la liste \"allowed\".")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runPolicyAllow(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(policy.command("deny"))
    .description("Ajoute un agent à la liste \"denied\".")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runPolicyDeny(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // role
  // ---------------------------------------------------------------------

  const role = program.command("role").description("Rôles : agents de repli, mode, isolation, prompt système.");

  withCommonOptions(role.command("list"))
    .description("Liste les rôles, avec l'agent qui serait retenu aujourd'hui.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runRoleList(await resolveRoot(opts.root), { json: opts.json }, io));
    });

  withCommonOptions(role.command("show"))
    .description("Détail d'un rôle, prompt système compris.")
    .argument("<name>", "Nom du rôle")
    .action(async (name: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runRoleShow(await resolveRoot(opts.root), name, { json: opts.json }, io));
    });

  withCommonOptions(role.command("remove"))
    .description("Supprime un rôle du projet.")
    .argument("<name>", "Nom du rôle")
    .action(async (name: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runRoleRemove(await resolveRoot(opts.root), name, { json: opts.json }, io));
    });

  withCommonOptions(role.command("add"))
    .description("Crée ou remplace un rôle. Non interactif — l'édition confortable relève du TUI.")
    .argument("<name>", "Nom du rôle")
    .option("--purpose <text>", "Intention du rôle, en une phrase.")
    .option("--agents <ids>", "Agents candidats, dans l'ordre de repli, séparés par des virgules (a,b,c).")
    .option("--mode <mode>", "\"read-only\" ou \"write\".")
    .option("--isolation <isolation>", "\"inplace\", \"worktree\" ou \"auto\" (défaut : auto).")
    .option("--timeout <durée>", "Délai maximal, p. ex. \"10m\" (défaut : 10m).")
    .action(
      async (
        name: string,
        options: GlobalOptions & { purpose?: string; agents?: string; mode?: string; isolation?: string; timeout?: string },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runRoleAdd(
            await resolveRoot(opts.root),
            name,
            { purpose: opts.purpose, agents: opts.agents, mode: opts.mode, isolation: opts.isolation, timeout: opts.timeout, json: opts.json },
            io,
          ),
        );
      },
    );

  // ---------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("run"))
    .description("Délègue un objectif à un sous-agent, un aller-retour complet.")
    .argument("<objective>", "L'objectif confié à l'agent, en une phrase.")
    .option("--role <name>", "Rôle à travers lequel choisir l'agent.")
    .option("--agent <id>", "Agent à utiliser directement (l'emporte sur --role).")
    .option("--mode <mode>", "\"read-only\" ou \"write\".")
    .option("--isolation <isolation>", "\"inplace\", \"worktree\" ou \"auto\".")
    .option("--timeout <durée>", "Délai maximal, p. ex. \"10m\".")
    .option("--model <model>", "Modèle à demander à l'agent, s'il le supporte.")
    .option("--context <texte>", "Contexte additionnel. Préfixer par @ pour lire un fichier (@chemin).")
    .option(
      "--channel",
      "Active le canal retour MCP : le sous-agent peut interroger l'agent principal en cours de route (ask_orchestrator) au lieu de deviner ou d'abandonner. Ajoute un processus par délégation.",
    )
    .action(
      async (
        objective: string,
        options: GlobalOptions & {
          role?: string;
          agent?: string;
          mode?: string;
          isolation?: string;
          timeout?: string;
          model?: string;
          context?: string;
          channel?: boolean;
        },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runRun(
            await resolveRoot(opts.root),
            objective,
            {
              role: opts.role,
              agent: opts.agent,
              mode: opts.mode,
              isolation: opts.isolation,
              timeout: opts.timeout,
              model: opts.model,
              context: opts.context,
              json: opts.json,
              channel: opts.channel,
            },
            io,
          ),
        );
      },
    );

  // ---------------------------------------------------------------------
  // ps / logs / cancel / diff / apply
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("ps"))
    .description("Liste les tâches du store (par défaut : en cours + dernières terminées).")
    .option("--status <statuts>", "Filtre par statut(s), séparés par des virgules.")
    .action(async (options: GlobalOptions & { status?: string }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runPs(await resolveRoot(opts.root), { status: opts.status, json: opts.json }, io));
    });

  withCommonOptions(program.command("logs"))
    .description("Affiche les événements normalisés d'une tâche.")
    .argument("<id>", "Identifiant de la tâche")
    .option("--raw", "Sortie brute du CLI de l'agent, plutôt que les événements normalisés.")
    .option("--follow", "Suit la tâche en direct.")
    .action(async (id: string, options: GlobalOptions & { raw?: boolean; follow?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runLogs(await resolveRoot(opts.root), id, { raw: opts.raw, follow: opts.follow, json: opts.json }, io));
    });

  withCommonOptions(program.command("cancel"))
    .description("Annule une tâche en cours (SIGTERM au processus enregistré).")
    .argument("<id>", "Identifiant de la tâche")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runCancel(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(program.command("diff"))
    .description("Affiche le diff du worktree d'une tâche.")
    .argument("<id>", "Identifiant de la tâche")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runDiff(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  withCommonOptions(program.command("apply"))
    .description("Applique le diff du worktree d'une tâche au dépôt principal.")
    .argument("<id>", "Identifiant de la tâche")
    .action(async (id: string, _options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => runApply(await resolveRoot(opts.root), id, { json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // mcp
  // ---------------------------------------------------------------------

  const mcp = program
    .command("mcp")
    .description("Serveur MCP : expose les tools de délégation à un agent principal, et l'enregistrement auprès de ses clients.");

  mcp
    .command("serve")
    .description('Démarre le serveur MCP sur stdio. Rien d\'autre que le protocole n\'écrit sur stdout : les diagnostics vont sur stderr.')
    .option("--root <dir>", "Racine du projet (défaut : recherche automatique depuis le répertoire courant)")
    .action(async (options: { root?: string }) => {
      await run(async () => runMcpServe(await resolveRoot(options.root), io));
    });

  withCommonOptions(mcp.command("install"))
    .description("Enregistre \"orch\" auprès d'un client MCP : claude, codex, copilot, opencode ou antigravity.")
    .argument("<client>", "claude, codex, copilot, opencode ou antigravity")
    .option("--dry-run", "Affiche ce qui serait fait (commande exécutée ou fichier écrit), sans rien exécuter ni écrire.")
    .action(async (client: string, options: GlobalOptions & { dryRun?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runMcpInstall(await resolveRoot(opts.root), client, { dryRun: opts.dryRun, json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // protocol
  // ---------------------------------------------------------------------

  const protocol = program.command("protocol").description("Le standard @orch/protocol : JSON Schema publiés.");

  withCommonOptions(protocol.command("schema"))
    .description("Publie le JSON Schema d'un document du standard (task, report, event). Sans argument : les liste.")
    .argument("[name]", "task, report ou event")
    .option("--strict", "Variante pour les sorties structurées natives (report uniquement).")
    .action(async (name: string | undefined, options: GlobalOptions & { strict?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runProtocolSchema(name, { strict: opts.strict, json: opts.json }, io));
    });

  return program;
}

/** Fait tourner le CLI sur `argv` et renvoie le code de sortie. N'appelle jamais `process.exit`. */
export async function runCli(argv: string[], io: Io = processIo): Promise<number> {
  const exitCodeRef = { value: EXIT_OK };
  const program = buildProgram(io, exitCodeRef);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    // commander.help / commander.version : déjà écrits sur les flux configurés, sortie 0.
    if (error instanceof CommanderError) {
      if (error.code.startsWith("commander.help") || error.code === "commander.version") return EXIT_OK;
      // Toute autre CommanderError (argument manquant, option inconnue…) a déjà
      // été écrite sur stderr par commander lui-même (`configureOutput`) : ne
      // pas la réimprimer, seulement traduire son code de sortie vers celui
      // du brief (2 = erreur d'usage).
      return EXIT_USAGE;
    }
    printError(io, error instanceof Error ? error.message : String(error));
    return EXIT_USAGE;
  }

  return exitCodeRef.value;
}

// Seuil d'exécution directe : ce module se comporte en bibliothèque quand il
// est importé (par les tests, notamment), et en exécutable seulement quand
// il est lancé en tant que tel.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const code = await runCli(process.argv);
  process.exitCode = code;
}
