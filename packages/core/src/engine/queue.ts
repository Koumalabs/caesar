/**
 * Sémaphore simple : plafonne le nombre de tâches actives en parallèle.
 * Utilisé par le runner pour ne pas saturer la machine de processus fils
 * concurrents.
 */
export interface Queue {
  run<T>(task: () => Promise<T>): Promise<T>;
  active(): number;
  pending(): number;
}

export function createQueue(limit: number): Queue {
  if (limit < 1) {
    throw new Error(`La limite de la file doit être au moins 1 (reçu ${limit}).`);
  }

  let activeCount = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeCount < limit) {
      activeCount++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // Le réveil vient de `release()`, qui nous cède directement sa place
    // sans jamais faire redescendre `activeCount` à zéro entre-temps : pas
    // de fenêtre où un autre appelant pourrait s'y engouffrer en trop.
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
