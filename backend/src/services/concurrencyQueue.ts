/**
 * Promise-based concurrency limiter (semaphore) for FFmpeg processes.
 *
 * PROBLEM WITHOUT THIS:
 *   generateBatch(1000 edits) would call assembleVideo() 1000 times with
 *   Promise.all() — spawning 1000 simultaneous FFmpeg processes.
 *
 *   Each FFmpeg process on a 4-core CPU uses ~100% of one core at peak.
 *   1000 simultaneous processes → process creation overhead melts the OS.
 *   Memory: each FFmpeg process ~50MB RSS → 50 GB RAM exhausted instantly.
 *   File descriptors: each process opens 10+ fds → OS limit hit at ~200.
 *   Thrashing: OS scheduler spends more time context-switching than encoding.
 *
 * SOLUTION:
 *   Semaphore with maxConcurrent slots.
 *   All 1000 tasks are dispatched immediately but only `maxConcurrent` run.
 *   Completed tasks release their slot, immediately unblocking the next waiter.
 *   No polling. No sleep(). O(1) acquire + release via promise resolution queue.
 *
 * RECOMMENDED VALUES:
 *   maxConcurrent=2  — laptop, shared server, GPU encoding
 *   maxConcurrent=3  — desktop workstation, NVMe, dedicated server
 *   maxConcurrent=4  — high-core-count server, software encoder
 *   maxConcurrent=6+ — GPU encoding with h264_nvenc (less CPU bound)
 *
 * Set via env: MAX_FFMPEG_CONCURRENCY=3
 *
 * SCALE PROJECTIONS:
 *   100 edits,  1 platform, 3 concurrent, ~15s/edit → ~8 min wall time
 *   1000 edits, 1 platform, 3 concurrent, ~15s/edit → ~83 min wall time
 *   10000 edits,1 platform, 4 concurrent, ~10s/edit → ~7 hr wall time
 *
 *   For 10k scale, recommendation: distribute jobs across multiple servers
 *   using job_id ranges, each server running its own semaphore.
 */

export class Semaphore {
  private slots: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error("Semaphore: maxConcurrent must be >= 1");
    }
    this.slots = maxConcurrent;
  }

  /**
   * Acquire one slot.
   * Returns immediately if a slot is available.
   * Otherwise, suspends until a slot is released.
   */
  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    // Park the caller — they will be resumed when release() is called
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release one slot.
   * If waiters are queued, the oldest waiter is immediately unblocked
   * (FIFO order — prevents starvation).
   */
  release(): void {
    if (this.waiters.length > 0) {
      // Directly hand the slot to the next waiter without incrementing
      // and immediately decrementing — avoids spurious slot count fluctuation
      const next = this.waiters.shift()!;
      next();
    } else {
      this.slots++;
    }
  }

  /**
   * Run `task` exclusively within one semaphore slot.
   * Acquires before calling task(), releases in finally (crash-safe).
   * Errors from task() propagate normally to the caller.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Number of tasks currently running (acquired slots). */
  get active(): number {
    return this.maxConcurrent - this.slots;
  }

  /** Number of tasks waiting for a slot. */
  get pending(): number {
    return this.waiters.length;
  }

  /** Snapshot of queue state for monitoring/logging. */
  status(): { active: number; pending: number; maxConcurrent: number } {
    return {
      active: this.active,
      pending: this.pending,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// ── Global FFmpeg semaphore ────────────────────────────────

/**
 * Singleton semaphore used by all render calls in this process.
 *
 * Reads MAX_FFMPEG_CONCURRENCY from env at module load time.
 * Default: 3 (safe for most developer machines and VPS instances).
 *
 * Change at runtime is intentionally NOT supported — the value is fixed
 * at process start to avoid race conditions in long-running batch jobs.
 */
export const ffmpegQueue = new Semaphore(
  Math.max(1, parseInt(process.env.MAX_FFMPEG_CONCURRENCY ?? "3", 10)),
);
