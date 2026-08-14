/**
 * `caesar init [--global]` : crée la couche projet (par défaut) ou la couche
 * globale (`--global`). N'écrase jamais une configuration existante sans
 * `--force`.
 *
 * La couche **projet** ne déclare rien : `defaultConfig()` porte déjà la
 * politique et les rôles par défaut (`system_prompt_file` compris, une
 * convention de nom résolue par `resolveRole` indépendamment de toute
 * couche — voir `config.ts`) — écrire ces valeurs dans `.caesar/config.toml`
 * les y figerait, masquant toute configuration globale ultérieure (le
 * défaut I11 de la revue finale). Le rôle de cette commande, côté projet,
 * se limite donc à matérialiser les *fichiers* de prompt système
 * (`.caesar/roles/<name>.md`) et à compléter le `.gitignore`.
 *
 * La couche **globale** (`--global`), à l'inverse, écrit `defaultConfig()`
 * intégralement : c'est le point de départ éditable d'un "preset" partagé
 * par tous les projets d'un même poste — voir le plan de la tâche 13.
 *
 * ## Connaissance agentique (skill + commandes) et refresh
 *
 * `caesar init` dépose aussi la skill Agent Skills et les commandes des
 * runtimes détectés (`installAgentAssets`, `@caesar/core`) — la façon dont un
 * agent principal (claude, codex, copilot, opencode, antigravity) apprend à
 * diriger `caesar` plutôt que d'exécuter lui-même.
 *
 * **Sur un projet déjà initialisé, sans `--force` : refresh.** Relancer
 * `caesar init` ne réécrit ni `.caesar/config.toml` ni `.caesar/roles/*.md` — ce
 * sont les fichiers que l'utilisateur édite (politique, rôles, prompts
 * système), et un `init` réexécuté par réflexe (ou par un script) les
 * écraserait sans le vouloir. Seuls les assets agentiques sont
 * réécrits/rafraîchis : ils sont, eux, entièrement dérivés du catalogue
 * (`AGENT_ASSETS`) et n'ont donc rien d'un contenu que l'utilisateur
 * possède — les réécrire à l'identique du catalogue n'efface jamais un
 * choix qu'il aurait fait. C'est ce qui remplace l'ancien garde-fou
 * `EXIT_USAGE` ("configuration déjà présente") : la commande réussit
 * toujours (code 0), et le dit.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_ASSETS,
  MCP_CLIENTS,
  configPathFor,
  defaultConfig,
  detectUntrackedNeeds,
  findBinaryInPath,
  installAgentAssets,
  isEnoent,
  isMcpClient,
  listAgentDefinitions,
  loadConfig,
  projectConfigPath,
  repoRoot,
  saveLayer,
  writeFileAtomic,
} from "@caesar/core";
import type { AgentAssetInstall, AssetScope, McpClient, WorktreeConfig } from "@caesar/core";
import type { Io } from "../output.js";
import { VERSION } from "../version.js";
import {
  EXIT_OK,
  EXIT_USAGE,
  activeGlyphs,
  bannerLines,
  colorize,
  homePath,
  printDone,
  printError,
  printJson,
  printNote,
  printWarning,
  writeLine,
} from "../output.js";

export interface InitOptions {
  force?: boolean;
  json?: boolean;
  global?: boolean;
  /** `--agent <id>`, répétable : force la liste des cibles plutôt que la détection PATH. Déjà validé (contre `MCP_CLIENTS`) par `runInit` avant tout usage. */
  agent?: readonly string[];
  /** `--no-skills` (commander) : `false` coupe entièrement le dépôt/refresh des assets agentiques. Non persistant — à repasser à chaque `init`. */
  skills?: boolean;
}

/**
 * Prompts système par défaut, un par rôle livré par `defaultConfig()`. En
 * anglais : c'est un texte injecté au modèle (voir les contraintes globales
 * du projet), pas un message du CLI.
 */
const DEFAULT_ROLE_PROMPTS: Record<string, string> = {
  reviewer:
    "You are acting as a code reviewer. Review the diff you are given for bugs, regressions and risks. Do not modify any file; report what you find instead.",
  implementer:
    "You are acting as an implementer. Implement the requested task precisely, and leave behind a clear, reviewable diff.",
  investigator:
    "You are acting as an investigator. Explore the codebase to explain the mechanism you are asked about. Do not modify any file.",
};

