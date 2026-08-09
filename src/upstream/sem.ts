export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  stats(): { active: number; queued: number; limit: number };
}
export function makeSemaphore(limit: number): Semaphore {
  let active = 0;
  const q: Array<() => void> = [];
  const next = () => {
    if (active >= limit || q.length === 0) return;
    active++;
    q.shift()!();
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await new Promise<void>((res) => {
        q.push(res);
        next();
      });
      try {
        return await fn();
      } finally {
        active--;
        next();
      }
    },
    stats: () => ({ active, queued: q.length, limit }),
  };
}
