/**
 * Verrou exclusif entre processus, adossé au système de fichiers.
 *
 * `mkdir` est atomique sur tous les systèmes de fichiers qui nous intéressent :
 * il réussit pour un seul appelant et échoue en `EEXIST` pour tous les autres,
 * sans fenêtre entre le test et la prise. C'est ce qui permet à plusieurs
 * processus `orch` — un `orch run` dans un terminal, une session MCP, un
 * `orch gc` — de se coordonner sans démon ni service.
 *
 * Le mécanisme vivait dans `gc.ts`, où il protégeait les worktrees en cours de
 * création d'un ramasse-miettes concurrent. Il est ici parce qu'un second
 * usage l'a réclamé, exactement le même à la clé près : empêcher deux tâches
 * en écriture de partager le même arbre de travail. Extrait plutôt que
 * recopié — deux implémentations d'un verrou finissent toujours par diverger,
 * et celle qui diverge est celle qu'on ne teste pas.
 *
 * Un verrou survit à la mort de son propriétaire, et c'est le point délicat :
 * le marqueur porte le `pid` du détenteur, de sorte qu'un verrou dont le
 * processus n'existe plus soit reconnu comme périmé et repris, plutôt que de
 * bloquer le projet jusqu'à une intervention manuelle. Le `token` distingue
 * deux prises successives de la même clé : sans lui, un propriétaire tardif
 * pourrait libérer le verrou d'un autre.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LockMarker {
  pid: number;
  token: string;
  /** Ce que le détenteur fait, pour que le refus le nomme. Absent : le refus reste générique. */
  label?: string;
}

export interface Lease {
  key: string;
  token: string;
  directory: string;
  path: string;
}

export type LeaseInspection =
  | { state: "absent" }
  | { state: "active"; marker: LockMarker; directory: string; path: string }
  | { state: "stale"; marker: LockMarker; directory: string; path: string }
  | { state: "unknown"; error: string };

/**
 * Répertoire-verrou d'une clé, sous `dir`.
 *
 * L'empreinte plutôt que la clé : celle-ci est fournie par l'appelant avant
 * toute validation (un identifiant de tâche, un chemin de workspace), et une
 * empreinte de taille fixe, sans séparateur, ne peut jamais s'échapper du
 * répertoire des marqueurs.
 */
export function lockDirectory(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.lock`);
}

function lockFile(dir: string, key: string): string {
  return join(lockDirectory(dir, key), "marker.json");
}

/**
 * Prend le verrou `key` sous `dir`, ou lève.
 *
 * `describeHolder` compose le motif du refus à partir de ce que le détenteur
 * avait déclaré : c'est à l'appelant de savoir si « une tâche est déjà en
 * préparation » ou « une autre tâche écrit déjà dans ce répertoire ».
 */
export async function acquireLease(
  dir: string,
  key: string,
  options: { label?: string; describeHolder?: (holder: { label?: string; pid: number }) => string } = {},
): Promise<Lease> {
  await mkdir(dir, { recursive: true });
  const directory = lockDirectory(dir, key);
  const path = lockFile(dir, key);

  for (;;) {
    const token = randomUUID();
    const marker: LockMarker = { pid: process.pid, token, ...(options.label !== undefined ? { label: options.label } : {}) };
    try {
      // Le répertoire joue le rôle de verrou exclusif. Il reste occupé
      // jusqu'à la libération du propriétaire et ne peut pas être remplacé
      // entre la vérification du jeton et sa suppression.
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspection = await inspectLease(dir, key);
      if (inspection.state === "active") {
        const describe = options.describeHolder ?? ((holder) => `Verrou "${key}" déjà détenu par le processus ${holder.pid}.`);
        throw new Error(
          describe({ pid: inspection.marker.pid, ...(inspection.marker.label !== undefined ? { label: inspection.marker.label } : {}) }),
        );
      }
      if (inspection.state === "unknown") {
        throw new Error(`Impossible de vérifier le marqueur "${key}" : ${inspection.error}`);
      }
      if (inspection.state === "stale" && !(await purgeLease(inspection))) {
        throw new Error(`Impossible de réclamer le marqueur périmé "${key}" : une autre opération le nettoie.`);
      }
      // Marqueur absent ou périmé purgé : retente la prise exclusive.
      continue;
    }

    try {
      await writeFile(path, JSON.stringify(marker) + "\n", { encoding: "utf8", flag: "wx" });
      return { key, token, directory, path };
    } catch (error) {
      await unlink(path).catch(() => {});
      await rmdir(directory).catch(() => {});
      throw error;
    }
  }
}

/** Retire au mieux le marqueur, seulement si le jeton du propriétaire correspond encore. */
export async function releaseLease(lease: Lease): Promise<void> {
  try {
    await removeMarker(lease.directory, lease.path, lease.token);
  } catch {
    // La libération ne doit jamais masquer l'issue de ce qu'elle protégeait.
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

export async function inspectLease(dir: string, key: string): Promise<LeaseInspection> {
  const directory = lockDirectory(dir, key);
  const path = lockFile(dir, key);
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
  const { pid, token, label } = parsed as { pid?: unknown; token?: unknown; label?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || token === "") {
    return { state: "unknown", error: "contenu de marqueur invalide" };
  }
  const marker: LockMarker = { pid, token, ...(typeof label === "string" ? { label } : {}) };
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
    const current = JSON.parse(await readFile(path, "utf8")) as Partial<LockMarker>;
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

/** Reprend un verrou dont le processus détenteur n'existe plus. `false` si une autre opération le nettoie déjà. */
export async function purgeLease(inspection: Extract<LeaseInspection, { state: "stale" }>): Promise<boolean> {
  return removeMarker(inspection.directory, inspection.path, inspection.marker.token);
}
