/**
 * In-process TTL cache with in-flight de-duplication, for slow upstream
 * lookups behind Ground view. One copy per server process, which is what the
 * single-instance deployment runs; entries are cheap to rebuild.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  /** Return the cached value for `key`, or compute it once even if many requests ask at the same time. */
  get(key: string, compute: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      // Refresh recency so the oldest-used entry is the one evicted.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = compute();
    this.entries.set(key, { value, expires: now + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  /** Forget everything, for example after the index has been closed. */
  clear(): void {
    this.entries.clear();
  }
}

/** Limit concurrent heavy work (COG reads) per process; extra callers wait their turn. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Round a coordinate for cache keys (4 decimals is about 11 m). */
export const roundCoord = (v: number, decimals = 4) => Number(v.toFixed(decimals));
