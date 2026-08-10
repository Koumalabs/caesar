/**
 * Inventaire et nettoyage des worktrees jetables laissés par les tâches.
 *
 * Toute la décision vit ici, et non dans le CLI : les autres façades peuvent
 * ainsi présenter exactement les mêmes suppressions et conservations. Une
 * tâche active est protégée avant même l'inspection Git ; une tâche terminée
 * n'est supprimée que si son worktree est propre, sauf demande explicite avec
 * `force`. Les répertoires sous `.orch/wt` qui ne correspondent à aucun
 * enregistrement worktree encore présent sont traités comme orphelins.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskRecord, TaskStatus } from "../store.js";
import { fileTaskStore } from "../store.js";
import { removeWorktree } from "./worktree.js";
import type { WorktreeHandle } from "./worktree.js";

const execFileAsync = promisify(execFile);
const WORKTREES_IN_USE_DIR = join(".orch", "state", "worktrees-in-use");

export type WorktreeGcAction = "removed" | "would_remove" | "kept";
export type WorktreeGcReason = "clean" | "modified" | "active" | "inspection_failed";

export interface WorktreeGcEntry {
  id: string;
  path: string;
  branch: string;
  orphan: boolean;
  status?: TaskStatus;
  action: WorktreeGcAction;
  reason: WorktreeGcReason;
  error?: string;
}

export interface WorktreeGcOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface WorktreeGcResult {
  dryRun: boolean;
  force: boolean;
  entries: WorktreeGcEntry[];
  removed: number;
  wouldRemove: number;
  kept: number;
}

interface Candidate {
  id: string;
  handle: WorktreeHandle;
  orphan: boolean;
  status?: TaskStatus;
}

function inUseDirectory(root: string, id: string): string {
  // L'identifiant est fourni par l'appelant avant que le store ait pu le
  // valider. Son empreinte, de taille fixe et sans séparateur, ne peut jamais
  // s'échapper du répertoire des marqueurs.
  const safeName = createHash("sha256").update(id).digest("hex");
  return join(root, WORKTREES_IN_USE_DIR, `${safeName}.lock`);
}

function inUseFile(root: string, id: string): string {
  return join(inUseDirectory(root, id), "marker.json");
}

interface WorktreeInUseMarker {
  pid: number;
  token: string;
}

export interface WorktreeInUseLease {
  id: string;
  token: string;
  directory: string;
  path: string;
}

type MarkerInspection =
  | { state: "absent" }
  | { state: "active"; marker: WorktreeInUseMarker; directory: string; path: string }
  | { state: "stale"; marker: WorktreeInUseMarker; directory: string; path: string }
  | { state: "unknown"; error: string };

/**
 * Marque un identifiant avant que son worktree soit exposé sur le disque.
 * Le runner conserve ce marqueur jusqu'à sa terminaison afin qu'un GC
 * concurrent ne confonde jamais la fenêtre pré-store avec un orphelin.
 */
export async function markWorktreeInUse(root: string, id: string): Promise<WorktreeInUseLease> {
  const dir = join(root, WORKTREES_IN_USE_DIR);
  await mkdir(dir, { recursive: true });
  const directory = inUseDirectory(root, id);
  const path = inUseFile(root, id);

  for (;;) {
    const token = randomUUID();
    const marker: WorktreeInUseMarker = { pid: process.pid, token };
    try {
      // Le répertoire joue le rôle de verrou exclusif. Il reste occupé
      // jusqu'à la libération du propriétaire et ne peut pas être remplacé
      // entre la vérification du jeton et sa suppression.
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspection = await inspectWorktreeMarker(root, id);
      if (inspection.state === "active") {
        throw new Error(`Tâche "${id}" déjà en cours de préparation ou d'exécution.`);
      }
      if (inspection.state === "unknown") {
        throw new Error(`Impossible de vérifier le marqueur de la tâche "${id}" : ${inspection.error}`);
      }
      if (inspection.state === "stale" && !(await purgeMarker(inspection))) {
        throw new Error(`Impossible de réclamer le marqueur périmé de la tâche "${id}" : une autre opération le nettoie.`);
      }
      // Marqueur absent ou périmé purgé : retente la prise exclusive.
      continue;
    }

    try {
      await writeFile(path, JSON.stringify(marker) + "\n", { encoding: "utf8", flag: "wx" });
      return { id, token, directory, path };
    } catch (error) {
      await unlink(path).catch(() => {});
      await rmdir(directory).catch(() => {});
      throw error;
    }
  }
}

/** Retire au mieux le marqueur, seulement si le jeton du propriétaire correspond encore. */
export async function clearWorktreeInUse(lease: WorktreeInUseLease): Promise<void> {
  try {
    await removeMarker(lease.directory, lease.path, lease.token);
  } catch {
    // La libération ne doit jamais masquer l'issue de la tâche.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM signifie que le processus existe mais ne peut pas être signalé.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function inspectWorktreeMarker(root: string, id: string): Promise<MarkerInspection> {
  const directory = inUseDirectory(root, id);
  const path = inUseFile(root, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Le répertoire peut ne pas exister (absence normale) ou être présent
      // sans fichier (prise/libération interrompue) : seul le premier cas est
      // réellement absent.
      try {
        await access(directory);
        return { state: "unknown", error: "répertoire de marqueur incomplet" };
      } catch {
        return { state: "absent" };
      }
    }
    return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || !("token" in parsed)) {
    return { state: "unknown", error: "contenu de marqueur invalide" };
  }
  const { pid, token } = parsed as { pid?: unknown; token?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || token === "") {
    return { state: "unknown", error: "contenu de marqueur invalide" };
  }
  const marker = { pid, token };
  return processIsAlive(pid) ? { state: "active", marker, directory, path } : { state: "stale", marker, directory, path };
}

