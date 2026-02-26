/**
 * FFmpeg job concurrency limiter.
 *
 * Prevents N simultaneous FFmpeg render pipelines from exhausting CPU / RAM.
 * Uses a FIFO promise semaphore — jobs that cannot start immediately wait in
 * line and are unblocked one-at-a-time as running jobs complete.
 *
 * Limit is controlled by MAX_CONCURRENT_JOBS env var (default: 2).
 *
 * Usage:
 *   await ffmpegQueue.run(async () => {
 *     // heavyweight FFmpeg work here
 *   });
 */

export const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);

class FFmpegQueue {
  private running = 0;
  // Resolvers for jobs waiting for a free slot, in FIFO order.
  private readonly waiters: Array<() => void> = [];

  /** Number of jobs currently executing. */
  get active(): number {
    return this.running;
  }

  /** Number of jobs waiting for a free slot. */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * Acquire one slot.  Resolves immediately when a slot is free; otherwise
   * the returned promise resolves only when a running job releases its slot.
   */
  private acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Release a slot.  Hands it directly to the next waiter (FIFO), or
   * decrements the running counter if the queue is empty.
   */
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Slot passes directly to the waiter — running count stays the same.
      next();
    } else {
      this.running--;
    }
  }

  /**
   * Run `fn` inside the queue.
   *
   * - Waits for a free slot (may be immediate).
   * - Executes `fn`, catching any thrown errors.
   * - Releases the slot in a `finally` block so errors never leak a slot.
   *
   * Returns the resolved value of `fn` or re-throws its rejection.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Singleton queue — shared across all requests for this process. */
export const ffmpegQueue = new FFmpegQueue();
