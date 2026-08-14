/**
 * Lecture et écriture du prompt système d'un rôle — le seul fichier non-TOML
 * que le TUI touche, et le seul qu'il écrit **hors** du modèle de
 * modifications en attente.
 *
 * Cette exception est délibérée et doit rester visible à l'écran (voir
 * `PromptEditor`) : `system_prompt_file` est un *chemin* dans la
 * configuration — donc soumis aux trois couches et à "s" comme le reste —,
 * mais le contenu qu'il désigne est un fichier Markdown unique, partagé par
 * toutes les couches qui le nomment. Le mettre en attente au même titre
 * qu'un réglage laisserait croire qu'il suit la portée d'édition, ce qui est
 * faux : il n'y en a qu'un.
 *
 * Le chemin vient de `rolePromptPath` (`@caesar/core`), la fonction qu'utilise
 * `resolveRole` pour *lire* ce même prompt au lancement d'une tâche : ce qu'on
 * édite ici est exactement ce que l'agent recevra.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rolePromptPath } from "@caesar/core";

export interface PromptFile {
  /** Chemin absolu réellement lu par le moteur — affiché tel quel, sans quoi on édite à l'aveugle. */
  path: string;
  content: string;
  /** Faux quand le fichier n'existe pas encore : l'éditeur le dit plutôt que de montrer un vide ambigu. */
  exists: boolean;
}

/** Le chemin conventionnel d'un rôle, celui que `caesar init` écrit déjà (`packages/cli/src/commands/init.ts`). */
export function defaultPromptFileFor(roleName: string): string {
  return `roles/${roleName}.md`;
}

/**
 * Refuse les chemins que `rolePromptPath` ne saurait pas honorer, en
 * nommant la raison. Les deux cas échouent en silence sinon :
 *
 *  - un chemin absolu passé à `join(root, ".caesar", "/etc/x")` devient
 *    `<root>/.caesar/etc/x` — on croit désigner un fichier du système, on en
 *    crée un autre, et le prompt lu n'est jamais celui qu'on a écrit ;
 *  - un `..` sort du répertoire de configuration, voire du projet, et écrit
 *    hors de ce que l'utilisateur croit modifier.
 */
export function validatePromptFile(file: string): string | null {
  const value = file.trim();
  if (value.length === 0) return "Le chemin du prompt ne peut pas être vide.";
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
    return `Chemin absolu refusé : "${value}". Le prompt est cherché sous "<projet>/.caesar/" ; donnez un chemin relatif, par exemple "roles/${"<rôle>"}.md".`;
  }
  if (value.split(/[\\/]/).includes("..")) {
    return `Chemin refusé : "${value}". Un ".." sortirait de "<projet>/.caesar/", où le moteur va chercher le prompt.`;
  }
  return null;
}

/** Lit le prompt d'un rôle. Un fichier absent n'est pas une erreur : c'est le cas normal d'un rôle dont le prompt reste à écrire. */
export async function readPromptFile(root: string, systemPromptFile: string): Promise<PromptFile> {
  const path = rolePromptPath(root, systemPromptFile);
  try {
    return { path, content: await readFile(path, "utf8"), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: "", exists: false };
    throw new Error(`Impossible de lire ${path} : ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Écrit le prompt et rend le chemin écrit. Création des répertoires
 * intermédiaires comprise (un rôle nouvellement créé n'a pas encore de
 * `roles/`), et écriture atomique — fichier temporaire puis `rename`, le même
 * motif que `saveLayer` : une interruption en cours d'écriture laisserait
 * sinon un prompt tronqué, que le moteur transmettrait tel quel à l'agent.
 */
export async function writePromptFile(root: string, systemPromptFile: string, content: string): Promise<string> {
  const path = rolePromptPath(root, systemPromptFile);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.prompt.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return path;
}
