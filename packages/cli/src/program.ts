/**
 * Câblage commander des sous-commandes décrites par le brief de la tâche 6,
 * autour de `@caesar/core` : `buildProgram` construit le programme, `runCli`
 * l'enveloppe (parse `argv`, traduit les `CommanderError` en code de sortie).
 * Aucune des deux ne parse `process.argv` ni n'appelle `process.exit` — ce
 * sont des fonctions pures du point de vue du processus, ce qui les rend
 * importables sans effet de bord par un test, ou par un point d'entrée.
 *
 * Deux points d'entrée les importent (tâche 12) :
 *  - `bin.ts`, le point d'entrée Node (`node dist/bin.js`), qui les enveloppe
 *    d'un garde d'auto-invocation (`isMain`) ;
 *  - `bun-entry.ts`, le point d'entrée du binaire autonome compilé par Bun,
 *    qui les enveloppe d'un garde différent — voir plus bas.
 *
 * Ce module vivait à l'origine dans `bin.ts` lui-même, `isMain` compris.
 * Séparé ici en revue de la tâche 12 : `bin.ts` importé par `bun-entry.ts`
 * (pour réutiliser `runCli` "le programme commander existant" plutôt que de
 * le dupliquer) exécutait alors *deux fois* le CLI dans le binaire compilé —
 * un double `caesar --version`/`caesar doctor` constaté en vérifiant le binaire
 * réel, jamais dans les tests `vitest`, qui n'assemblent jamais un binaire
 * Bun. La cause : dans un exécutable produit par `bun build --compile`,
 * `import.meta.url` vaut la même URL virtuelle (`file:///$bunfs/root/<nom
 * du binaire>`) pour *tous* les modules du bundle, quel que soit leur
 * fichier source d'origine — et `process.argv[1]` vaut cette même URL. Le
 * garde `fileURLToPath(import.meta.url) === process.argv[1]` de `bin.ts`,
 * pensé pour Node (où chaque module garde son propre `import.meta.url`),
 * devenait donc vrai pour n'importe quel module du bundle, y compris
 * `bin.ts` importé comme simple bibliothèque par `bun-entry.ts` : son bloc
 * d'auto-invocation se déclenchait une seconde fois, en plus de l'appel
 * explicite de `bun-entry.ts`. En sortant `buildProgram`/`runCli` de
 * `bin.ts` vers ce module neutre, `bun-entry.ts` n'importe plus jamais le
 * fichier qui porte ce garde : `bin.ts` reste le seul à s'auto-invoquer, et
 * seulement quand Node le charge comme point d'entrée réel.
 */
import { Command, CommanderError } from "commander";
import {
  ARG_TOKENS_HINT,
  runAgentsAdd,
  runAgentsDisable,
  runAgentsEnable,
  runAgentsList,
  runAgentsRemove,
  runAgentsTest,
} from "./commands/agents.js";
import type { AgentsAddOptions } from "./commands/agents.js";
import { runChannelServe } from "./commands/channel.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runGc } from "./commands/gc.js";
import { runInit } from "./commands/init.js";
import { runMcpInstall, runMcpServe } from "./commands/mcp.js";
import { runPolicyAllow, runPolicyDeny, runPolicyShow } from "./commands/policy.js";
import { runProtocolSchema } from "./commands/protocol.js";
import { runRoleAdd, runRoleList, runRoleRemove, runRoleShow } from "./commands/role.js";
import { runRun } from "./commands/run.js";
import { runApply, runCancel, runDiff, runLogs, runPs } from "./commands/tasks.js";
import { runWatch } from "./commands/watch.js";
import type { Io } from "./output.js";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, printError, processIo } from "./output.js";
import { formatHelp } from "./help.js";
import { resolveRoot } from "./root.js";
import { VERSION } from "./version.js";

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
 * `--global`/`--local` : la couche visée par une commande qui écrit (`policy
 * allow|deny`, `agents enable|disable`, `role add|remove`). Sans l'une ou
 * l'autre : couche projet, comme avant la tâche 13. Mutuellement exclusives
 * — `resolveScope` (`../scope.js`) le vérifie à l'exécution et le dit
 * clairement plutôt que de laisser la dernière lue l'emporter en silence.
 */
