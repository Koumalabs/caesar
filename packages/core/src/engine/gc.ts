/**
 * Inventaire et nettoyage de ce que les tâches laissent derrière elles :
 * leurs worktrees jetables, et leurs enregistrements restés « en cours »
 * alors que plus personne ne les conduit.
 *
 * Toute la décision vit ici, et non dans le CLI : les autres façades peuvent
 * ainsi présenter exactement les mêmes suppressions et conservations. Une
 * tâche active est protégée avant même l'inspection Git ; une tâche terminée
 * n'est supprimée que si son worktree est propre ou si son patch a été
 * appliqué et n'a pas bougé depuis (`applied_at` + empreinte, posés par
 * `applyRecordedWorktree`), sauf demande explicite avec `force`. Les
 * répertoires sous `.orch/wt` qui ne correspondent à aucun enregistrement
 * worktree encore présent sont traités comme orphelins.
 *
 * Les deux nettoyages sont dans le même fichier parce que le premier
 * conditionne le second : un enregistrement bloqué « running » protège son
 * worktree indéfiniment (`kept: active`), et le processus qui aurait dû le
 * conclure n'existe plus pour lever cette protection.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative as relative_, resolve } from "node:path";
import { promisify } from "node:util";
import { REPORT_PROTOCOL, ReportSchema, readReport, taskPaths, writeReport } from "@orch/protocol";
import type { TaskRecord, TaskStatus, TaskStore } from "../store.js";
import { fileTaskStore } from "../store.js";
import { acquireLease, inspectLease, purgeLease, releaseLease } from "./lock.js";
import type { Lease, LeaseInspection } from "./lock.js";
import { diffWorktree, listGitWorktrees, loadWorktreeHandle, patchDigest, removeWorktree, repoRoot } from "./worktree.js";
import type { WorktreeHandle } from "./worktree.js";

const execFileAsync = promisify(execFile);
const WORKTREES_IN_USE_DIR = join(".orch", "state", "worktrees-in-use");

export type WorktreeGcAction = "removed" | "would_remove" | "kept";
export type WorktreeGcReason = "clean" | "modified" | "applied" | "active" | "inspection_failed";

export interface WorktreeGcEntry {
  id: string;
  path: string;
  branch: string;
  orphan: boolean;
  status?: TaskStatus;
  /**
   * L'instant de la dernière application (`orch apply`) porté par
   * l'enregistrement, restitué tel quel : c'est lui qui distingue, parmi les
   * conservés `modified`, ceux qui ont été appliqués puis retouchés.
   */
  applied_at?: string;
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
  /**
   * Les tâches conclues d'office parce que le processus qui les conduisait
   * avait disparu — voir `sweepAbandonedTasks`. En `dryRun`, celles qui
   * l'auraient été : rien n'est écrit, mais leurs worktrees sont décomptés
   * comme collectables, sans quoi l'aperçu annoncerait une conservation que
   * le passage réel ne ferait pas.
   */
  abandoned: AbandonedTask[];
}

interface Candidate {
  id: string;
  handle: WorktreeHandle;
  orphan: boolean;
  status?: TaskStatus;
  /** Absent pour un orphelin : aucun enregistrement du store ne le réclame. */
  record?: TaskRecord;
}

/**
 * Le bail que le runner pose sur l'identifiant d'une tâche, avant même que son
 * worktree existe sur le disque.
 *
 * Reste un type propre à ce module plutôt qu'un alias de `Lease` : les
 * appelants raisonnent en identifiants de tâche, pas en clés de verrou.
 */
export interface WorktreeInUseLease extends Lease {
  id: string;
}

/**
 * Marque un identifiant avant que son worktree soit exposé sur le disque.
 * Le runner conserve ce marqueur jusqu'à sa terminaison afin qu'un GC
 * concurrent ne confonde jamais la fenêtre pré-store avec un orphelin.
 *
 * Le mécanisme lui-même vit désormais dans `lock.ts`, d'où un second usage l'a
 * tiré (l'exclusivité d'écriture sur un workspace). Le contrat de cette
 * fonction est inchangé, motif de refus compris.
 */
