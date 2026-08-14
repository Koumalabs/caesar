/**
 * Simple semaphore: caps the number of tasks active in parallel.
 * Used by the runner to avoid saturating the machine with concurrent
 * child processes.
 */
export interface Queue {
  run<T>(task: () => Promise<T>): Promise<T>;
  active(): number;
  pending(): number;
}

export function createQueue(limit: number): Queue {
  if (limit < 1) {
    throw new Error(`The queue limit must be at least 1 (received ${limit}).`);
  }

  let activeCount = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeCount < limit) {
      activeCount++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // The wake-up comes from `release()`, which hands us its place directly
    // without ever letting `activeCount` drop to zero in between: no window
    // in which another caller could slip in as an extra.
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      activeCount--;
    }
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    active: () => activeCount,
    pending: () => waiting.length,
  };
}
