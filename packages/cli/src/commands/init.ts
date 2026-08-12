/**
 * `orch init [--global]` : crée la couche projet (par défaut) ou la couche
 * globale (`--global`). N'écrase jamais une configuration existante sans
 * `--force`.
 *
 * La couche **projet** ne déclare rien : `defaultConfig()` porte déjà la
 * politique et les rôles par défaut (`system_prompt_file` compris, une
 * convention de nom résolue par `resolveRole` indépendamment de toute
 * couche — voir `config.ts`) — écrire ces valeurs dans `.orch/config.toml`
 * les y figerait, masquant toute configuration globale ultérieure (le
 * défaut I11 de la revue finale). Le rôle de cette commande, côté projet,
 * se limite donc à matérialiser les *fichiers* de prompt système
 * (`.orch/roles/<name>.md`) et à compléter le `.gitignore`.
 *
 * La couche **globale** (`--global`), à l'inverse, écrit `defaultConfig()`
 * intégralement : c'est le point de départ éditable d'un "preset" partagé
 * par tous les projets d'un même poste — voir le plan de la tâche 13.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configPathFor,
  defaultConfig,
  detectUntrackedNeeds,
  isEnoent,
  loadConfig,
  projectConfigPath,
  repoRoot,
  saveLayer,
  writeFileAtomic,
} from "@orch/core";
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
  printWarning,
  writeLine,
} from "../output.js";

export interface InitOptions {
  force?: boolean;
  json?: boolean;
  global?: boolean;
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
const GITIGNORE_ENTRIES = [".orch/config.local.toml", ".orch/tasks/", ".orch/wt/", ".orch/state/"];

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
 * Écriture atomique (`writeFileAtomic`, `@orch/core`) — même motif que
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

async function runInitGlobal(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  if (loaded.sources.global && !options.force) {
    printError(io, `Configuration globale déjà présente : ${loaded.sources.global} (utilisez --force pour l'écraser).`);
    return EXIT_USAGE;
  }

  await saveLayer("global", root, defaultConfig());

  const configPath = configPathFor("global", root);
  if (options.json) {
    printJson(io, { scope: "global", config_path: configPath });
  } else {
    printDone(io, `Configuration globale créée : ${homePath(configPath)}`);
  }
  return EXIT_OK;
}

async function runInitProject(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  if (loaded.sources.project && !options.force) {
    printError(io, `Configuration déjà présente : ${loaded.sources.project} (utilisez --force pour l'écraser).`);
    return EXIT_USAGE;
  }

  const rolesDir = join(root, ".orch", "roles");
  await mkdir(rolesDir, { recursive: true });

  // Les rôles par défaut portent déjà leur `system_prompt_file` (voir
  // `defaultConfig()`) : il ne reste qu'à matérialiser le fichier lui-même,
  // pas à déclarer le rôle dans la couche projet — voir l'en-tête de ce
  // module.
  const roleFiles: string[] = [];
  for (const role of defaultConfig().roles) {
    if (!role.system_prompt_file) continue;
    const absPath = join(root, ".orch", role.system_prompt_file);
    await writeFile(absPath, defaultRolePrompt(role.name) + "\n", "utf8");
    roleFiles.push(absPath);
  }

  // La couche projet ne déclare rien de plus qu'elle-même à l'initialisation
  // : écrire ici la politique et les rôles par défaut referait exactement le
  // défaut I11 que cette tâche corrige (la couche figerait les valeurs par
  // défaut, masquant toute configuration globale). Ce fichier vide marque
  // simplement l'initialisation du projet (garde-fou --force ci-dessus).
  //
  // `[worktree]` fait exception, et pour une raison précise : ce n'est pas une
  // valeur par défaut mais un **fait de ce projet-ci** — ce que son worktree
  // doit emporter pour qu'on puisse y travailler. Sans cette section, un
  // worktree ne contient que les fichiers suivis, l'isolation devient
  // inexploitable, et la contourner par `isolation = "inplace"` reste la seule
  // issue praticable : le défaut d'origine. Rien n'est écrit quand rien n'est
  // détecté — une section vide ferait croire à un réglage.
  const worktree = await detectUntrackedNeeds(root);
  await saveLayer("project", root, worktree ? { worktree } : {});

  const warnings: string[] = [];
  const isGitRepo = (await repoRoot(root)) !== null;
  if (!isGitRepo) {
    warnings.push(
      `"${root}" n'est pas un dépôt git : l'isolation "worktree" n'est pas disponible ici, l'orchestrateur repliera sur "inplace" pour les tâches en écriture, et le ".gitignore" n'a pas été complété. Lancez "git init" dans ce répertoire pour activer les deux.`,
    );
  }
  const gitignore = await completeGitignore(root, isGitRepo);

  const configPath = projectConfigPath(root);
  if (options.json) {
    printJson(io, {
      root,
      config_path: configPath,
      roles_dir: rolesDir,
      role_files: roleFiles,
      gitignore: gitignore ? { path: gitignore.path, added: gitignore.added } : null,
      worktree: worktree ?? null,
      warnings,
    });
  } else {
    // Le logotype ouvre `orch init` et rien d'autre : c'est la seule commande
    // qu'on tape une fois, sans savoir encore ce que l'outil est. Ailleurs, il
    // serait du bruit à chaque invocation.
    for (const line of bannerLines(io.stdout, `orchestrateur de sous-agents · v${VERSION}`)) writeLine(io.stdout, line);
    writeLine(io.stdout);
    printDone(io, `Configuration créée : ${homePath(configPath)}`);
    printDone(io, `Prompts système par défaut : ${homePath(rolesDir)}`);
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
    for (const warning of warnings) printWarning(io, warning);
  }
  return EXIT_OK;
}

export async function runInit(root: string, options: InitOptions, io: Io): Promise<number> {
  return options.global ? runInitGlobal(root, options, io) : runInitProject(root, options, io);
}