function withScopeOptions(command: Command): Command {
  return command
    .option("--global", "Cible la couche globale (~/.config/caesar/config.toml) plutôt que la couche projet.")
    .option("--local", "Cible la couche locale du projet (.caesar/config.local.toml, non versionnée) plutôt que la couche projet.");
}

/**
 * Construit le programme commander. Ne parse rien : `exitCodeRef` reçoit le
 * code de sortie de la commande exécutée, lu par l'appelant après
 * `parseAsync`.
 *
 * `argv` sert uniquement à savoir si un « -- » figurait dans la ligne de
 * commande (voir la commande `run`). Commander ne le conserve pas dans son
 * API publique — il porte bien un `rawArgs`, mais hors typages, donc hors
 * contrat. Le passer explicitement coûte un paramètre et ne dépend de rien
 * d'interne.
 */
export function buildProgram(io: Io, exitCodeRef: { value: number }, argv: readonly string[] = []): Command {
  const program = new Command();
  program
    .name("caesar")
    .description("Orchestrateur de sous-agents de code (Antigravity, Codex, OpenCode, Copilot, Claude).")
    // Les libellés par défaut de commander sont en anglais : sans ces trois
    // remplacements, « output the version number » et « display help for
    // command » figuraient au milieu d'une aide entièrement française.
    .version(VERSION, "-V, --version", "Affiche la version de caesar.")
    .helpOption("-h, --help", "Affiche cette aide.")
    .helpCommand("help [commande]", "Affiche l'aide d'une commande.")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout.write(str),
      writeErr: (str) => io.stderr.write(str),
    })
    // Posé **avant** la création des sous-commandes : commander copie la
    // configuration d'aide au moment du `.command()`, jamais après. Réglée
    // plus bas, elle ne s'appliquerait qu'à `caesar --help` et laisserait
    // `caesar run --help` en anglais.
    .configureHelp({ formatHelp: (cmd, helper) => formatHelp(cmd, helper, io) });

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
    .description(
      'Crée <root>/.caesar/config.toml et les prompts système par défaut de chaque rôle, et dépose la connaissance agentique (skill + commandes) pour les runtimes détectés. Sur un projet déjà initialisé, rafraîchit les assets sans toucher à la configuration ni aux rôles (--force pour tout réinitialiser). --global : ~/.config/caesar/config.toml, jamais versionné — le niveau projet, lui, l\'est, donc partagé avec l\'équipe.',
    )
    .option("--force", "Réinitialise complètement : réécrit la configuration et les prompts système existants (les assets, eux, sont de toute façon toujours rafraîchis).")
    .option("--global", "Crée/rafraîchit la couche globale (~/.config/caesar/config.toml) plutôt que la couche projet — jamais versionnée, propre à ce poste.")
    .option(
      "--agent <id>",
      'Force le dépôt pour ce runtime plutôt que la détection automatique (répétable) : claude, codex, copilot, opencode ou antigravity — le runtime qui LIT la skill (donneur d\'ordre), pas l\'exécutant choisi par "caesar run --agent".',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--no-skills", 'Ne dépose ni ne rafraîchit la skill ou les commandes agentiques. Non mémorisé : à repasser à chaque "init".')
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { force?: boolean; global?: boolean; agent?: string[]; skills?: boolean }>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runInit(root, { force: opts.force, json: opts.json, global: opts.global, agent: opts.agent, skills: opts.skills }, io);
      });
    });

  withCommonOptions(program.command("doctor"))
    .description("Diagnostic d'installation : présence, version, capacités et statut de chaque agent du catalogue.")
    .option("--verbose", "Ajoute le chemin du binaire et les capacités en toutes lettres.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions & { verbose?: boolean }>();
      await run(async () => {
        const root = await resolveRoot(opts.root);
        return runDoctor(root, { json: opts.json, verbose: opts.verbose }, io);
      });
    });

  withCommonOptions(program.command("config"))
    // La description parlait de Bun et d'un repli « sans Bun » : vrai du seul
    // chemin Node du monorepo, faux du binaire compilé — qui embarque Bun et
    // monte le TUI dans son propre processus (voir `commands/config.ts`).
    // Elle décrit maintenant ce que la commande fait, non par quoi elle est
    // rendue : la contrainte Bun, quand elle s'applique, est déjà expliquée
    // au moment où elle bloque.
    .description("Configure agents, rôles, politique et intégrations dans un écran interactif.")
    .action(async (_options: GlobalOptions, command: Command) => {
      const opts = command.optsWithGlobals<GlobalOptions>();
      await run(async () => {
        // `withCommonOptions` aligne cette commande sur toutes les autres
        // (tâche 10, C2), ce qui lui fait accepter `--json` — mais cette
        // commande lance un TUI interactif, sans sortie machine à produire.
        // L'accepter en silence laisserait croire qu'il a été honoré :
        // refusé explicitement plutôt qu'ignoré (revue de la tâche 10).
        if (opts.json) {
          printError(io, '--json n\'a pas de sens pour "caesar config" : cette commande lance un TUI interactif, pas une sortie machine.');
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

  withScopeOptions(withCommonOptions(agents.command("enable")))
    .description("Retire un agent de la liste \"denied\" de la politique (couche projet par défaut ; --global/--local).")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsEnable(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(agents.command("disable")))
    .description("Ajoute un agent à la liste \"denied\" de la politique (couche projet par défaut ; --global/--local).")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsDisable(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(agents.command("add")))
    .description("Déclare un agent : un CLI hors catalogue, décrit par sa commande et son gabarit d'arguments.")
    .argument("<id>", "Identifiant de l'agent, tel qu'on l'écrira dans --agent et dans les rôles")
    .requiredOption("--bin <commande>", "Binaire à lancer (cherché dans le PATH, ou chemin absolu).")
    .option(
      "--args <gabarit>",
      `Ligne d'arguments, guillemets respectés. Jetons substitués : ${ARG_TOKENS_HINT}. Le premier est obligatoire — sans lui, l'agent ne reçoit jamais l'objectif.`,
      "{{prompt}}",
    )
    .option("--display-name <nom>", "Nom lisible affiché à la place de l'identifiant.")
    .option(
      "--cwd-mode <mode>",
      '"process" (défaut) : le répertoire courant porte le workspace. "flag" : le workspace est déjà passé en argument.',
      "process",
    )
    .option(
      "--read-only-native",
      "Déclare que ce CLI applique lui-même un mode lecture seule : une tâche en lecture seule n'aura pas besoin d'être isolée dans un worktree.",
    )
    .action(
      async (
        id: string,
        options: GlobalOptions & AgentsAddOptions,
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runAgentsAdd(
            await resolveRoot(opts.root),
            id,
            {
              bin: opts.bin,
              args: opts.args,
              displayName: opts.displayName,
              cwdMode: opts.cwdMode,
              readOnlyNative: opts.readOnlyNative,
              json: opts.json,
              global: opts.global,
              local: opts.local,
            },
            io,
          ),
        );
      },
    );

  withScopeOptions(withCommonOptions(agents.command("remove")))
    .description("Retire une déclaration d'agent de la couche visée (couche projet par défaut ; --global/--local).")
    .argument("<id>", "Identifiant de l'agent déclaré")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runAgentsRemove(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
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

  withScopeOptions(withCommonOptions(policy.command("allow")))
    .description("Ajoute un agent à la liste \"allowed\" (couche projet par défaut ; --global/--local).")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runPolicyAllow(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(policy.command("deny")))
    .description("Ajoute un agent à la liste \"denied\" (couche projet par défaut ; --global/--local).")
    .argument("<id>", "Identifiant de l'agent")
    .action(async (id: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runPolicyDeny(await resolveRoot(opts.root), id, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
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

  withScopeOptions(withCommonOptions(role.command("remove")))
    .description("Supprime un rôle (couche projet par défaut ; --global/--local — uniquement si cette couche le déclare).")
    .argument("<name>", "Nom du rôle")
    .action(async (name: string, options: GlobalOptions & { global?: boolean; local?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runRoleRemove(await resolveRoot(opts.root), name, { json: opts.json, global: opts.global, local: opts.local }, io),
      );
    });

  withScopeOptions(withCommonOptions(role.command("add")))
    .description("Crée ou remplace un rôle (couche projet par défaut ; --global/--local). Non interactif — l'édition confortable relève du TUI.")
    .argument("<name>", "Nom du rôle")
    .option("--purpose <text>", "Intention du rôle, en une phrase.")
    .option("--agents <ids>", "Agents candidats, dans l'ordre de repli, séparés par des virgules (a,b,c).")
    .option("--mode <mode>", "\"read-only\" ou \"write\".")
    .option(
      "--isolation <isolation>",
      "\"worktree\" (atelier dédié sur une branche jetable), \"auto\" (défaut, choisit le worktree en écriture) ou \"inplace\" — ce dernier refusé en écriture dans un dépôt git sans allow_inplace_write.",
    )
    .option("--network <network>", "\"auto\" (défaut), \"on\" (refuse la délégation si l'agent ne sait pas ouvrir le réseau) ou \"off\".")
    .option("--timeout <durée>", "Délai maximal, p. ex. \"10m\" (défaut : 10m).")
    .action(
      async (
        name: string,
        options: GlobalOptions & {
          purpose?: string;
          agents?: string;
          mode?: string;
          isolation?: string;
          network?: string;
          timeout?: string;
          global?: boolean;
          local?: boolean;
        },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () =>
          runRoleAdd(
            await resolveRoot(opts.root),
            name,
            {
              purpose: opts.purpose,
              agents: opts.agents,
              mode: opts.mode,
              isolation: opts.isolation,
              network: opts.network,
              timeout: opts.timeout,
              json: opts.json,
              global: opts.global,
              local: opts.local,
            },
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
    .argument(
      "[extra_args...]",
      "Arguments bruts transmis tels quels au CLI de l'agent, après « -- ». Échappatoire pour ce que caesar n'expose pas : caesar run --agent codex \"…\" -- --enable feature_x",
    )
    .option("--role <name>", "Rôle à travers lequel choisir l'agent.")
    .option("--agent <id>", "Agent à utiliser directement (l'emporte sur --role).")
    .option("--mode <mode>", "\"read-only\" ou \"write\".")
    .option(
      "--isolation <isolation>",
      "\"worktree\" : atelier dédié — branche jetable, plus les fichiers non suivis déclarés sous [worktree] et son setup déjà lancé. \"auto\" (défaut) le choisit en écriture dès qu'un dépôt git le permet. \"inplace\" écrit dans votre arbre de travail, et est refusé en écriture dans un dépôt git utilisable sans allow_inplace_write ; si le worktree paraît incomplet, complétez [worktree] plutôt que d'y renoncer.",
    )
    .option("--network <network>", "\"auto\" (défaut), \"on\" (refuse la délégation si l'agent ne sait pas ouvrir le réseau) ou \"off\".")
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
        extraArgs: string[],
        options: GlobalOptions & {
          role?: string;
          agent?: string;
          mode?: string;
          isolation?: string;
          network?: string;
          timeout?: string;
          model?: string;
          context?: string;
          channel?: boolean;
        },
        command: Command,
      ) => {
        const opts = command.optsWithGlobals<typeof options>();
        await run(async () => {
          // Commander ne distingue pas les opérandes en trop de ce qui suit
          // « -- » : les deux atterrissent dans le même variadique. Sans cette
          // vérification, `caesar run "obj" coquille` partirait silencieusement
          // vers l'agent, alors que commander le refusait jusqu'ici (« too many
          // arguments »). C'est ce refus qu'on préserve, sauf intention écrite.
          if (extraArgs.length > 0 && !argv.includes("--")) {
            printError(
              io,
              `Arguments inattendus : ${extraArgs.join(" ")}. Pour les transmettre au CLI de l'agent, séparez-les par « -- ».`,
            );
            return EXIT_USAGE;
          }
          return runRun(
            await resolveRoot(opts.root),
            objective,
            {
              extraArgs,
              role: opts.role,
              agent: opts.agent,
              mode: opts.mode,
              isolation: opts.isolation,
              network: opts.network,
              timeout: opts.timeout,
              model: opts.model,
              context: opts.context,
              json: opts.json,
              channel: opts.channel,
            },
            io,
          );
        });
      },
    );

  // ---------------------------------------------------------------------
  // ps / watch / logs / cancel / diff / apply
  // ---------------------------------------------------------------------

  withCommonOptions(program.command("watch"))
    .description("Regarde les sous-agents travailler, en direct.")
    .argument("[ids...]", "Tâches à suivre. Par défaut : toutes celles en cours.")
    .option("--once", "Une seule image, puis sortie — pour un script ou un coup d'œil.")
    .action(async (ids: string[], options: GlobalOptions & { once?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runWatch(await resolveRoot(opts.root), ids, { json: opts.json, once: opts.once }, io));
    });

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

  withCommonOptions(program.command("gc"))
    .description("Nettoie les worktrees et branches laissés par les tâches terminées.")
    .option("--dry-run", "Montre les suppressions et conservations sans rien modifier.")
    .option("--force", "Supprime aussi les worktrees terminés portant des modifications non intégrées.")
    .action(async (options: GlobalOptions & { dryRun?: boolean; force?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () =>
        runGc(await resolveRoot(opts.root), { dryRun: opts.dryRun, force: opts.force, json: opts.json }, io),
      );
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
    .description("Enregistre \"caesar\" auprès d'un client MCP : claude, codex, copilot, opencode ou antigravity.")
    .argument("<client>", "claude, codex, copilot, opencode ou antigravity")
    .option("--dry-run", "Affiche ce qui serait fait (commande exécutée ou fichier écrit), sans rien exécuter ni écrire.")
    .action(async (client: string, options: GlobalOptions & { dryRun?: boolean }, command: Command) => {
      const opts = command.optsWithGlobals<typeof options>();
      await run(async () => runMcpInstall(await resolveRoot(opts.root), client, { dryRun: opts.dryRun, json: opts.json }, io));
    });

  // ---------------------------------------------------------------------
  // channel (interne, tâche 12)
  // ---------------------------------------------------------------------

  // Groupe caché : atteint par auto-invocation depuis le binaire compilé
  // (voir `configureChannelLauncher` dans `@caesar/core` et `bun-entry.ts`),
  // jamais tapé à la main — masqué de `caesar --help` (`{ hidden: true }`),
  // toujours joignable explicitement (`caesar channel serve --task-dir <dir>`).
  const channel = program
    .command("channel", { hidden: true })
    .description("Canal retour MCP : sous-commandes internes, atteintes par auto-invocation.");

  channel
    .command("serve")
    .description("Démarre le serveur du canal retour sur stdio, pour une tâche donnée.")
    .requiredOption("--task-dir <dir>", "Répertoire de la tâche (contient task.json, events.jsonl…).")
    .action(async (options: { taskDir: string }) => {
      await run(async () => runChannelServe(options.taskDir));
    });

  // ---------------------------------------------------------------------
  // protocol
  // ---------------------------------------------------------------------

  const protocol = program.command("protocol").description("Le standard @caesar/protocol : JSON Schema publiés.");

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
  const program = buildProgram(io, exitCodeRef, argv);

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