async function removeMarker(directory: string, path: string, token: string): Promise<boolean> {
  const cleanupLock = join(directory, "cleanup.lock");
  try {
    await mkdir(cleanupLock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  try {
    const current = JSON.parse(await readFile(path, "utf8")) as Partial<WorktreeInUseMarker>;
    if (current.token !== token) return false;
    await unlink(path);
    await rmdir(cleanupLock);
    await rmdir(directory);
    return true;
  } finally {
    // Encore présent seulement si la vérification ou la suppression a échoué.
    await rmdir(cleanupLock).catch(() => {});
  }
}

async function purgeMarker(inspection: Extract<MarkerInspection, { state: "stale" }>): Promise<boolean> {
  return removeMarker(inspection.directory, inspection.path, inspection.marker.token);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isActive(status: TaskStatus | undefined): boolean {
  return status === "pending" || status === "running";
}

/**
 * Inspecte l'index, les fichiers suivis et les fichiers non suivis sans
 * modifier l'index du worktree. `GIT_OPTIONAL_LOCKS=0` empêche notamment la
 * mise à jour opportuniste de son cache pendant cette lecture, ce qui garde
 * `--dry-run` sans écriture.
 */
async function worktreeHasChanges(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", path, "status", "--porcelain", "--untracked-files=normal"], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim().length > 0;
}

async function recordedCandidates(root: string): Promise<Candidate[]> {
  const records = await fileTaskStore(root).list();
  const candidates = await Promise.all(
    records
      .filter((record): record is TaskRecord & { isolation: "worktree" } => record.isolation === "worktree")
      .map(async (record): Promise<Candidate | null> => {
        if (!(await pathExists(record.workspace))) return null;
        return {
          id: record.id,
          handle: {
            path: record.workspace,
            branch: record.branch ?? `orch/${record.id}`,
            // Le nettoyage ne compare jamais à la base ; seule la forme du
            // handle partagé exige cette valeur.
            baseRef: "HEAD",
          },
          orphan: false,
          status: record.status,
        };
      }),
  );
  return candidates.filter((candidate): candidate is Candidate => candidate !== null);
}

async function orphanCandidates(root: string, recorded: Candidate[]): Promise<Candidate[]> {
  const worktreesDir = join(root, ".orch", "wt");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const recordedPaths = new Set(recorded.map((candidate) => resolve(candidate.handle.path)));
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry): Candidate => ({
      id: entry.name,
      handle: { path: join(worktreesDir, entry.name), branch: `orch/${entry.name}`, baseRef: "HEAD" },
      orphan: true,
    }))
    .filter((candidate) => !recordedPaths.has(resolve(candidate.handle.path)));
}

/**
 * Nettoie les worktrees admissibles et rend une entrée pour chaque worktree
 * encore présent au début de l'opération. Avec `dryRun`, la même décision est
 * calculée mais aucune suppression n'est effectuée.
 */
export async function garbageCollectWorktrees(root: string, options: WorktreeGcOptions = {}): Promise<WorktreeGcResult> {
  const recorded = await recordedCandidates(root);
  const orphans = await orphanCandidates(root, recorded);
  const candidates = [...recorded, ...orphans].sort((a, b) => a.id.localeCompare(b.id));
  const entries: WorktreeGcEntry[] = [];

  for (const candidate of candidates) {
    const common = {
      id: candidate.id,
      path: candidate.handle.path,
      branch: candidate.handle.branch,
      orphan: candidate.orphan,
      status: candidate.status,
    };

    // Relecture au dernier moment : le worktree peut être apparu après le
    // premier instantané du store. Le runner pose le marqueur avant sa
    // création et le garde jusqu'à la fin, fermant cette course sans délai
    // arbitraire ni supposition sur l'âge du répertoire.
    if (candidate.orphan) {
      const marker = await inspectWorktreeMarker(root, candidate.id);
      if (marker.state === "active") {
        entries.push({ ...common, action: "kept", reason: "active" });
        continue;
      }
      if (marker.state === "unknown") {
        entries.push({ ...common, action: "kept", reason: "inspection_failed", error: marker.error });
        continue;
      }
      if (marker.state === "stale" && !options.dryRun && !(await purgeMarker(marker))) {
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: "une autre opération nettoie le marqueur périmé",
        });
        continue;
      }
    }

    if (isActive(candidate.status)) {
      entries.push({ ...common, action: "kept", reason: "active" });
      continue;
    }

    let modified: boolean;
    try {
      modified = await worktreeHasChanges(candidate.handle.path);
    } catch (error) {
      entries.push({
        ...common,
        action: "kept",
        reason: "inspection_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (modified && !options.force) {
      entries.push({ ...common, action: "kept", reason: "modified" });
      continue;
    }

    const action: WorktreeGcAction = options.dryRun ? "would_remove" : "removed";
    if (!options.dryRun) await removeWorktree(root, candidate.handle);
    entries.push({ ...common, action, reason: modified ? "modified" : "clean" });
  }

  return {
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    entries,
    removed: entries.filter((entry) => entry.action === "removed").length,
    wouldRemove: entries.filter((entry) => entry.action === "would_remove").length,
    kept: entries.filter((entry) => entry.action === "kept").length,
  };
}
