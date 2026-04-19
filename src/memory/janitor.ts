/**
 * janitor.ts — Provenance-aware cleanup for the writable layer.
 *
 * Four actions, always in this order:
 *   1. Prune rows whose ttl_expires_at has passed (always safe)
 *   2. Exact-hash dedup within each mount (keep oldest, drop copies)
 *   3. Flag stale agent-only writes (report; delete only when aggressive)
 *   4. VACUUM to reclaim space
 *
 * v1 deliberately uses *exact* SHA-256 matching for dedup. Fuzzy/semantic
 * dedup is deferred until the async Chroma indexer lands — we'd rather
 * miss a near-duplicate than silently merge two similar-but-distinct notes.
 */

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export interface JanitorOptions {
  /** Treat stale-write threshold as this many ms; defaults to 24h */
  olderThanMs?: number;
  /** Only operate on these mounts; defaults to all writable mounts in DB */
  mounts?: string[];
  /** Don't write any changes, just report */
  dryRun?: boolean;
  /** Also delete flagged stale agent-only writes */
  aggressive?: boolean;
  /** Override "now" for tests */
  now?: number;
  /** Override the 5-attempts-then-report threshold for the queue report */
  deadLetterAttempts?: number;
}

export interface JanitorReport {
  prunedExpired: { mount: string; path: string }[];
  deduped: { mount: string; keptPath: string; removedPaths: string[] }[];
  flaggedStale: { mount: string; path: string; ageHours: number; deleted: boolean }[];
  queueStuck: { mount: string; path: string; attempts: number; lastError: string | null }[];
  vacuumed: boolean;
  dryRun: boolean;
  durationMs: number;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEAD_LETTER_ATTEMPTS = 5;

export async function runJanitor(
  client: Client,
  options: JanitorOptions = {}
): Promise<JanitorReport> {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const olderThan = options.olderThanMs ?? DEFAULT_STALE_MS;
  const dryRun = options.dryRun ?? false;
  const aggressive = options.aggressive ?? false;
  const deadLetterAttempts = options.deadLetterAttempts ?? DEFAULT_DEAD_LETTER_ATTEMPTS;

  const mountFilter = options.mounts && options.mounts.length
    ? { sql: `AND mount IN (${options.mounts.map(() => "?").join(",")})`, args: options.mounts }
    : { sql: "", args: [] as string[] };

  const report: JanitorReport = {
    prunedExpired: [],
    deduped: [],
    flaggedStale: [],
    queueStuck: [],
    vacuumed: false,
    dryRun,
    durationMs: 0,
  };

  // ─── Action 1: prune expired rows ─────────────────────────────
  {
    const res = await client.execute({
      sql: `SELECT mount, path FROM nodes
            WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at < ?
              ${mountFilter.sql}`,
      args: [now, ...mountFilter.args],
    });
    report.prunedExpired = res.rows.map((r) => ({
      mount: String(r.mount),
      path: String(r.path),
    }));
    if (!dryRun && report.prunedExpired.length > 0) {
      await client.execute({
        sql: `DELETE FROM nodes
              WHERE ttl_expires_at IS NOT NULL AND ttl_expires_at < ?
                ${mountFilter.sql}`,
        args: [now, ...mountFilter.args],
      });
    }
  }

  // ─── Action 2: exact-hash dedup within each mount ─────────────
  {
    // Pull every live file row; hash client-side (SQLite lacks SHA-256 builtin).
    const res = await client.execute({
      sql: `SELECT mount, path, created_at, content
            FROM nodes
            WHERE kind = 'file' AND content IS NOT NULL
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
              ${mountFilter.sql}`,
      args: [now, ...mountFilter.args],
    });

    // Group by (mount, content-hash); keep oldest created_at.
    type Entry = { mount: string; path: string; created_at: number };
    const groups = new Map<string, Entry[]>();
    for (const r of res.rows) {
      const mount = String(r.mount);
      const buf = toBytes(r.content);
      if (!buf || buf.byteLength === 0) continue; // empty files aren't interesting
      const hash = createHash("sha256").update(buf).digest("hex");
      const key = `${mount}\u0000${hash}`;
      const arr = groups.get(key) ?? [];
      arr.push({
        mount,
        path: String(r.path),
        created_at: Number(r.created_at),
      });
      groups.set(key, arr);
    }

    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      entries.sort((a, b) => a.created_at - b.created_at);
      const [keeper, ...dupes] = entries;
      report.deduped.push({
        mount: keeper.mount,
        keptPath: keeper.path,
        removedPaths: dupes.map((d) => d.path),
      });
      if (!dryRun) {
        for (const dup of dupes) {
          await client.execute({
            sql: `DELETE FROM nodes WHERE mount = ? AND path = ?`,
            args: [dup.mount, dup.path],
          });
        }
      }
    }
  }

