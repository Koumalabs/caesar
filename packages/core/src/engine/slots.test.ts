import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOccupiedSlots, createSlotQueue, describeSlotHolders } from "./slots.js";

const execFileAsync = promisify(execFile);
const SLOTS = join(".caesar", "state", "slots");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caesar-slots-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A task that declares itself active, waits to be released, then returns. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/**
 * Occupies a slot and only hands back control once the task has *actually*
 * started. Necessary because acquisition is not FIFO: launching two `run`
 * calls in a row says nothing about their entry order (see the module
 * header), and a test assuming it would be measuring chance.
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

describe("createSlotQueue — within a single process", () => {
  it("serializes beyond the limit", async () => {
    const queue = createSlotQueue({ root, limit: 1, pollMs: 10 });
    const occupant = await occupy(queue);

    let secondRan = false;
    const second = queue.run(async () => {
      secondRan = true;
    });

    // As long as the first holds the single slot, the second has not started.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(secondRan).toBe(false);

    occupant.release();
    await Promise.all([occupant.done, second]);
    expect(secondRan).toBe(true);
    expect(await countOccupiedSlots(root)).toBe(0);
  });

  it("returns every slot at the end, including when the task fails", async () => {
    const queue = createSlotQueue({ root, limit: 2, pollMs: 10 });
    await expect(queue.run(async () => { throw new Error("deliberate failure"); })).rejects.toThrow("deliberate failure");
    expect(await countOccupiedSlots(root)).toBe(0);
  });

  it("lets `limit` tasks run abreast, not one more", async () => {
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

describe("createSlotQueue — reclaim after a dead process", () => {
  /** Writes a slot by hand, as a killed process would have left it. */
  async function plantSlot(index: number, holder: Record<string, unknown>): Promise<string> {
    await mkdir(join(root, SLOTS), { recursive: true });
    const path = join(root, SLOTS, `${index}.json`);
    await writeFile(path, JSON.stringify(holder) + "\n", "utf8");
    return path;
  }

  it("reclaims the slot of a pid that no longer exists — otherwise a kill -9 would doom the project", async () => {
    // A free pid: 2^22 exceeds the maximum of any current machine.
    await plantSlot(0, { pid: 4_194_303, host: hostname(), token: "dead", startedAt: new Date().toISOString() });
    const queue = createSlotQueue({ root, limit: 1, pollMs: 10 });

    let ran = false;
    await queue.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("does not touch the slot of a living process", async () => {
    await plantSlot(0, { pid: process.pid, host: hostname(), token: "alive", startedAt: new Date().toISOString() });
    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "never");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The planted slot is still there, with its original token.
    const holders = await describeSlotHolders(root, 1);
    expect(holders[0]?.token).toBe("alive");

    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("does not reclaim a pid from another machine — it cannot be tested there", async () => {
    await plantSlot(0, { pid: 4_194_303, host: "another-machine", token: "elsewhere", startedAt: new Date().toISOString() });
    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "never");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await describeSlotHolders(root, 1))[0]?.token).toBe("elsewhere");
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("explains the wait by naming the holders", async () => {
    await plantSlot(0, { pid: process.pid, host: hostname(), token: "t", startedAt: new Date().toISOString(), label: "caesar run — reread the parser" });
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
    }).run(async () => "never");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(announced).toBe("caesar run — reread the parser");
    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});

describe("createSlotQueue — abort", () => {
  it("a signal fired during the wait never takes the slot", async () => {
    const occupant = await occupy(createSlotQueue({ root, limit: 1, pollMs: 10 }));

    const controller = new AbortController();
    const waiting = createSlotQueue({ root, limit: 1, pollMs: 10, signal: controller.signal }).run(async () => "never");
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await expect(waiting).rejects.toThrow();

    occupant.release();
    await occupant.done;
    expect(await countOccupiedSlots(root)).toBe(0);
  });
});

describe("createSlotQueue — across processes", () => {
  /**
   * The only proof that counts for this module: the in-memory semaphore
   * (`createQueue`) would pass all the tests above. Two distinct Node
   * processes, a limit of 1, and we observe that they never overlap — which
   * six `caesar run` in six terminals did not respect.
   */
  it("two distinct processes share the same limit", async () => {
    const script = join(root, "take-a-slot.mjs");
    await writeFile(
      script,
      `
import { createSlotQueue } from ${JSON.stringify(new URL("./slots.js", import.meta.url).href.replace("/src/", "/dist/"))};
const [root, label, holdMs] = process.argv.slice(2);
const queue = createSlotQueue({ root, limit: 1, pollMs: 10, label });
await queue.run(async () => {
  process.stdout.write(JSON.stringify({ label, event: "start", at: Date.now() }) + "\\n");
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  process.stdout.write(JSON.stringify({ label, event: "end", at: Date.now() }) + "\\n");
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
    // Without overlap, the sequence is necessarily "start X, end X,
    // start Y, end Y": never two consecutive "start".
    expect(events.map((e) => e.event)).toEqual(["start", "end", "start", "end"]);
    expect(events[0]!.label).toBe(events[1]!.label);
    expect(events[2]!.label).toBe(events[3]!.label);
    expect(events[0]!.label).not.toBe(events[2]!.label);

    // Each process returned its slot on exit.
    expect(await readdir(join(root, SLOTS))).toEqual([]);
  }, 20_000);

  it("a process killed midway does not block the next one", async () => {
    // The scenario that makes the reclaim indispensable: SIGKILL runs no
    // `finally`, the slot file outlives its holder.
    const script = join(root, "hold-and-die.mjs");
    await writeFile(
      script,
      `
import { createSlotQueue } from ${JSON.stringify(new URL("./slots.js", import.meta.url).href.replace("/src/", "/dist/"))};
const [root] = process.argv.slice(2);
const queue = createSlotQueue({ root, limit: 1, pollMs: 10, label: "doomed" });
queue.run(async () => {
  process.stdout.write("taken\\n");
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
    // The slot is still there — it really is a corpse, not a release.
    expect(await countOccupiedSlots(root)).toBe(1);

    let ran = false;
    await createSlotQueue({ root, limit: 1, pollMs: 10 }).run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  }, 20_000);
});

describe("createSlotQueue — hygiene", () => {
  it("refuses an absurd limit, like the in-memory semaphore", () => {
    expect(() => createSlotQueue({ root, limit: 0 })).toThrow(/at least 1/);
  });

  it("creates its directory without the project being initialized", async () => {
    await createSlotQueue({ root, limit: 1, pollMs: 10 }).run(async () => undefined);
    // The directory exists, and it is empty: the slot was returned.
    expect(await readdir(join(root, SLOTS))).toEqual([]);
  });

  it("the slot file names its holder in a usable way", async () => {
    const occupant = await occupy(createSlotQueue({ root, limit: 1, pollMs: 10, label: "caesar run — objective" }));

    const holder = JSON.parse(await readFile(join(root, SLOTS, "0.json"), "utf8")) as Record<string, unknown>;
    expect(holder["pid"]).toBe(process.pid);
    expect(holder["host"]).toBe(hostname());
    expect(holder["label"]).toBe("caesar run — objective");
    expect(typeof holder["token"]).toBe("string");

    occupant.release();
    await occupant.done;
  });
});