export async function markWorktreeInUse(root: string, id: string): Promise<WorktreeInUseLease> {
  const lease = await acquireLease(join(root, WORKTREES_IN_USE_DIR), id, {
    describeHolder: () => `Tâche "${id}" déjà en cours de préparation ou d'exécution.`,
  });
  return { ...lease, id };
}

/** Retire au mieux le marqueur, seulement si le jeton du propriétaire correspond encore. */
export async function clearWorktreeInUse(lease: WorktreeInUseLease): Promise<void> {
  await releaseLease(lease);
}

function inspectWorktreeMarker(root: string, id: string): Promise<LeaseInspection> {
  return inspectLease(join(root, WORKTREES_IN_USE_DIR), id);
}

// ---------------------------------------------------------------------------
// Tâches abandonnées
// ---------------------------------------------------------------------------

/** Une tâche que le store dit encore active, alors que le processus qui la conduisait n'existe plus. */
export interface AbandonedTask {
  id: string;
  /** Le statut que le store portait encore : "running", ou "pending" si la tâche est morte avant son lancement. */
  status: TaskStatus;
  /** Le processus orchestrateur disparu, tel que son marqueur le nommait. */
  pid: number;
}

/**
 * Les tâches dont l'orchestrateur est mort sans les conclure.
 *
 * Le statut d'une tâche est écrit par le processus qui la conduit, dans son
 * `finally` : tué (`kill -9`, fermeture de la session MCP qui l'hébergeait,
 * arrêt de la machine), il ne l'écrit jamais. L'enregistrement reste
 * « running » pour toujours — `orch ps` l'affiche indéfiniment en tête,
 * `orch watch` la suit sans fin, et son worktree, protégé comme celui d'une
 * tâche active, n'est plus jamais collecté. Rien, jusqu'ici, ne réconciliait
 * cet état ; les autres verrous du dépôt, eux, se réparent tous à la lecture
 * (`reclaimDead` dans `slots.ts`, `purgeLease` dans `lock.ts`).
 *
 * La preuve de la mort est le marqueur que `markWorktreeInUse` pose **avant**
 * l'enregistrement et ne retire qu'**après** le statut final : tant qu'une
 * tâche est réellement conduite, son marqueur nomme un processus vivant.
 * Un marqueur périmé (`stale` : le pid n'existe plus) est donc un fait daté
 * et positif, jamais une déduction.
 *
 * Un marqueur **absent** ne conclut rien, volontairement : l'absence n'est pas
 * une preuve de mort. Un enregistrement écrit par autre chose que le moteur —
 * une réparation à la main, un jeu d'essai — ne doit pas être déclaré mort
 * parce qu'il n'a jamais pris de marqueur. `orch cancel <id>` reste la sortie
 * manuelle : il marque déjà « annulée » une tâche dont le pid a disparu.
 */
export function detectAbandonedTasks(root: string, store: TaskStore = fileTaskStore(root)): Promise<AbandonedTask[]> {
  return collectAbandoned(root, store, false);
}

/**
 * Conclut les tâches abandonnées : marqueur repris, statut "failed",
 * `ended_at` posé, `pid` effacé.
 *
 * "failed" plutôt qu'un nouveau statut : l'issue est celle que le `finally` du
 * moteur écrit déjà lorsqu'il perd une tâche en route, et un septième statut
 * traverserait le protocole, le CLI, le TUI et les codes de sortie pour dire
 * la même chose. Le rapport, lui, dit ce qui s'est réellement passé — c'est
 * là que la nuance a un lecteur.
 *
 * Le marqueur est repris **avant** l'écriture du statut : sa reprise est
 * exclusive (`purgeLease`), elle sert donc de mutex entre deux balayages
 * simultanés. Celui qui perd la course ne conclut rien.
 */
