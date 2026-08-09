import { describe, expect, it } from "vitest";
import { createQueue } from "./queue.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("createQueue", () => {
  it("lève si la limite est inférieure à 1", () => {
    expect(() => createQueue(0)).toThrow();
  });

  it("laisse passer immédiatement tant que la limite n'est pas atteinte", async () => {
    const queue = createQueue(2);
    const result = await queue.run(async () => 42);
    expect(result).toBe(42);
    expect(queue.active()).toBe(0);
    expect(queue.pending()).toBe(0);
  });

  it("plafonne le nombre de tâches actives en parallèle", async () => {
    const queue = createQueue(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let activePeak = 0;

    const runs = gates.map((gate, i) =>
      queue.run(async () => {
        activePeak = Math.max(activePeak, queue.active());
        await gate.promise;
        return i;
      }),
    );

    // Laisse les micro-tâches s'installer avant d'observer l'état de la file.
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(1);

    gates[0]!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.active()).toBe(2);
    expect(queue.pending()).toBe(0);

    gates[1]!.resolve();
    gates[2]!.resolve();
    const results = await Promise.all(runs);
    expect(results).toEqual([0, 1, 2]);
    expect(activePeak).toBe(2);
    expect(queue.active()).toBe(0);
  });

  it("une tâche qui lève libère quand même sa place", async () => {
    const queue = createQueue(1);

    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(queue.active()).toBe(0);

    // La place a bien été libérée : la tâche suivante s'exécute sans attendre.
    const result = await queue.run(async () => "suivante");
    expect(result).toBe("suivante");
  });

  it("sert les tâches en attente dans l'ordre d'arrivée", async () => {
    const queue = createQueue(1);
    const first = deferred<void>();
    const order: number[] = [];

    const runA = queue.run(async () => {
      await first.promise;
      order.push(1);
    });
    await new Promise((resolve) => setImmediate(resolve));
    const runB = queue.run(async () => {
      order.push(2);
    });
    const runC = queue.run(async () => {
      order.push(3);
    });

    first.resolve();
    await Promise.all([runA, runB, runC]);
    expect(order).toEqual([1, 2, 3]);
  });
});
