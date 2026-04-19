/**
 * async-indexer.ts — Durable background indexer for writable-mount content.
 *
 * Flow:
 *   WritableFileSystem.writeFile / appendFile / rm   ─ enqueue ─▶  index_queue
 *
 *                              ┌─ every pollMs ──▶ drain(batchSize)
 *   AsyncIndexer.start() ─────▶│
 *                              └─ SIGINT / stop() ──▶ graceful shutdown
 *
 *   drain:
 *     1. SELECT next N rows (ORDER BY enqueued_at ASC)
 *     2. for each: look up current content in `nodes`
 *        - if op=upsert AND row still exists → chunk + upsert to Chroma
 *        - if op=delete OR row missing       → delete chunks by (mount, path)
 *     3. success → DELETE FROM index_queue WHERE id = ?
 *        failure → UPDATE attempts = attempts + 1, last_error = ?
 *
 * Rows stay in the queue on repeated failure — the janitor surfaces them
 * when attempts >= 5. That replaces a separate dead-letter table.
 */

import type { Client } from "@libsql/client";

/** Pluggable Chroma-like surface — tests pass a fake, production passes ChromaSearchIndex. */
export interface IndexerSink {
  upsertChunks(
    mount: string,
    mountRelPath: string,
    content: string,
    provenanceSource?: string
  ): Promise<void>;
  deleteChunks(mount: string, mountRelPath: string): Promise<void>;
}

export interface AsyncIndexerOptions {
  client: Client;
  sink: IndexerSink;
  /** How many items to drain per tick. Default 32. */
  batchSize?: number;
  /** Poll interval in ms. Default 250. */
  pollMs?: number;
  /** Called on unexpected errors (not per-row; per-row errors go to the queue). */
  onError?: (err: Error) => void;
}

/** Helper callable by WritableFileSystem on every mutation. */
export class IndexerHook {
  constructor(private client: Client) {}

  async enqueueUpsert(mount: string, path: string): Promise<void> {
    await this.enqueue(mount, path, "upsert");
  }

  async enqueueDelete(mount: string, path: string): Promise<void> {
    await this.enqueue(mount, path, "delete");
  }

  private async enqueue(mount: string, path: string, op: "upsert" | "delete"): Promise<void> {
    try {
      await this.client.execute({
        sql: `INSERT INTO index_queue (mount, path, op, enqueued_at) VALUES (?, ?, ?, ?)`,
        args: [mount, path, op, Date.now()],
      });
    } catch {
      // Non-fatal: if the queue table doesn't exist yet or the DB is down,
      // writes still succeed — we just miss an index update.
    }
  }
}

export class AsyncIndexer {
  private client: Client;
  private sink: IndexerSink;
  private batchSize: number;
  private pollMs: number;
  private onError: (err: Error) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: AsyncIndexerOptions) {
    this.client = opts.client;
    this.sink = opts.sink;
    this.batchSize = opts.batchSize ?? 32;
    this.pollMs = opts.pollMs ?? 250;
    this.onError = opts.onError ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.draining) return;
      this.drain().catch((e) => this.onError(e as Error));
    }, this.pollMs);
    // Don't keep the process alive just for polling.
    if (typeof (this.timer as any).unref === "function") (this.timer as any).unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight drain finish (bounded by one batch).
    while (this.draining) await sleep(10);
  }

  /** Drain up to one batch of queue rows. Returns how many were processed. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const res = await this.client.execute({
        sql: `SELECT id, mount, path, op, attempts FROM index_queue
              ORDER BY enqueued_at ASC, id ASC
              LIMIT ?`,
        args: [this.batchSize],
      });
      if (res.rows.length === 0) return 0;

      for (const row of res.rows) {
        const id = Number(row.id);
        const mount = String(row.mount);
        const mountRelPath = String(row.path);
        const op = String(row.op) as "upsert" | "delete";
        try {
          if (op === "delete") {
            await this.sink.deleteChunks(mount, mountRelPath);
          } else {
            const live = await this.fetchLive(mount, mountRelPath);
            if (!live) {
              // File was deleted between enqueue and drain — treat as delete.
              await this.sink.deleteChunks(mount, mountRelPath);
            } else {
              await this.sink.upsertChunks(mount, mountRelPath, live.content, live.source);
            }
          }
          await this.client.execute({
            sql: `DELETE FROM index_queue WHERE id = ?`,
            args: [id],
          });
        } catch (err) {
          await this.client.execute({
            sql: `UPDATE index_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
            args: [truncate((err as Error).message ?? String(err), 500), id],
          });
        }
      }
      return res.rows.length;
    } finally {
      this.draining = false;
    }
  }

  /** Drain until the queue is empty. Test helper. */
  async drainAll(maxLoops = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxLoops; i++) {
      const n = await this.drain();
      total += n;
      if (n === 0) return total;
    }
    return total;
  }

  async queueSize(): Promise<number> {
    const r = await this.client.execute(`SELECT COUNT(*) AS n FROM index_queue`);
    return Number(r.rows[0].n ?? 0);
  }

  private async fetchLive(
    mount: string,
    mountRelPath: string
  ): Promise<{ content: string; source: string } | null> {
    const now = Date.now();
    const res = await this.client.execute({
      sql: `SELECT content, provenance FROM nodes
            WHERE mount = ? AND path = ? AND kind = 'file'
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)`,
      args: [mount, mountRelPath, now],
    });
    if (res.rows.length === 0) return null;
    const raw = res.rows[0].content;
    const bytes = toBytes(raw);
    const text = bytes ? Buffer.from(bytes).toString("utf-8") : "";
    let source = "agent";
    try {
      const prov = res.rows[0].provenance ? JSON.parse(String(res.rows[0].provenance)) : null;
      if (prov?.source) source = String(prov.source);
    } catch { /* ignore */ }
    return { content: text, source };
  }
}

function toBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