function defaultRolePrompt(name: string): string {
  return DEFAULT_ROLE_PROMPTS[name] ?? `You are acting in the "${name}" role.`;
}

/**
 * Chemins que l'orchestrateur ne doit jamais versionner : la couche locale
 * (propre à chaque poste) et les répertoires d'exécution (tâches, worktrees,
 * état) — voir le constat I5 de la revue finale, repris ici puisque cette
 * commande est de toute façon réécrite par la tâche 13.
 */
const GITIGNORE_ENTRIES = [".caesar/config.local.toml", ".caesar/tasks/", ".caesar/wt/", ".caesar/state/"];

interface GitignoreResult {
  path: string;
  added: string[];
}

/**
 * Complète `<root>/.gitignore` avec `GITIGNORE_ENTRIES`. N'ajoute que les
 * lignes absentes, ne réécrit jamais un fichier existant depuis rien — un
 * `.gitignore` édité à la main garde son contenu. `isGitRepo` est calculé par
 * l'appelant (`repoRoot`, un sous-processus git) et réutilisé ici plutôt que
 * relancé : `runInitProject` en a de toute façon besoin pour son propre
 * avertissement, inutile de payer deux fois le sous-processus. `null` si
 * `root` n'est pas un dépôt git : rien n'est écrit, l'appelant le signale
 * dans sa propre sortie plutôt que cette fonction n'écrive un `.gitignore`
 * orphelin hors de tout dépôt.
 *
 * Écriture atomique (`writeFileAtomic`, `@caesar/core`) — même motif que
 * `saveLayer` (`config.ts`) et `packages/core/src/store.ts`, plutôt que
 * réécrire `.gitignore` en place.
 */
