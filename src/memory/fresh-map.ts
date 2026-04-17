/**
 * fresh-map.ts — short-lived in-memory view of the most recent writes.
 *
 * Why: read-your-writes consistency. After writeFile, the next readFile
 * needs to see the new content immediately without waiting for any async
 * index (Chroma, FTS) to catch up. We keep the last N writes (default 10)
 * for up to M ms (default 5 min) in a Map, then evict.
 *
 * This is not a general-purpose cache — it's a consistency window. Misses
 * fall through to SQLite, which is always authoritative.
 */

export interface FreshEntry {
  path: string;
  content: Uint8Array | null;
  kind: "file" | "dir" | "tombstone";
  ts: number;
}

export interface FreshMapOptions {
  maxEntries?: number;
  maxAgeMs?: number;
}

export class FreshMap {
  private entries = new Map<string, FreshEntry>();
  private order: string[] = [];
  private maxEntries: number;
  private maxAgeMs: number;

  constructor(options: FreshMapOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10;
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
  }

  set(path: string, entry: Omit<FreshEntry, "path" | "ts">): void {
    const full: FreshEntry = { ...entry, path, ts: Date.now() };
    if (this.entries.has(path)) {
      this.order = this.order.filter((p) => p !== path);
    }
    this.entries.set(path, full);
    this.order.push(path);
    while (this.order.length > this.maxEntries) {
      const evict = this.order.shift()!;
      this.entries.delete(evict);
    }
  }

  get(path: string): FreshEntry | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.maxAgeMs) {
      this.entries.delete(path);
      this.order = this.order.filter((p) => p !== path);
      return undefined;
    }
    return entry;
  }

  delete(path: string): void {
    this.entries.delete(path);
    this.order = this.order.filter((p) => p !== path);
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
  }
}
