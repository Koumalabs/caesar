/**
 * Project root resolution: from the current directory, walking up to the
 * first directory containing `.caesar/` or `.git/` (see the brief's
 * conventions). The global option `--root <dir>` forces it explicitly.
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
 * `explicit`, when provided, always wins (resolved against `startDir`).
 * Otherwise, walks up from `startDir` looking for `.caesar/` or `.git/`.
 * If neither is found before the filesystem root, falls back to `startDir`
 * itself — that is the case of a `caesar init` on a brand-new directory,
 * which must be able to run without prior configuration.
 */
export async function resolveRoot(explicit: string | undefined, startDir: string = process.cwd()): Promise<string> {
  if (explicit) return resolve(startDir, explicit);

  let dir = resolve(startDir);
  for (;;) {
    if ((await exists(join(dir, ".caesar"))) || (await exists(join(dir, ".git")))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}
