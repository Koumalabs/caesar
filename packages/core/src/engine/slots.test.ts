import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOccupiedSlots, createSlotQueue, describeSlotHolders } from "./slots.js";

const execFileAsync = promisify(execFile);
const SLOTS = join(".orch", "state", "slots");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orch-slots-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Une tâche qui se déclare active, attend d'être relâchée, puis rend. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/**
 * Occupe un créneau et ne rend la main qu'une fois la tâche *effectivement*
 * démarrée. Nécessaire parce que l'acquisition n'est pas FIFO : lancer deux
 * `run` à la suite ne dit rien de leur ordre d'entrée (voir l'en-tête du
 * module), et un test qui le supposerait mesurerait le hasard.
 */
async function occupy(queue: ReturnType<typeof createSlotQueue>) {
  const held = gate();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = queue.run(async () => {
    started();
    await held.opened;
  });
  await running;
  return { release: held.release, done };
}

describe("createSlotQueue — dans un seul processus", () => {
  it("sérialise au-delà de la limite", async () => {
    const queue = createSlotQueue({ root, limit: 1, pollMs: 10 });
    const occupant = await occupy(queue);

    let secondRan = false;
    const second = queue.run(async () => {
      secondRan = true;
    });

    // Tant que le premier tient le créneau unique, le second n'a pas commencé.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(secondRan).toBe(false);

    occupant.release();
    await Promise.all([occupant.done, second]);
    expect(secondRan).toBe(true);
    expect(await countOccupiedSlots(root)).toBe(0);
  });

  it("rend chaque créneau à la fin, y compris quand la tâche échoue", async () => {
    const queue = createSlotQueue({ root, limit: 2, pollMs: 10 });
    await expect(queue.run(async () => { throw new Error("échec délibéré"); })).rejects.toThrow("échec délibéré");
    expect(await countOccupiedSlots(root)).toBe(0);
  });

  it("laisse `limit` tâches courir de front, pas une de plus", async () => {
    const queue = createSlotQueue({ root, limit: 3, pollMs: 10 });
    let concurrent = 0;
    let peak = 0;
    const held = gate();

    const tasks = Array.from({ length: 6 }, () =>
      queue.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await held.opened;
        concurrent--;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(peak).toBe(3);
    held.release();
    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(await countOccupiedSlots(root)).toBe(0);
  });
});

describe("createSlotQueue — reprise après un processus mort", () => {
  /** Écrit un créneau à la main, comme l'aurait laissé un processus tué. */
  async function plantSlot(index: number, holder: Record<string, unknown>): Promise<string> {
    await mkdir(join(root, SLOTS), { recursive: true });
    const path = join(root, SLOTS, `${index}.json`);
    await writeFile(path, JSON.stringify(holder) + "\n", "utf8");
    return path;
  }

  it("reprend le créneau d'un pid qui n'existe plus — sinon un kill -9 condamnerait le projet", async () => {
    // Un pid libre : 2^22 dépasse le maximum de toute machine courante.
    await plantSlot(0, { pid: 4_194_303, host: hostname(), token: "mort", startedAt: new Date().toISOString() });
    const queue = createSlotQueue({ root, limit: 1, pollMs: 10 });

    let ran = false;
    await queue.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("ne touche pas au créneau d'un processus vivant", async () => {
    await plantSlot(0, { pid: process.pid, host: hostname(), token: "vivant", startedAt: new Date().toISOString() });
    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "jamais");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Le créneau planté est toujours là, avec son jeton d'origine.
    const holders = await describeSlotHolders(root, 1);
    expect(holders[0]?.token).toBe("vivant");

    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("ne reprend pas un pid d'une autre machine — il n'y est pas testable", async () => {
    await plantSlot(0, { pid: 4_194_303, host: "une-autre-machine", token: "ailleurs", startedAt: new Date().toISOString() });
    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "jamais");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await describeSlotHolders(root, 1))[0]?.token).toBe("ailleurs");
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("explique l'attente en nommant les détenteurs", async () => {
    await plantSlot(0, { pid: process.pid, host: hostname(), token: "t", startedAt: new Date().toISOString(), label: "orch run — relire le parseur" });
    const controller = new AbortController();
    let announced: string | undefined;
    const waiting = createSlotQueue({
      root,
      limit: 1,
      pollMs: 10,
      signal: controller.signal,
      onWait: (holders) => {
        announced = holders[0]?.label;
      },
    }).run(async () => "jamais");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(announced).toBe("orch run — relire le parseur");
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});

describe("createSlotQueue — abandon", () => {
  it("un signal déclenché pendant l'attente ne prend jamais le créneau", async () => {
    const occupant = await occupy(createSlotQueue({ root, limit: 1, pollMs: 10 }));

    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "jamais");
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await expect(waiting).rejects.toThrow();

    occupant.release();
    await occupant.done;
    expect(await countOccupiedSlots(root)).toBe(0);
  });
});

describe("createSlotQueue — entre processus", () => {
  /**
   * La seule preuve qui vaille pour ce module : le sémaphore en mémoire
   * (`createQueue`) passerait tous les tests ci-dessus. Deux processus Node
   * distincts, une limite de 1, et l'on constate qu'ils ne se chevauchent
   * jamais — ce que six `orch run` dans six terminaux ne respectaient pas.
   */
  it("deux processus distincts se partagent la même limite", async () => {
    const script = join(root, "prend-un-creneau.mjs");
    await writeFile(
      script,
      `
import { createSlotQueue } from ${JSON.stringify(new URL("./slots.js", import.meta.url).href.replace("/src/", "/dist/"))};
const [root, label, holdMs] = process.argv.slice(2);
const queue = createSlotQueue({ root, limit: 1, pollMs: 10, label });
await queue.run(async () => {
  process.stdout.write(JSON.stringify({ label, event: "début", at: Date.now() }) + "\\n");
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  process.stdout.write(JSON.stringify({ label, event: "fin", at: Date.now() }) + "\\n");
});
`,
      "utf8",
    );

    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, root, "a", "300"]),
      execFileAsync(process.execPath, [script, root, "b", "300"]),
    ]);

    const events = [...a.stdout.split("\n"), ...b.stdout.split("\n")]
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { label: string; event: string; at: number })
      .sort((x, y) => x.at - y.at);

    expect(events).toHaveLength(4);
    // Sans chevauchement, la séquence est nécessairement « début X, fin X,
    // début Y, fin Y » : jamais deux « début » consécutifs.
    expect(events.map((e) => e.event)).toEqual(["début", "fin", "début", "fin"]);
    expect(events[0]!.label).toBe(events[1]!.label);
    expect(events[2]!.label).toBe(events[3]!.label);
    expect(events[0]!.label).not.toBe(events[2]!.label);

    // Chaque processus a rendu son créneau en sortant.
    expect(await readdir(join(root, SLOTS))).toEqual([]);
  }, 20_000);

  it("un processus tué en cours de route ne bloque pas le suivant", async () => {
    // Le scénario qui rend la reprise indispensable : SIGKILL n'exécute
    // aucun `finally`, le fichier-créneau survit à son détenteur.
    const script = join(root, "tient-et-meurt.mjs");
    await writeFile(
      script,
      `
import { createSlotQueue } from ${JSON.stringify(new URL("./slots.js", import.meta.url).href.replace("/src/", "/dist/"))};
const [root] = process.argv.slice(2);
const queue = createSlotQueue({ root, limit: 1, pollMs: 10, label: "condamné" });
queue.run(async () => {
  process.stdout.write("pris\\n");
  await new Promise(() => {});
});
`,
      "utf8",
    );

    const child = (await import("node:child_process")).spawn(process.execPath, [script, root], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    expect(await countOccupiedSlots(root)).toBe(1);

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Le créneau est toujours là — c'est bien un cadavre, pas une libération.
    expect(await countOccupiedSlots(root)).toBe(1);

    let ran = false;
    await createSlotQueue({ root, limit: 1, pollMs: 10 }).run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  }, 20_000);
});

describe("createSlotQueue — hygiène", () => {
  it("refuse une limite absurde, comme le sémaphore en mémoire", () => {
    expect(() => createSlotQueue({ root, limit: 0 })).toThrow(/au moins 1/);
  });

  it("crée son répertoire sans que le projet soit initialisé", async () => {
    await createSlotQueue({ root, limit: 1, pollMs: 10 }).run(async () => undefined);
    // Le répertoire existe, et il est vide : le créneau a été rendu.
    expect(await readdir(join(root, SLOTS))).toEqual([]);
  });

  it("le fichier-créneau nomme son détenteur de façon exploitable", async () => {
    const occupant = await occupy(createSlotQueue({ root, limit: 1, pollMs: 10, label: "orch run — objectif" }));

    const holder = JSON.parse(await readFile(join(root, SLOTS, "0.json"), "utf8")) as Record<string, unknown>;
    expect(holder["pid"]).toBe(process.pid);
    expect(holder["host"]).toBe(hostname());
    expect(holder["label"]).toBe("orch run — objectif");
    expect(typeof holder["token"]).toBe("string");

    occupant.release();
    await occupant.done;
  });
});
