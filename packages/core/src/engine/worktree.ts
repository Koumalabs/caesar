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
import { readTask, taskPaths } from "@orch/protocol";
import type { TaskRecord } from "../store.js";

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

/**
 * Vrai si le dépôt porte au moins un commit.
 *
 * Un dépôt fraîchement initialisé n'en porte aucun : sa branche n'est pas née et
 * `HEAD` ne désigne rien. `git worktree add … HEAD` y échoue alors sur un
 * `fatal: invalid reference: HEAD` que rien ne rattache à sa cause. Le cas se
 * distingue de « ce n'est pas un dépôt git » — `repoRoot` réussit — et appelle
 * un autre remède : un premier commit.
 */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo });
    return true;
  } catch {
    return false;
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

/**
 * Capture l'état git du workspace réel (`git status --porcelain`), pour le
 * comparer avant/après une exécution en isolation `"inplace"` — voir C2/C3
 * de la revue finale : `git diff` ne faisait foi qu'en isolation `worktree`,
 * jamais `inplace`, où aucun recoupement n'avait lieu et où une écriture par
 * un agent en lecture seule n'était ni contenue, ni détectée.
 *
 * Le répertoire administratif `.orch/` (tâches, état, worktrees) est exclu
 * du pathspec : contrairement au worktree jetable — dont l'arborescence ne
 * contient structurellement jamais `.orch/tasks/<id>` (racine distincte,
 * `deps.root` plutôt que `workspace`) — le workspace réel EST `deps.root`
 * pour une tâche `inplace`, et `.orch/tasks/<id>` y est donc physiquement
 * créé par l'orchestrateur lui-même pendant l'exécution. Sans cette
 * exclusion, la simple existence du répertoire de tâche ferait croire à une
 * écriture de l'agent sur toute tâche `inplace`, quel que soit son
 * comportement réel — un faux positif systématique bien pire que le faux
 * négatif, rare, d'un agent qui modifierait `.orch/config.toml` lui-même
 * (alors masqué par cette même exclusion, tout `.orch/` étant écarté en bloc
 * : `git status` réduit un répertoire entièrement non suivi à une seule
 * ligne `?? .orch/`, qui rend inopérant tout pathspec d'exclusion plus fin
 * que `.orch` entier — vérifié empiriquement).
 *
 * Jamais de `git add` ici, à la différence de `diffWorktree` : le workspace
 * n'est pas jetable, et modifier l'index réel de l'utilisateur pour une
 * simple observation serait un effet de bord que l'isolation `"inplace"` ne
 * promet pas. `null` si `workspace` n'est pas un dépôt git (ou toute autre
 * erreur) : jamais une exception, cette capture est un filet, pas une
 * exigence.
 */
export async function captureWorkspaceStatus(workspace: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "status", "--porcelain", "--", ".", ":(exclude).orch"]);
    return stdout;
  } catch {
    return null;
  }
}

/** `git status --porcelain` d'un chemin vers son code à deux lettres (`XY`, voir `git help status`). */
function parsePorcelainStatus(status: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    // "R  ancien -> nouveau" pour un renommage : seul le chemin final nous intéresse ici.
    const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
    map.set(path.trim(), code);
  }
  return map;
}

function porcelainCodeToAction(code: string): Change["action"] | undefined {
  const x = code[0];
  const y = code[1];
  if (x === "?" || x === "A" || y === "A") return "created";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "M" || y === "M" || x === "U" || y === "U") return "modified";
  return undefined;
}

/**
 * Diffe deux instantanés `git status --porcelain` du même workspace, avant
 * et après une exécution. Contrairement à `diffWorktree`, ne rend jamais de
 * patch (`patch: ""`) : sans `git add`, seule la liste des chemins touchés
 * est fiable à reconstituer depuis `git status`, pas le contenu du diff.
 */
export async function diffWorkspaceStatus(workspace: string, before: string): Promise<WorktreeDiff> {
  const after = await captureWorkspaceStatus(workspace);
  if (after === null) return { files: [], patch: "", isEmpty: true };

  const beforeMap = parsePorcelainStatus(before);
  const afterMap = parsePorcelainStatus(after);
  const files: Change[] = [];
  for (const [path, code] of afterMap) {
    if (beforeMap.get(path) === code) continue;
    const action = porcelainCodeToAction(code);
    if (action) files.push({ path, action, summary: "" });
  }
  return { files, patch: "", isEmpty: files.length === 0 };
}

/**
 * Reconstruit le `WorktreeHandle` d'une tâche à partir de son enregistrement
 * (`TaskRecord`) — `null` si la tâche n'a pas tourné en isolation worktree.
 * Partagé par `orch diff`/`orch apply` (CLI) et `orch_diff`/`orch_apply`
 * (serveur MCP), qui en avaient chacun leur propre copie avant la revue de
 * la tâche 7 : voir son rapport de correction.
 */
export async function loadWorktreeHandle(record: TaskRecord): Promise<WorktreeHandle | null> {
  if (record.isolation !== "worktree" || !record.branch) return null;
  const task = await readTask(taskPaths(record.task_dir));
  return { path: record.workspace, branch: record.branch, baseRef: task.base_ref ?? "HEAD" };
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
