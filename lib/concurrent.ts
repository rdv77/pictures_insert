type Options<T> = {
  concurrency: number;
  budget: number;
  cost: (item: T) => number;
  shouldStop: () => boolean;
  run: (item: T) => Promise<void>;
};

// FIFO dispatch; a failure or pause stops new work, but drains in-flight requests.
export async function runConcurrent<T>(items: readonly T[], options: Options<T>) {
  const limit = Math.max(1, Math.min(4, Math.floor(options.concurrency) || 1));
  const active = new Set<Promise<void>>();
  let next = 0, used = 0, completed = 0;
  const errors: unknown[] = [];
  while (next < items.length || active.size) {
    while (next < items.length && active.size < limit && !errors.length && !options.shouldStop()) {
      const item = items[next];
      const cost = Math.min(options.budget, Math.max(1, options.cost(item)));
      if (used + cost > options.budget) break;
      next++; used += cost;
      const task = Promise.resolve().then(() => options.run(item)).then(() => { completed++; }).catch(error => { errors.push(error); }).finally(() => { used -= cost; active.delete(task); });
      active.add(task);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  return { completed, started: next, errors };
}

export function editMemoryCost(photoBytes?: number, posterBytes?: number) {
  const fallback = 10 * 1024 * 1024;
  // Allow for base64 / JSON copies and response buffers in the Worker runtime.
  return 24 * 1024 * 1024 + 5 * ((photoBytes ?? fallback) + (posterBytes ?? fallback));
}
