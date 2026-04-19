/**
 * setup.ts — Build the libSQL client + writable mounts for createDocsVFS.
 *
 * Default layout (when memory is enabled):
 *   /docs/      — read-only DocsFileSystem (path_tree optimized)
 *   /memory/    — persistent writable store (no TTL)
 *   /workspace/ — writable scratch (24h TTL)
 *
 * The SQLite file lives at <rootDir>/.docsvfs.db unless a URL is passed.
 */

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { SCHEMA_SQL } from "./schema.js";
import { FreshMap } from "./fresh-map.js";
import { WritableFileSystem } from "./writable-fs.js";
import { IndexerHook } from "./async-indexer.js";

export interface MemorySetupOptions {
  /** Where to store the SQLite file. Defaults to <rootDir>/.docsvfs.db */
  dbUrl?: string;
  /** Session id for provenance. Defaults to a random UUID. */
  sessionId?: string;
  /** Override the root the db file lives under when dbUrl is not set */
  rootDir: string;
  /** When true, writes are enqueued for async Chroma indexing. */
  indexerEnabled?: boolean;
}

export interface MemorySetup {
  client: Client;
  sessionId: string;
  mounts: { mountPoint: string; filesystem: WritableFileSystem }[];
  indexerHook?: IndexerHook;
  close: () => void;
}

const MOUNTS: { mountPoint: string; defaultTtlMs: number | null }[] = [
  { mountPoint: "/memory", defaultTtlMs: null },
  { mountPoint: "/workspace", defaultTtlMs: 24 * 60 * 60 * 1000 },
];

export async function setupMemory(opts: MemorySetupOptions): Promise<MemorySetup> {
  const dbUrl = opts.dbUrl ?? `file:${path.join(opts.rootDir, ".docsvfs.db")}`;
  const sessionId = opts.sessionId ?? randomUUID();
  const client = createClient({ url: dbUrl });

  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }

  const indexerHook = opts.indexerEnabled ? new IndexerHook(client) : undefined;

  const mounts: MemorySetup["mounts"] = [];
  for (const { mountPoint, defaultTtlMs } of MOUNTS) {
    const fresh = new FreshMap();
    const fs = new WritableFileSystem({
      client,
      mount: mountPoint,
      defaultTtlMs,
      sessionId,
      fresh,
      indexer: indexerHook,
    });
    await fs.init();
    mounts.push({ mountPoint, filesystem: fs });
  }

  return {
    client,
    sessionId,
    mounts,
    indexerHook,
    close: () => client.close(),
  };
}
