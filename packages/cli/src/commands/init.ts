/**
 * `orch init` : crée `<root>/.orch/config.toml` à partir de `defaultConfig()`
 * et un prompt système par défaut pour chaque rôle livré. N'écrase jamais une
 * configuration existante sans `--force`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfig, loadConfig, projectConfigPath, repoRoot, saveProjectConfig } from "@orch/core";
import type { Io } from "../output.js";
import { EXIT_OK, EXIT_USAGE, printError, printJson, printWarning, writeLine } from "../output.js";

export interface InitOptions {
  force?: boolean;
  json?: boolean;
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

export async function runInit(root: string, options: InitOptions, io: Io): Promise<number> {
  const loaded = await loadConfig(root);
  if (loaded.sources.project && !options.force) {
    printError(io, `Configuration déjà présente : ${loaded.sources.project} (utilisez --force pour l'écraser).`);
    return EXIT_USAGE;
  }

  const config = defaultConfig();
  const rolesDir = join(root, ".orch", "roles");
  await mkdir(rolesDir, { recursive: true });

  const roleFiles: string[] = [];
  config.roles = config.roles.map((role) => ({ ...role, system_prompt_file: `roles/${role.name}.md` }));
  for (const role of config.roles) {
    const absPath = join(root, ".orch", role.system_prompt_file!);
    await writeFile(absPath, defaultRolePrompt(role.name) + "\n", "utf8");
    roleFiles.push(absPath);
  }

  await saveProjectConfig(root, config);

  const warnings: string[] = [];
  if (!(await repoRoot(root))) {
    warnings.push(
      `"${root}" n'est pas un dépôt git : l'isolation "worktree" n'est pas disponible ici, l'orchestrateur repliera sur "inplace" pour les tâches en écriture. Lancez "git init" dans ce répertoire pour l'activer.`,
    );
  }

  const configPath = projectConfigPath(root);
  if (options.json) {
    printJson(io, { root, config_path: configPath, roles_dir: rolesDir, role_files: roleFiles, warnings });
  } else {
    writeLine(io.stdout, `Configuration créée : ${configPath}`);
    writeLine(io.stdout, `Prompts système par défaut : ${rolesDir}`);
    for (const warning of warnings) printWarning(io, warning);
  }
  return EXIT_OK;
}
