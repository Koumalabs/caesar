/**
 * `policy.max_parallel` enforced **across processes**, not merely within a
 * single one.
 *
 * The defect this module fixes: `createQueue` (queue.ts) is an in-memory
 * semaphore. It keeps its promise within one MCP session — all delegations
 * there share one queue — but every `caesar run` builds its own. Six
 * terminals meant six agents in flight whatever the setting, and a
 * `caesar run` launched while a Claude Code conversation was already
 * delegating added itself to its four without knowing anything about them.
 *
 * The lock: `limit` slot files under `<root>/.caesar/state/slots/`. Taking
 * a slot means succeeding at creating its file under mutual exclusion
 * (`flag: "wx"` — `O_CREAT|O_EXCL`, atomic: a single caller wins, the
 * others receive EEXIST). Returning it means deleting it.
 *
 * Two properties are worth stating, because they decide the behavior when
 * trouble strikes:
 *
 *  - **A killed process does not block the next ones.** Its file survives,
 *    but it carries its pid: the first caller that finds all slots taken
 *    checks every holder and reclaims those whose process no longer exists.
 *    Without this reclaim, a `kill -9` would doom the project to never
 *    launch anything again — a limit that becomes a permanent blockage is
 *    worse than no limit at all.
 *  - **Nobody frees someone else's slot.** Each file carries a random
 *    token, re-checked just before any deletion. Without it, two
 *    simultaneous reclaims of the same dead slot could cascade: the second
 *    erased the slot the first had just legitimately reclaimed, and the
 *    count drifted durably.
 *
 * Two things this lock does not claim to be:
 *
 *  - **Fair.** The wait is a poll, not a queue: between two candidates, the
 *    one who knocks at the right moment gets in, not the first arrived.
 *    `createQueue`, for its part, is strictly FIFO. The difference only
 *    matters to whoever writes a test assuming the order.
 *  - **Distributed.** Reclaiming a dead slot relies on
 *    `process.kill(pid, 0)`, which means nothing for a pid from another
 *    machine — a `.caesar/` placed on a network share and used from two
 *    hosts would see the other's slots as alive forever. The machine name
 *    is recorded so that this case can be recognized rather than guessed
 *    (`describeSlotHolders`).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Queue } from "./queue.js";

/** Slots subdirectory, relative to the project root. Already covered by the `.gitignore` written by `caesar init` (`.caesar/state/`). */
const SLOTS_DIR = join(".caesar", "state", "slots");

/** Interval between two attempts when all slots are taken. */
const DEFAULT_POLL_MS = 250;

/**
 * Below this, an unreadable slot file is not considered a corpse: the
 * (atomic) creation and the writing of its content are two distinct calls,
 * and a reader can land in the gap. Reclaiming it would amount to stealing
 * the slot of a perfectly alive process, one millisecond after it obtained
 * it.
 */
const WRITE_GRACE_MS = 2_000;

interface SlotHolder {
  pid: number;
  host: string;
  /** Identifies the holder: nobody deletes a slot whose token is no longer theirs. */
  token: string;
  startedAt: string;
  /** What the holder is doing, so the wait can be explained rather than endured. */
  label?: string;
}

export interface SlotQueueOptions {
  /** Project root: the slots are shared by everything that delegates under this root. */
  root: string;
  limit: number;
  /** What this process writes into its slot — passed through as-is by `describeSlotHolders`. */
  label?: string;
  /** Called exactly once, at the moment we actually start waiting. */
  onWait?: (holders: SlotHolder[]) => void;
  /** Interrupts the wait. The slot is never taken after an abort. */
  signal?: AbortSignal;
  pollMs?: number;
}

function slotPath(root: string, index: number): string {
  return join(root, SLOTS_DIR, `${index}.json`);
}

/** True if the process still exists. Signal 0 only tests: it kills nothing. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — alive,
    // therefore, and its slot is not up for reclaiming.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function readHolder(path: string): Promise<SlotHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const holder = parsed as Partial<SlotHolder>;
    if (typeof holder.pid !== "number" || typeof holder.token !== "string" || typeof holder.host !== "string") return null;
    return holder as SlotHolder;
  } catch {
    // Absent, truncated, or unreadable: the caller decides, based on the
    // file's age, whether it is a write in progress or a corpse.
    return null;
  }
}

/**
 * Deletes `path` **only** if it still carries `token`. This is the
 * guarantee that keeps a concurrent reclaim from degenerating: between the
 * moment we decide a slot is dead and the moment we erase it, another
 * process may have legitimately reclaimed it — erasing it then would
 * amount to stealing it from them.
 */
