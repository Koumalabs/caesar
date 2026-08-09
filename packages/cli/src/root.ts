/**
 * Résolution de la racine de projet : depuis le répertoire courant, en
 * remontant jusqu'au premier répertoire contenant `.orch/` ou `.git/`
 * (voir les conventions du brief). L'option globale `--root <dir>` la
 * force explicitement.
 */
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `explicit`, s'il est fourni, l'emporte toujours (résolu contre `startDir`).
 * Sinon, remonte depuis `startDir` à la recherche de `.orch/` ou `.git/`.
 * Si aucun des deux n'est trouvé avant la racine du système de fichiers,
 * replie sur `startDir` lui-même — c'est le cas d'un `orch init` sur un
 * répertoire tout neuf, qui doit pouvoir s'exécuter sans configuration
 * préalable.
 */
export async function resolveRoot(explicit: string | undefined, startDir: string = process.cwd()): Promise<string> {
  if (explicit) return resolve(startDir, explicit);

  let dir = resolve(startDir);
  for (;;) {
    if ((await exists(join(dir, ".orch"))) || (await exists(join(dir, ".git")))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
