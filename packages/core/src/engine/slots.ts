/**
 * `policy.max_parallel` appliqué **entre processus**, et non seulement à
 * l'intérieur d'un seul.
 *
 * Le défaut que ce module corrige : `createQueue` (queue.ts) est un sémaphore
 * en mémoire. Il tient sa promesse au sein d'une session MCP — toutes les
 * délégations y partagent une file — mais chaque `orch run` construit la
 * sienne. Six terminaux, c'était six agents en vol quel que soit le réglage,
 * et un `orch run` lancé pendant qu'une conversation Claude Code déléguait
 * déjà s'ajoutait aux quatre siennes sans rien en savoir.
 *
 * Le verrou : `limit` fichiers-créneaux sous `<root>/.orch/state/slots/`.
 * Prendre un créneau, c'est réussir à créer son fichier en exclusion mutuelle
 * (`flag: "wx"` — `O_CREAT|O_EXCL`, atomique : un seul appelant gagne, les
 * autres reçoivent EEXIST). Le rendre, c'est le supprimer.
 *
 * Deux propriétés valent d'être énoncées, parce qu'elles décident du
 * comportement en cas d'ennui :
 *
 *  - **Un processus tué ne bloque pas les suivants.** Son fichier survit,
 *    mais il porte son pid : le premier appelant qui trouve tous les créneaux
 *    pris vérifie chaque détenteur et récupère ceux dont le processus n'existe
 *    plus. Sans cette reprise, un `kill -9` condamnerait le projet à ne plus
 *    jamais rien lancer — une limite qui devient un blocage définitif est pire
 *    que pas de limite du tout.
 *  - **Personne ne libère le créneau d'autrui.** Chaque fichier porte un
 *    jeton aléatoire, revérifié juste avant toute suppression. Sans lui, deux
 *    reprises simultanées du même créneau mort pouvaient s'enchaîner en
 *    cascade : le second effaçait le créneau que le premier venait de
 *    légitimement reprendre, et le compte dérivait durablement.
 *
 * Deux choses que ce verrou ne prétend pas être :
 *
 *  - **Équitable.** L'attente est une scrutation, pas une file : entre deux
 *    candidats, c'est celui qui frappe au bon moment qui entre, et non le
 *    premier arrivé. `createQueue`, lui, est strictement FIFO. La différence
 *    n'a d'importance que pour qui écrit un test supposant l'ordre.
 *  - **Distribué.** La reprise d'un créneau mort repose sur
 *    `process.kill(pid, 0)`, qui ne veut rien dire pour un pid d'une autre
 *    machine — un `.orch/` posé sur un partage réseau et utilisé depuis deux
 *    postes verrait les créneaux de l'autre comme vivants à jamais. Le nom de
 *    la machine est enregistré pour que ce cas se reconnaisse plutôt que de
 *    se deviner (`describeSlotHolders`).
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Queue } from "./queue.js";

/** Sous-répertoire des créneaux, relatif à la racine du projet. Déjà couvert par le `.gitignore` posé par `orch init` (`.orch/state/`). */
const SLOTS_DIR = join(".orch", "state", "slots");

/** Intervalle entre deux tentatives quand tous les créneaux sont pris. */
const DEFAULT_POLL_MS = 250;

/**
 * En deçà, un fichier-créneau illisible n'est pas considéré comme un cadavre :
 * la création (atomique) et l'écriture de son contenu sont deux appels
 * distincts, et un lecteur peut tomber dans l'intervalle. Le reprendre
 * reviendrait à voler le créneau d'un processus parfaitement vivant, une
 * milliseconde après qu'il l'a obtenu.
 */
const WRITE_GRACE_MS = 2_000;

interface SlotHolder {
  pid: number;
  host: string;
  /** Identifie le détenteur : personne ne supprime un créneau dont le jeton n'est plus le sien. */
  token: string;
  startedAt: string;
  /** Ce que fait le détenteur, pour que l'attente puisse être expliquée plutôt que subie. */
  label?: string;
}

export interface SlotQueueOptions {
  /** Racine du projet : les créneaux sont partagés par tout ce qui délègue sous cette racine. */
  root: string;
  limit: number;
  /** Ce que ce processus inscrit dans son créneau — repris tel quel par `describeSlotHolders`. */
  label?: string;
  /** Appelé une seule fois, au moment où l'on commence effectivement à attendre. */
  onWait?: (holders: SlotHolder[]) => void;
  /** Interrompt l'attente. Le créneau n'est jamais pris après un abandon. */
  signal?: AbortSignal;
  pollMs?: number;
}

function slotPath(root: string, index: number): string {
  return join(root, SLOTS_DIR, `${index}.json`);
}