async function completeGitignore(root: string, isGitRepo: boolean): Promise<GitignoreResult | null> {
  if (!isGitRepo) return null;

  const path = join(root, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const added = GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
  if (added.length === 0) return { path, added };

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing;
  const content = prefix + added.join("\n") + "\n";
  await writeFileAtomic(path, content);
  return { path, added };
}

// ---------------------------------------------------------------------------
// Connaissance agentique — sélection des cibles, dépôt, rendu
// ---------------------------------------------------------------------------

/**
 * Cible interne, jamais annoncée dans `targets` : sert uniquement à déposer
 * le socle partagé (`.agents/skills/caesar/`, voir `ASSET_TARGETS` dans
 * `agent-assets.ts`) quand aucun runtime n'est détecté et qu'aucun `--agent`
 * n'a été donné. `codex` ne porte ni commandes ni fusion `settings.json` —
 * le choisir ne dépose donc jamais rien de plus que le socle partagé
 * lui-même. Le pari : les runtimes non-`claude` lisent tous ce même
 * répertoire, donc le déposer par avance profite au premier d'entre eux
 * qu'on installera — sans prétendre qu'un runtime précis est déjà servi.
 */
const SHARED_ONLY_CLIENT: McpClient = "codex";

/**
 * Détecte, pour chaque client de `MCP_CLIENTS`, si son binaire est présent
 * dans le PATH — jamais `detectAgentInstallation` (qui sonde `--version`,
 * jusqu'à 3 s par agent : coûteux et hors de propos ici, on ne veut savoir
 * que "présent ou pas"), et jamais les agents génériques de la configuration
 * (`[[agent]]`) : `caesar init` dépose la connaissance des cinq runtimes
 * natifs, pas d'un agent personnalisé qui ne lira de toute façon aucune
 * skill standard.
 */
async function detectMcpClients(): Promise<McpClient[]> {
  const defs = listAgentDefinitions();
  const present: McpClient[] = [];
  for (const client of MCP_CLIENTS) {
    const def = defs.find((d) => d.id === client);
    if (def && (await findBinaryInPath(def.bin))) present.push(client);
  }
  return present;
}

interface TargetSelection {
  /** Cibles annoncées à l'utilisateur — vide seulement dans le cas "zéro détecté, pas de --agent". */
  targets: readonly McpClient[];
  /** Cibles réellement transmises à `installAgentAssets` — jamais vide (voir `SHARED_ONLY_CLIENT`). */
  install: readonly McpClient[];
}

/** `agent` est déjà validé par `runInit` (chaque id est un `McpClient` connu) avant d'atteindre cette fonction. */
async function selectAssetTargets(agent: readonly string[] | undefined): Promise<TargetSelection> {
  if (agent && agent.length > 0) {
    const explicit = [...new Set(agent)].filter(isMcpClient);
    return { targets: explicit, install: explicit };
  }
  const detected = await detectMcpClients();
  if (detected.length > 0) return { targets: detected, install: detected };
  return { targets: [], install: [SHARED_ONLY_CLIENT] };
}

interface AssetOutcome {
  targets: readonly McpClient[];
  install: AgentAssetInstall;
}

/**
 * Calcule les cibles puis dépose/rafraîchit la skill et les commandes.
 * Appelée aussi bien au premier `init` qu'au refresh — c'est la seule partie
 * de la commande qui s'exécute dans les deux cas (voir l'en-tête du
 * module) : les runtimes présents aujourd'hui ne sont pas forcément ceux
 * détectés au premier `init`, et rien n'empêche d'ajouter `--agent` entre
 * deux passages.
 */
async function depositAssets(root: string, scope: AssetScope, options: InitOptions): Promise<AssetOutcome> {
  const selection = await selectAssetTargets(options.agent);
  const install = await installAgentAssets({ root, scope, clients: selection.install, catalog: AGENT_ASSETS });
  return { targets: selection.targets, install };
}

function plural(n: number): string {
  return n > 1 ? "s" : "";
}

/**
 * Rend le résultat de `depositAssets` en sortie humaine : une ligne de
 * confirmation nommant les runtimes servis et le nombre de fichiers
 * déposés/rafraîchis, un avertissement agrégé pour les fichiers qui
 * différaient du catalogue et ont été remplacés, puis la suite logique : la
 * skill appelle les tools du serveur MCP `caesar`, qui n'existent pour un
 * runtime qu'une fois `caesar mcp install <client>` lancé pour lui.
 *
 * Ne rend PAS `outcome.install.warnings` (`settings.json` malformé,
 * notamment) : ce sont les seuls avertissements du module qui doivent aussi
 * apparaître dans `--json`, donc l'appelant les fait passer par le tableau
 * `warnings` de premier niveau existant plutôt que par cette fonction — une
 * seule voie de rendu, jamais un doublon en sortie humaine entre cette
 * fonction et la boucle qui vide ce tableau.
 */
function printAssetsOutcome(io: Io, outcome: AssetOutcome): void {
  const changed = outcome.install.files.filter((f) => f.action !== "unchanged");
  const total = outcome.install.files.length;
  const label =
    outcome.targets.length > 0
      ? `Connaissance agentique déposée pour ${outcome.targets.join(", ")}`
      : "Aucun runtime détecté dans le PATH : socle partagé (.agents/skills/caesar/) déposé quand même";
  printDone(
    io,
    `${label} — ${changed.length} fichier${plural(changed.length)} déposé${plural(changed.length)} ou rafraîchi${plural(changed.length)} (sur ${total} géré${plural(total)}).`,
  );

  const updated = outcome.install.files.filter((f) => f.action === "update");
  if (updated.length > 0) {
    printWarning(
      io,
      `${updated.length} fichier${plural(updated.length)} géré${plural(updated.length)} par caesar remplacé${plural(updated.length)}, divergent${plural(updated.length)} du catalogue : ${updated.map((f) => homePath(f.path)).join(", ")}`,
    );
  }

  printNote(
    io,
    'La skill appelle les tools du serveur MCP "caesar" : ils n\'existent pour un runtime qu\'une fois "caesar mcp install <client>" lancé pour lui.',
  );
}

// ---------------------------------------------------------------------------
// init --global / init (projet)
// ---------------------------------------------------------------------------

async function runInitGlobal(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  // Sans --force, une couche globale déjà présente n'est plus un refus : la
  // commande réussit, laisse `defaultConfig()` intact (l'utilisateur peut
  // avoir édité ce "preset"), et se contente de rafraîchir les assets — même
  // contrat de refresh que côté projet, voir l'en-tête du module.
  const refresh = loaded.sources.global !== undefined && !options.force;
  if (!refresh) {
    await saveLayer("global", root, defaultConfig());
  }

  const assets = options.skills === false ? null : await depositAssets(root, "global", options);

  const configPath = configPathFor("global", root);
  if (options.json) {
    printJson(io, {
      scope: "global",
      config_path: configPath,
      // `true` sur un refresh (voir l'en-tête du module) : sans ce marqueur,
      // un consommateur JSON ne distingue pas « rien à réécrire cette fois »
      // de « ce champ n'a jamais rien eu à dire » (constat I3 de la revue
      // finale) — l'ambiguïté pousse vers `--force`, le seul chemin
      // destructeur.
      refreshed: refresh,
      assets: assets ? { targets: assets.targets, files: assets.install.files, stale: assets.install.stale } : null,
    });
  } else {
    printDone(
      io,
      refresh
        ? `Configuration globale laissée telle quelle : ${homePath(configPath)} (--force pour la réinitialiser).`
        : `Configuration globale créée : ${homePath(configPath)}`,
    );
    if (assets) {
      printAssetsOutcome(io, assets);
      // `computeSettingsMerge` (agent-assets.ts) ne peut rien émettre en
      // portée globale (elle sort tôt dès `scope !== "project"`) : ce
      // tableau est donc toujours vide aujourd'hui, mais rendu quand même,
      // pour ne pas dépendre silencieusement de cet invariant si le module
      // apprenait un jour un autre avertissement en portée globale.
      for (const warning of assets.install.warnings) printWarning(io, warning);
    }
  }
  return EXIT_OK;
}

async function runInitProject(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  // Sans --force, un projet déjà initialisé n'est plus un refus : c'est un
  // refresh (voir l'en-tête du module) — `.caesar/config.toml` et
  // `.caesar/roles/*.md` restent strictement intacts, seuls les assets
  // agentiques sont réécrits/rafraîchis.
  const refresh = loaded.sources.project !== undefined && !options.force;

  const rolesDir = join(root, ".caesar", "roles");
  const roleFiles: string[] = [];
  let worktree: WorktreeConfig | null = null;

  if (!refresh) {
    await mkdir(rolesDir, { recursive: true });

    // Les rôles par défaut portent déjà leur `system_prompt_file` (voir
    // `defaultConfig()`) : il ne reste qu'à matérialiser le fichier lui-même,
    // pas à déclarer le rôle dans la couche projet — voir l'en-tête de ce
    // module.
    for (const role of defaultConfig().roles) {
      if (!role.system_prompt_file) continue;
      const absPath = join(root, ".caesar", role.system_prompt_file);
      await writeFile(absPath, defaultRolePrompt(role.name) + "\n", "utf8");
      roleFiles.push(absPath);
    }

    // La couche projet ne déclare rien de plus qu'elle-même à l'initialisation
    // : écrire ici la politique et les rôles par défaut referait exactement le
    // défaut I11 que cette tâche corrige (la couche figerait les valeurs par
    // défaut, masquant toute configuration globale). Ce fichier vide marque
    // simplement l'initialisation du projet.
    //
    // `[worktree]` fait exception, et pour une raison précise : ce n'est pas une
    // valeur par défaut mais un **fait de ce projet-ci** — ce que son worktree
    // doit emporter pour qu'on puisse y travailler. Sans cette section, un
    // worktree ne contient que les fichiers suivis, l'isolation devient
    // inexploitable, et la contourner par `isolation = "inplace"` reste la seule
    // issue praticable : le défaut d'origine. Rien n'est écrit quand rien n'est
    // détecté — une section vide ferait croire à un réglage.
    worktree = await detectUntrackedNeeds(root);
    await saveLayer("project", root, worktree ? { worktree } : {});
  }

  const warnings: string[] = [];
  const isGitRepo = (await repoRoot(root)) !== null;
  if (!isGitRepo) {
    warnings.push(
      `"${root}" n'est pas un dépôt git : l'isolation "worktree" n'est pas disponible ici, l'orchestrateur repliera sur "inplace" pour les tâches en écriture, et le ".gitignore" n'a pas été complété. Lancez "git init" dans ce répertoire pour activer les deux.`,
    );
  }
  const gitignore = await completeGitignore(root, isGitRepo);

  const assets = options.skills === false ? null : await depositAssets(root, "project", options);
  if (assets) {
    // Les avertissements du module (`settings.json` malformé ou de forme
    // anormale, notamment — voir `computeSettingsMerge`, agent-assets.ts)
    // rejoignent le même tableau que les avertissements ci-dessus plutôt que
    // de ne vivre que dans la sortie humaine : sans ça, un consommateur
    // `--json` verrait `assets.files` plein de succès sans jamais apprendre
    // qu'une fusion de permissions a été sautée (`action: "skip"`).
    warnings.push(...assets.install.warnings);
  }
  if (!isGitRepo && assets) {
    warnings.push(
      `Hors dépôt git, les fichiers de connaissance agentique déposés (skill, commandes) ne seront pas versionnés : lancez "git init" dans ce répertoire pour les partager avec l'équipe.`,
    );
  }

  const configPath = projectConfigPath(root);
  if (options.json) {
    printJson(io, {
      root,
      config_path: configPath,
      roles_dir: rolesDir,
      role_files: roleFiles,
      gitignore: gitignore ? { path: gitignore.path, added: gitignore.added } : null,
      worktree,
      // `true` sur un refresh (voir l'en-tête du module) : sur un refresh,
      // `role_files` est `[]` et `worktree` est `null` sans qu'aucun rôle ni
      // atelier n'ait disparu — sans ce marqueur, un consommateur JSON ne
      // distingue pas « rien à réécrire cette fois » de « ce projet n'a ni
      // rôles ni [worktree] » (constat I3 de la revue finale), et la
      // réaction plausible à cette dernière lecture est `--force`, le seul
      // chemin destructeur.
      refreshed: refresh,
      warnings,
      assets: assets ? { targets: assets.targets, files: assets.install.files, stale: assets.install.stale } : null,
    });
  } else {
    // Le logotype ouvre `caesar init` et rien d'autre : c'est la seule commande
    // qu'on tape une fois, sans savoir encore ce que l'outil est. Ailleurs, il
    // serait du bruit à chaque invocation.
    for (const line of bannerLines(io.stdout, `orchestrateur de sous-agents · v${VERSION}`)) writeLine(io.stdout, line);
    writeLine(io.stdout);
    if (refresh) {
      printDone(io, `Configuration et prompts système laissés tels quels : ${homePath(configPath)} (--force pour les réinitialiser).`);
    } else {
      printDone(io, `Configuration créée : ${homePath(configPath)}`);
      printDone(io, `Prompts système par défaut : ${homePath(rolesDir)}`);
    }
    if (gitignore) {
      writeLine(
        io.stdout,
        `${colorize(activeGlyphs().status.done, "ok", io.stdout)} ` +
          (gitignore.added.length > 0
            ? `.gitignore complété : ${homePath(gitignore.path)} (+${gitignore.added.length} ligne${gitignore.added.length > 1 ? "s" : ""})`
            : `.gitignore déjà à jour : ${homePath(gitignore.path)}`),
      );
    }
    if (worktree) {
      // Annoncé plutôt que déposé en silence : ces chemins seront recopiés
      // dans chaque worktree et ces commandes y tourneront avant chaque
      // sous-agent. C'est une supposition sur le projet, et elle se corrige
      // dans le fichier.
      const parts = [
        worktree.copy.length > 0 ? `copie ${worktree.copy.join(", ")}` : "",
        worktree.setup.length > 0 ? `lance ${worktree.setup.join(" ; ")}` : "",
      ].filter(Boolean);
      printDone(io, `Atelier des sous-agents ([worktree]) : ${parts.join(" puis ")}`);
    }
    if (assets) printAssetsOutcome(io, assets);
    for (const warning of warnings) printWarning(io, warning);
  }
  return EXIT_OK;
}

export async function runInit(root: string, options: InitOptions, io: Io): Promise<number> {
  // Validé une seule fois, avant toute écriture et avant le choix
  // projet/global : un `--agent` inconnu est une erreur d'usage pure,
  // indépendante de l'état du projet ou de la portée visée.
  if (options.agent && options.agent.length > 0) {
    const invalid = options.agent.filter((id) => !isMcpClient(id));
    if (invalid.length > 0) {
      printError(
        io,
        `Agent(s) inconnu(s) pour --agent : ${invalid.map((id) => `"${id}"`).join(", ")} (attendu l'un de : ${MCP_CLIENTS.join(", ")}).`,
      );
      return EXIT_USAGE;
    }
  }
  return options.global ? runInitGlobal(root, options, io) : runInitProject(root, options, io);
}
