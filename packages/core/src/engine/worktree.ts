/**
 * Isolation git : chaque tâche isolée s'exécute dans un worktree jetable, sur
 * une branche dédiée, jamais commitée par le moteur. C'est ce qui rend la
 * règle d'isolation `"auto"` du runner constatable plutôt que déclarative :
 * un agent qui écrit malgré une consigne de lecture seule laisse une trace
 * que `git diff` révèle, contenue hors du dépôt principal.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Change } from "@orch/protocol";

const execFileAsync = promisify(execFile);

/** Racine du dépôt git contenant `dir`, ou `null` si `dir` n'est pas dans un dépôt git. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseRef: string;
}

/**
 * Crée un worktree jetable sous `<root>/.orch/wt/<taskId>`, sur une nouvelle
 * branche `orch/<taskId>` partant de `baseRef` (par défaut `HEAD`).
 *
 * `root` doit être la racine du dépôt (typiquement le résultat de
 * `repoRoot(workspace)`) : les commandes git s'y exécutent, et c'est là que
 * vit le répertoire administratif `.orch/wt`.
 */
export async function createWorktree(root: string, taskId: string, baseRef = "HEAD"): Promise<WorktreeHandle> {
  const branch = `orch/${taskId}`;
  const path = join(root, ".orch", "wt", taskId);
  await mkdir(join(root, ".orch", "wt"), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "-b", branch, path, baseRef], { cwd: root });
  return { path, branch, baseRef };
}

/** Supprime le worktree et sa branche. N'affecte ni l'historique ni les autres branches. */
export async function removeWorktree(root: string, handle: WorktreeHandle): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", handle.path, "--force"], { cwd: root });
  await execFileAsync("git", ["branch", "-D", handle.branch], { cwd: root });
}

export interface WorktreeDiff {
  files: Change[];
  patch: string;
  isEmpty: boolean;
}

/**
 * Diffe le worktree contre son point de départ (`HEAD`, c'est-à-dire
 * `baseRef` au moment de la création).
 *
 * Les agents ne committent pas : un `git diff` nu ne verrait donc jamais les
 * fichiers créés, invisibles pour git tant qu'ils ne sont ni indexés ni
 * commités. `add -A --intent-to-add` enregistre leur existence sans indexer
 * leur contenu, ce qui suffit à les faire apparaître dans `git diff HEAD`.
 * C'est acceptable ici précisément parce que le worktree est jetable : on ne
 * pollue l'index d'aucun dépôt qui compte.
 */
export async function diffWorktree(handle: WorktreeHandle): Promise<WorktreeDiff> {
  await execFileAsync("git", ["-C", handle.path, "add", "-A", "--intent-to-add"]);
  const [{ stdout: nameStatus }, { stdout: patch }] = await Promise.all([
    execFileAsync("git", ["-C", handle.path, "diff", "--name-status", "HEAD"]),
    execFileAsync("git", ["-C", handle.path, "diff", "HEAD"]),
  ]);
  const files = parseNameStatus(nameStatus);
  return { files, patch, isEmpty: files.length === 0 };
}

/**
 * Applique le patch du worktree au dépôt principal par `git apply --3way`,
 * sans toucher aux branches ni à l'historique : réversible, sans effet de
 * bord sur l'historique de l'utilisateur. N'appelle jamais `git commit`.
 *
 * En cas d'échec (conflit), renvoie la liste des fichiers en conflit plutôt
 * que de lever — cette liste vient de `git diff --diff-filter=U`, donc de
 * l'état réel de l'index après la tentative, pas d'un décodage fragile des
 * messages humains de `git apply`.
 */
export async function applyWorktree(root: string, handle: WorktreeHandle): Promise<{ applied: boolean; conflicts: string[] }> {
  const diff = await diffWorktree(handle);
  if (diff.isEmpty) {
    return { applied: true, conflicts: [] };
  }

  const scratchDir = await mkdtemp(join(tmpdir(), "orch-patch-"));
  const patchFile = join(scratchDir, "worktree.patch");
  try {
    await writeFile(patchFile, diff.patch, "utf8");
    try {
      await execFileAsync("git", ["apply", "--3way", patchFile], { cwd: root });
      return { applied: true, conflicts: [] };
    } catch {
      const { stdout } = await execFileAsync("git", ["-C", root, "diff", "--name-only", "--diff-filter=U"]);
      const conflicts = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      return { applied: false, conflicts };
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** Traduit `git diff --name-status` vers le vocabulaire commun `Change`. */
function parseNameStatus(raw: string): Change[] {
  const changes: Change[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split("\t");
    if (!code) continue;

    if (code.startsWith("R")) {
      const [oldPath, newPath] = rest;
      if (newPath) {
        changes.push({ path: newPath, action: "renamed", summary: oldPath ? `renommé depuis ${oldPath}` : "" });
      }
      continue;
    }

    const path = rest[0];
    if (!path) continue;
    const action = code === "A" ? "created" : code === "M" ? "modified" : code === "D" ? "deleted" : undefined;
    if (action) changes.push({ path, action, summary: "" });
  }
  return changes;
}