export function sweepAbandonedTasks(root: string, store: TaskStore = fileTaskStore(root)): Promise<AbandonedTask[]> {
  return collectAbandoned(root, store, true);
}

/** Le constat, commun aux deux ; `commit` seul décide s'il est aussi inscrit. */
async function collectAbandoned(root: string, store: TaskStore, commit: boolean): Promise<AbandonedTask[]> {
  const records = await store.list({ status: ["pending", "running"] });
  const abandoned: AbandonedTask[] = [];
  for (const record of records) {
    const marker = await inspectWorktreeMarker(root, record.id);
    if (marker.state !== "stale") continue;
    if (commit) {
      if (!(await purgeLease(marker))) continue;
      await finalizeAbandoned(store, record, marker.marker.pid);
    }
    abandoned.push({ id: record.id, status: record.status, pid: marker.marker.pid });
  }
  return abandoned;
}

/**
 * Écrit le rapport d'une tâche abandonnée, puis son statut final.
 *
 * Le rapport déjà présent n'est **jamais** écrasé : un agent peut très bien
 * avoir déposé le sien juste avant que l'orchestrateur ne disparaisse, et
 * c'est alors le seul témoignage de ce qu'il a fait. Le statut du processus
 * reste "failed" pour autant : personne n'a vu son code de sortie, et le
 * recoupement avec git n'a jamais eu lieu — `report_status` porte l'autre
 * niveau, comme partout ailleurs.
 */
async function finalizeAbandoned(store: TaskStore, record: TaskRecord, pid: number): Promise<void> {
  const patch: Partial<TaskRecord> = { status: "failed", ended_at: new Date().toISOString(), pid: undefined };

  if (record.task_dir) {
    const paths = taskPaths(record.task_dir);
    const existing = await readReport(paths);
    if (existing) {
      patch.report_status = existing.status;
    } else {
      const report = ReportSchema.parse({
        protocol: REPORT_PROTOCOL,
        task_id: record.id,
        status: "failed",
        summary:
          `Tâche interrompue avant son terme : le processus orchestrateur (pid ${pid}) a disparu sans la conclure. ` +
          `Ce que l'agent avait fait avant cette disparition n'a jamais été recoupé avec git.`,
      });
      await writeReport(paths, report);
      patch.report_status = report.status;
    }
  }

  await store.update(record.id, patch);
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
          record,
        };
      }),
  );
  return candidates.filter((candidate): candidate is Candidate => candidate !== null);
}

/**
 * Les worktrees d'orch qu'aucun enregistrement du store ne réclame.
 *
 * Deux sources, réunies, chacune couvrant l'angle mort de l'autre :
 *
 * - **`git worktree list --porcelain`**, la vérité sur ce que git tient pour
 *   un worktree, et la seule à donner la branche réellement associée. Le GC la
 *   déduisait du nom de répertoire (`orch/<dirname>`) : une coïncidence de
 *   construction, qui laisserait des branches derrière elle dès que les deux
 *   cesseraient d'être fabriqués ensemble. Elle rapporte aussi les worktrees
 *   dont l'arborescence a été effacée à la main, que le balayage de répertoire
 *   ne peut par construction pas voir.
 * - **le balayage de `.orch/wt/`**, pour les résidus que git ne connaît pas :
 *   un répertoire laissé par une création interrompue avant que git ne
 *   l'enregistre. `removeWorktree` échouera dessus, et l'entrée dira
 *   `inspection_failed` plutôt que de laisser le répertoire invisible.
 *
 * Le dépôt est cherché **depuis `root`**, et les worktrees sont reconnus à
 * leur emplacement sous `<dépôt>/.orch/wt/`, jamais sous `<root>/.orch/wt/` :
 * `createWorktree` les crée sous la racine *git*, alors que `root` est la
 * racine *orch* — `resolveRoot` (CLI) s'arrête au premier `.orch/` **ou**
 * `.git/`. Quand `.orch/` vit dans un sous-répertoire d'un dépôt, les deux
 * divergent, et le GC cherchait jusqu'ici là où rien n'est jamais créé : les
 * orphelins y étaient purement invisibles.
 */
