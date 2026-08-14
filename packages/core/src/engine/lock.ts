/**
 * Exclusive inter-process lock, backed by the filesystem.
 *
 * `mkdir` is atomic on every filesystem we care about:
 * it succeeds for a single caller and fails with `EEXIST` for all the others,
 * with no window between the test and the take. That is what lets several
 * `caesar` processes — a `caesar run` in a terminal, an MCP session, a
 * `caesar gc` — coordinate without a daemon or a service.
 *
 * The mechanism used to live in `gc.ts`, where it protected worktrees being
 * created from a concurrent garbage collector. It is here because a second
 * use asked for it, exactly the same one down to the key: keeping two write
 * tasks from sharing the same working tree. Extracted rather than
 * copied — two implementations of a lock always end up diverging,
 * and the one that diverges is the one that is not tested.
 *
 * A lock survives the death of its owner, and that is the delicate point:
 * the marker carries the holder's `pid`, so that a lock whose
 * process no longer exists is recognized as stale and reclaimed, rather than
 * blocking the project until a manual intervention. The `token` distinguishes
 * two successive takes of the same key: without it, a late owner
 * could release someone else's lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LockMarker {
  pid: number;
  token: string;
  /** What the holder is doing, so the refusal can name it. Absent: the refusal stays generic. */
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
 * Lock directory of a key, under `dir`.
 *
 * The digest rather than the key: the latter is supplied by the caller before
 * any validation (a task identifier, a workspace path), and a
 * fixed-size digest, without separators, can never escape the
 * markers directory.
 */
export function lockDirectory(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.lock`);
}

function lockFile(dir: string, key: string): string {
  return join(lockDirectory(dir, key), "marker.json");
}

/**
 * Takes the lock `key` under `dir`, or throws.
 *
 * `describeHolder` composes the refusal message from what the holder
 * had declared: it is up to the caller to know whether "a task is already
 * being prepared" or "another task is already writing in this directory".
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
      // The directory plays the role of exclusive lock. It stays occupied
      // until the owner releases it and cannot be replaced
      // between the token check and its deletion.
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspection = await inspectLease(dir, key);
      if (inspection.state === "active") {
        const describe = options.describeHolder ?? ((holder) => `Lock "${key}" already held by process ${holder.pid}.`);
        throw new Error(
          describe({ pid: inspection.marker.pid, ...(inspection.marker.label !== undefined ? { label: inspection.marker.label } : {}) }),
        );
      }
      if (inspection.state === "unknown") {
        throw new Error(`Unable to check the "${key}" marker: ${inspection.error}`);
      }
      if (inspection.state === "stale" && !(await purgeLease(inspection))) {
        throw new Error(`Unable to reclaim the stale "${key}" marker: another operation is cleaning it up.`);
      }
      // Marker absent or stale and purged: retry the exclusive take.
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

/** Removes the marker on a best-effort basis, only if the owner's token still matches. */
export async function releaseLease(lease: Lease): Promise<void> {
  try {
    await removeMarker(lease.directory, lease.path, lease.token);
  } catch {
    // The release must never mask the outcome of what it was protecting.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signaled.
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
      // The directory may not exist (normal absence) or be present
      // without the file (interrupted take/release): only the first case is
      // truly absent.
      try {
        await access(directory);
        return { state: "unknown", error: "incomplete marker directory" };
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
    return { state: "unknown", error: "invalid marker content" };
  }
  const { pid, token, label } = parsed as { pid?: unknown; token?: unknown; label?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || token === "") {
    return { state: "unknown", error: "invalid marker content" };
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
    // Still present only if the check or the deletion failed.
    await rmdir(cleanupLock).catch(() => {});
  }
}

/** Reclaims a lock whose holding process no longer exists. `false` if another operation is already cleaning it up. */
export async function purgeLease(inspection: Extract<LeaseInspection, { state: "stale" }>): Promise<boolean> {
  return removeMarker(inspection.directory, inspection.path, inspection.marker.token);
}