async function unlinkIfToken(path: string, token: string): Promise<boolean> {
  const holder = await readHolder(path);
  if (!holder || holder.token !== token) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

/** File age in milliseconds, `null` if it no longer exists. */
async function ageMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Attempts to reclaim the slots whose holder no longer exists. Returns the
 * number of slots freed — zero means the wait is legitimate.
 */
async function reclaimDead(root: string, limit: number): Promise<number> {
  let reclaimed = 0;
  for (let index = 0; index < limit; index++) {
    const path = slotPath(root, index);
    const holder = await readHolder(path);

    if (!holder) {
      // Unreadable: corpse of an interrupted write, or a file being written
      // this very instant. Only the age tells them apart.
      const age = await ageMs(path);
      if (age !== null && age > WRITE_GRACE_MS) {
        try {
          await unlink(path);
          reclaimed++;
        } catch {
          // Another caller reclaimed it in the meantime: fine.
        }
      }
      continue;
    }

    // A pid from another machine cannot be tested: we do not reclaim.
    if (holder.host !== hostname()) continue;
    if (isProcessAlive(holder.pid)) continue;
    if (await unlinkIfToken(path, holder.token)) reclaimed++;
  }
  return reclaimed;
}

/** The current holders, to explain a wait rather than leaving it mute. */
export async function describeSlotHolders(root: string, limit: number): Promise<SlotHolder[]> {
  const holders: SlotHolder[] = [];
  for (let index = 0; index < limit; index++) {
    const holder = await readHolder(slotPath(root, index));
    if (holder) holders.push(holder);
  }
  return holders;
}

/** Number of occupied slots under this root, whatever the reader's limit. */
export async function countOccupiedSlots(root: string): Promise<number> {
  try {
    return (await readdir(join(root, SLOTS_DIR))).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * A semaphore of `limit` places, shared by all processes working under
 * `root`. Implements `Queue`: it substitutes for `createQueue` everywhere
 * `RunnerDeps.queue` is expected, without the engine having to know that
 * the limit is now inter-process.
 *
 * `limit` is the one *this* process read from the configuration. Two
 * processes that read different limits (distinct local layer, file
 * modified in between) would share the slots according to the larger of
 * the two: this is inherent to a setting re-read at every launch, and
 * without consequence — the limit remains bounded.
 */
export function createSlotQueue(options: SlotQueueOptions): Queue {
  const { root, limit, label, onWait, signal } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (limit < 1) {
    throw new Error(`The queue limit must be at least 1 (received ${limit}).`);
  }

  let activeCount = 0;
  let waitingCount = 0;

  async function tryTake(): Promise<{ path: string; token: string } | null> {
    const token = randomUUID();
    for (let index = 0; index < limit; index++) {
      const path = slotPath(root, index);
      const holder: SlotHolder = {
        pid: process.pid,
        host: hostname(),
        token,
        startedAt: new Date().toISOString(),
        ...(label !== undefined ? { label } : {}),
      };
      try {
        // `wx` = O_CREAT|O_EXCL: the creation is atomic, a single caller
        // wins this slot. The content write follows, but the winner is
        // already designated — the content only serves the reclaim of a
        // dead one.
        await writeFile(path, JSON.stringify(holder) + "\n", { flag: "wx" });
        return { path, token };
      } catch (error) {
        if (isErrno(error, "EEXIST")) continue;
        throw error;
      }
    }
    return null;
  }

  async function acquire(): Promise<{ path: string; token: string }> {
    await mkdir(join(root, SLOTS_DIR), { recursive: true });

    let announced = false;
    for (;;) {
      signal?.throwIfAborted();

      const taken = await tryTake();
      if (taken) return taken;

      // All taken: before waiting, verify that no holder is a ghost. This
      // is what makes the lock recoverable after a `kill -9`.
      if ((await reclaimDead(root, limit)) > 0) continue;

      if (!announced) {
        announced = true;
        onWait?.(await describeSlotHolders(root, limit));
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, pollMs);
        function onAbort(): void {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("Wait interrupted."));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      waitingCount++;
      let slot: { path: string; token: string };
      try {
        slot = await acquire();
      } finally {
        waitingCount--;
      }
      activeCount++;
      try {
        return await task();
      } finally {
        activeCount--;
        // Only release if the slot is still ours: if a concurrent reclaim
        // had taken us for dead, erasing it blindly would delete the slot
        // of its new holder.
        await unlinkIfToken(slot.path, slot.token).catch(() => {
          // A slot we could not return will be reclaimed by the next caller
          // who observes our pid extinguished: never fail a successful task
          // over a lock file.
        });
      }
    },
    /** Places occupied **by this process**. Global occupancy is read with `countOccupiedSlots`. */
    active: () => activeCount,
    /** Callers waiting **in this process**: those of other processes cannot be counted from outside. */
    pending: () => waitingCount,
  };
}