async function orphanCandidates(root: string, recorded: Candidate[]): Promise<Candidate[]> {
  const repo = (await repoRoot(root)) ?? root;
  const worktreesDir = join(repo, ".orch", "wt");
  const byPath = new Map<string, Candidate>();

  const canonicalWorktreesDir = await canonical(worktreesDir);
  for (const entry of await listGitWorktrees(repo)) {
    if (!isUnderDir(entry.path, canonicalWorktreesDir)) continue;
    const id = basename(entry.path);
    byPath.set(await canonical(entry.path), {
      id,
      handle: {
        path: entry.path,
        branch: entry.branch ?? `orch/${id}`,
        // Le nettoyage ne compare jamais à la base ; seule la forme du handle
        // partagé exige cette valeur.
        baseRef: "HEAD",
      },
      orphan: true,
    });
  }

  let dirEntries: Dirent<string>[] = [];
  try {
    dirEntries = await readdir(worktreesDir, { withFileTypes: true });
  } catch {
    // Aucun worktree n'a jamais été créé sous ce dépôt.
  }
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreesDir, entry.name);
    const key = await canonical(path);
    if (byPath.has(key)) continue;
    byPath.set(key, {
      id: entry.name,
      handle: { path, branch: `orch/${entry.name}`, baseRef: "HEAD" },
      orphan: true,
    });
  }

  const recordedPaths = new Set(await Promise.all(recorded.map((candidate) => canonical(candidate.handle.path))));
  const candidates: Candidate[] = [];
  for (const [key, candidate] of byPath) {
    if (!recordedPaths.has(key)) candidates.push(candidate);
  }
  return candidates;
}

/** `path` est-il `dir` lui-même ou l'un de ses descendants ? Comparaison par chemins résolus, jamais par préfixe de chaîne. */
function isUnderDir(path: string, dir: string): boolean {
  const relative = relative_(resolve(dir), resolve(path));
  return relative !== "" && !relative.startsWith("..") && !isAbsolute(relative);
}

/**
 * Forme canonique d'un chemin, liens symboliques résolus — la seule sur
 * laquelle deux chemins de provenances différentes peuvent être comparés.
 *
 * `git worktree list` rend des chemins réels, quand le store a enregistré
 * celui que l'appelant lui avait donné : sur macOS, `/var/folders/…` d'un côté
 * et `/private/var/folders/…` de l'autre désignent le même répertoire, et
 * `resolve` seul ne le voit pas. Sans cette normalisation, chaque worktree
 * enregistré réapparaissait aussi comme orphelin.
 *
 * Retombe sur `resolve` quand le chemin n'existe plus : c'est justement le cas
 * d'un worktree dont l'arborescence a été effacée à la main, que `git worktree
 * list` rapporte encore.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Le worktree d'une tâche appliquée porte-t-il exactement ce qui a été
 * appliqué ? Vrai seulement quand l'enregistrement témoigne d'une
 * application (`applied_at` + empreinte) et que le patch recalculé — par le
 * même `diffWorktree` que l'application, seule façon de rendre les
 * empreintes comparables — porte encore la même empreinte. Tout échec de la
 * vérification (task.json disparu, git en échec) répond non : on ne
 * supprime jamais sur un doute.
 *
 * `diffWorktree` pose un `add --intent-to-add` dans l'index du worktree
 * candidat, y compris en `--dry-run` : c'est l'index d'un worktree jetable,
 * déjà traversé par l'application elle-même, et le geste est nécessaire —
 * sans lui, les fichiers non suivis manqueraient au patch et l'empreinte ne
 * correspondrait jamais. Le workspace réel et le store, eux, restent
 * intouchés en `--dry-run`.
 */
