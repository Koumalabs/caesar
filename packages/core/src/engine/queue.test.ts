import { describe, expect, it } from "vitest";
import { createQueue } from "./queue.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("createQueue", () => {
  it("throws if the limit is below 1", () => {
    expect(() => createQueue(0)).toThrow();
  });

  it("lets tasks through immediately as long as the limit is not reached", async () => {
    const queue = createQueue(2);
    const result = await queue.run(async () => 42);
    expect(result).toBe(42);
    expect(queue.active()).toBe(0);
    expect(queue.pending()).toBe(0);
  });

  it("caps the number of tasks active in parallel", async () => {
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

    // Let the microtasks settle before observing the queue's state.
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

  it("a task that throws still frees its place", async () => {
    const queue = createQueue(1);

    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(queue.active()).toBe(0);

    // The place was indeed freed: the next task runs without waiting.
    const result = await queue.run(async () => "next");
    expect(result).toBe("next");
  });

  it("serves the waiting tasks in arrival order", async () => {
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