/** Vrai si le processus existe encore. Le signal 0 ne fait que tester : il ne tue rien. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le processus existe mais appartient à un autre utilisateur —
    // vivant, donc, et son créneau n'est pas à reprendre.
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
    // Absent, tronqué, ou illisible : l'appelant décide, selon l'âge du
    // fichier, s'il s'agit d'une écriture en cours ou d'un cadavre.
    return null;
  }
}

/**
 * Supprime `path` **seulement** s'il porte encore `token`. C'est la garantie
 * qui empêche une reprise concurrente de dégénérer : entre le moment où l'on
 * décide qu'un créneau est mort et celui où on l'efface, un autre processus a
 * pu le reprendre légitimement — l'effacer alors reviendrait à le lui voler.
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

/** Âge du fichier en millisecondes, `null` s'il n'existe plus. */
async function ageMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Tente de reprendre les créneaux dont le détenteur n'existe plus. Rend le
 * nombre de créneaux libérés — zéro signifie que l'attente est légitime.
 */
async function reclaimDead(root: string, limit: number): Promise<number> {
  let reclaimed = 0;
  for (let index = 0; index < limit; index++) {
    const path = slotPath(root, index);
    const holder = await readHolder(path);

    if (!holder) {
      // Illisible : cadavre d'une écriture interrompue, ou fichier en cours
      // d'écriture à l'instant même. Seul l'âge les distingue.
      const age = await ageMs(path);
      if (age !== null && age > WRITE_GRACE_MS) {
        try {
          await unlink(path);
          reclaimed++;
        } catch {
          // Un autre appelant l'a repris entre-temps : très bien.
        }
      }
      continue;
    }

    // Un pid d'une autre machine ne se teste pas : on ne reprend pas.
    if (holder.host !== hostname()) continue;
    if (isProcessAlive(holder.pid)) continue;
    if (await unlinkIfToken(path, holder.token)) reclaimed++;
  }
  return reclaimed;
}

/** Les détenteurs actuels, pour expliquer une attente plutôt que la laisser muette. */
export async function describeSlotHolders(root: string, limit: number): Promise<SlotHolder[]> {
  const holders: SlotHolder[] = [];
  for (let index = 0; index < limit; index++) {
    const holder = await readHolder(slotPath(root, index));
    if (holder) holders.push(holder);
  }
  return holders;
}

/** Nombre de créneaux occupés sous cette racine, quelle que soit la limite du lecteur. */
export async function countOccupiedSlots(root: string): Promise<number> {
  try {
    return (await readdir(join(root, SLOTS_DIR))).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Un sémaphore de `limit` places, partagé par tous les processus travaillant
 * sous `root`. Implémente `Queue` : il se substitue à `createQueue` partout
 * où `RunnerDeps.queue` est attendu, sans que le moteur ait à savoir que la
 * limite est désormais inter-processus.
 *
 * `limit` est celui que *ce* processus a lu dans la configuration. Deux
 * processus qui liraient des limites différentes (couche locale distincte,
 * fichier modifié entre-temps) se partageraient les créneaux selon la plus
 * grande des deux : c'est inhérent à un réglage relu à chaque lancement, et
 * sans conséquence — la limite reste bornée.
 */
export function createSlotQueue(options: SlotQueueOptions): Queue {
  const { root, limit, label, onWait, signal } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (limit < 1) {
    throw new Error(`La limite de la file doit être au moins 1 (reçu ${limit}).`);
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
        // `wx` = O_CREAT|O_EXCL : la création est atomique, un seul appelant
        // gagne ce créneau. L'écriture du contenu suit, mais le vainqueur est
        // déjà désigné — le contenu ne sert qu'à la reprise d'un mort.
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

      // Tous pris : avant d'attendre, vérifier qu'aucun détenteur n'est un
      // fantôme. C'est ce qui rend le verrou récupérable après un `kill -9`.
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
          reject(signal?.reason ?? new Error("Attente interrompue."));
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
        // Ne libère que si le créneau est encore le nôtre : si une reprise
        // concurrente nous l'avait pris pour mort, l'effacer aveuglément
        // supprimerait le créneau de son nouveau détenteur.
        await unlinkIfToken(slot.path, slot.token).catch(() => {
          // Un créneau qu'on n'a pas pu rendre sera repris par le prochain
          // appelant qui constatera notre pid éteint : ne jamais faire
          // échouer une tâche réussie pour un fichier de verrou.
        });
      }
    },
    /** Places occupées **par ce processus**. L'occupation globale se lit avec `countOccupiedSlots`. */
    active: () => activeCount,
    /** Appelants en attente **dans ce processus** : ceux des autres ne se comptent pas de l'extérieur. */
    pending: () => waitingCount,
  };
}