async function appliedAndUnchanged(record: TaskRecord | undefined): Promise<boolean> {
  if (!record?.applied_at || !record.applied_patch_digest) return false;
  try {
    const handle = await loadWorktreeHandle(record);
    if (!handle) return false;
    const diff = await diffWorktree(handle);
    return patchDigest(diff.patch) === record.applied_patch_digest;
  } catch {
    return false;
  }
}

/**
 * Nettoie les worktrees admissibles et rend une entrée pour chaque worktree
 * encore présent au début de l'opération. Avec `dryRun`, la même décision est
 * calculée mais aucune suppression n'est effectuée.
 */
export async function garbageCollectWorktrees(root: string, options: WorktreeGcOptions = {}): Promise<WorktreeGcResult> {
  // Les commandes git s'exécutent depuis la racine du dépôt, pas depuis la
  // racine orch : les deux divergent dès que `.orch/` vit dans un
  // sous-répertoire d'un dépôt (voir `orphanCandidates`), et `git worktree
  // remove` lancé hors du dépôt échouerait sur chaque candidat.
  const repo = (await repoRoot(root)) ?? root;

  // D'abord les tâches abandonnées, et avant toute lecture du store : leur
  // statut « running » protège leur worktree (`kept: active`) alors que plus
  // personne ne le tient. Sans ce passage, un orchestrateur tué condamnait son
  // worktree — et sa branche, et le `node_modules` qu'on venait d'y cloner —
  // à ne plus jamais être collectés. C'est aussi ici, et nulle part ailleurs,
  // que le marqueur périmé d'une tâche sans worktree finit par être repris :
  // le balayage des orphelins ne visite que ce que git ou `.orch/wt` connaît.
  const abandoned = await collectAbandoned(root, fileTaskStore(root), !(options.dryRun ?? false));
  // En `dryRun`, le store n'a pas bougé : leurs enregistrements disent encore
  // "running" et les feraient conserver. L'aperçu doit montrer ce que le
  // passage réel ferait, pas ce que l'inaction produit.
  const abandonedIds = new Set(abandoned.map((task) => task.id));

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
      ...(candidate.record?.applied_at ? { applied_at: candidate.record.applied_at } : {}),
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
      if (marker.state === "stale" && !options.dryRun && !(await purgeLease(marker))) {
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: "une autre opération nettoie le marqueur périmé",
        });
        continue;
      }
    }

    if (isActive(candidate.status) && !abandonedIds.has(candidate.id)) {
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

    let reason: WorktreeGcReason = "clean";
    if (modified) {
      if (await appliedAndUnchanged(candidate.record)) {
        // Le patch courant est celui qui a été appliqué : le worktree ne
        // porte plus rien d'unique, il est collectable comme un propre.
        reason = "applied";
      } else if (!options.force) {
        entries.push({ ...common, action: "kept", reason: "modified" });
        continue;
      } else {
        reason = "modified";
      }
    }

    const action: WorktreeGcAction = options.dryRun ? "would_remove" : "removed";
    if (!options.dryRun) {
      try {
        await removeWorktree(repo, candidate.handle);
      } catch (error) {
        // Un résidu que git ne connaît pas (création interrompue avant son
        // enregistrement) : le dire, plutôt que de faire échouer tout le
        // nettoyage sur un répertoire que git refuse de reprendre en main.
        entries.push({
          ...common,
          action: "kept",
          reason: "inspection_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    entries.push({ ...common, action, reason });
  }

  return {
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    abandoned,
    entries,
    removed: entries.filter((entry) => entry.action === "removed").length,
    wouldRemove: entries.filter((entry) => entry.action === "would_remove").length,
    kept: entries.filter((entry) => entry.action === "kept").length,
  };
}