  // ─── Action 3: flag stale agent-only writes ───────────────────
  {
    const staleCutoff = now - olderThan;
    const res = await client.execute({
      sql: `SELECT mount, path, updated_at, provenance
            FROM nodes
            WHERE kind = 'file'
              AND updated_at < ?
              AND created_at = updated_at
              AND provenance IS NOT NULL
              AND json_extract(provenance, '$.source') = 'agent'
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
              ${mountFilter.sql}`,
      args: [staleCutoff, now, ...mountFilter.args],
    });

    for (const r of res.rows) {
      const ageMs = now - Number(r.updated_at);
      const entry = {
        mount: String(r.mount),
        path: String(r.path),
        ageHours: Math.round(ageMs / (60 * 60 * 1000) * 10) / 10,
        deleted: false,
      };
      if (aggressive && !dryRun) {
        await client.execute({
          sql: `DELETE FROM nodes WHERE mount = ? AND path = ?`,
          args: [entry.mount, entry.path],
        });
        entry.deleted = true;
      }
      report.flaggedStale.push(entry);
    }
  }

  // ─── Report: stuck items in the async index queue ─────────────
  // Non-destructive; just surfaces rows that have failed repeatedly so the
  // operator can investigate. Gracefully no-ops if index_queue doesn't exist.
  try {
    const res = await client.execute({
      sql: `SELECT mount, path, attempts, last_error
            FROM index_queue
            WHERE attempts >= ?
            ORDER BY attempts DESC, enqueued_at ASC
            LIMIT 100`,
      args: [deadLetterAttempts],
    });
    report.queueStuck = res.rows.map((r) => ({
      mount: String(r.mount),
      path: String(r.path),
      attempts: Number(r.attempts),
      lastError: r.last_error == null ? null : String(r.last_error),
    }));
  } catch {
    // index_queue table not created yet (Phase 2.2 not active); skip silently.
  }

  // ─── Action 4: VACUUM ─────────────────────────────────────────
  if (!dryRun) {
    await client.execute("VACUUM");
    report.vacuumed = true;
  }

  report.durationMs = Math.round(performance.now() - started);
  return report;
}

/** libSQL returns BLOBs as ArrayBuffer; normalize to Uint8Array. */
function toBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

/** Pretty-print a JanitorReport for humans. Returns a single string. */
export function formatJanitorReport(r: JanitorReport): string {
  const lines: string[] = [];
  const header = r.dryRun ? "janitor [dry run]" : "janitor";
  lines.push(`${header} — ${r.durationMs}ms${r.vacuumed ? ", VACUUMed" : ""}`);

  if (r.prunedExpired.length === 0) {
    lines.push("  expired:    0");
  } else {
    lines.push(`  expired:    ${r.prunedExpired.length} ${r.dryRun ? "would be pruned" : "pruned"}`);
    for (const e of r.prunedExpired.slice(0, 5)) lines.push(`    - ${e.mount}${e.path}`);
    if (r.prunedExpired.length > 5) lines.push(`    … and ${r.prunedExpired.length - 5} more`);
  }

  if (r.deduped.length === 0) {
    lines.push("  duplicates: 0");
  } else {
    const dupCount = r.deduped.reduce((n, d) => n + d.removedPaths.length, 0);
    lines.push(`  duplicates: ${dupCount} ${r.dryRun ? "would be merged" : "merged"} into ${r.deduped.length} canonical`);
    for (const d of r.deduped.slice(0, 5)) {
      lines.push(`    - kept ${d.mount}${d.keptPath}`);
      for (const p of d.removedPaths.slice(0, 3)) lines.push(`        dropped ${d.mount}${p}`);
    }
  }

  if (r.flaggedStale.length === 0) {
    lines.push("  flagged:    0 stale agent-only writes");
  } else {
    lines.push(`  flagged:    ${r.flaggedStale.length} stale agent-only writes`);
    for (const f of r.flaggedStale.slice(0, 10)) {
      const tag = f.deleted ? "[deleted]" : "[review]";
      lines.push(`    ${tag} ${f.mount}${f.path}  (${f.ageHours}h old)`);
    }
  }

  if (r.queueStuck.length > 0) {
    lines.push(`  index queue: ${r.queueStuck.length} entries stuck (>= retry threshold)`);
    for (const q of r.queueStuck.slice(0, 5)) {
      lines.push(`    - ${q.mount}${q.path}  attempts=${q.attempts}${q.lastError ? `  err="${q.lastError.slice(0, 60)}"` : ""}`);
    }
  }

  return lines.join("\n");
}
