const MAX_ENTRIES = 1000;

type Entry = { expires: number; value: Promise<unknown> };

/**
 * In-memory TTL cache. Concurrent callers share one in-flight load, and a
 * rejected load is forgotten straight away so failures are never served twice.
 */
export class TtlCache {
  private entries = new Map<string, Entry>();

  constructor(private now: () => number) {}

  /** Whether a live (unexpired) entry exists, so callers can report cache use without loading. */
  has(key: string) {
    const hit = this.entries.get(key);
    return Boolean(hit && hit.expires > this.now());
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const time = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > time) return hit.value as Promise<T>;

    this.makeRoom(time);
    const value = load();
    this.entries.set(key, { expires: time + ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  private makeRoom(time: number) {
    if (this.entries.size < MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (entry.expires <= time) this.entries.delete(key);
    }
    // Map iterates in insertion order, so the first key is the oldest.
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
