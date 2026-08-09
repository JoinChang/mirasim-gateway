import { describe, expect, it } from "vitest";
import { makeSemaphore } from "../../src/upstream/sem.js";

describe("semaphore", () => {
  it("caps concurrency", async () => {
    const sem = makeSemaphore(2);
    let active = 0,
      peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
