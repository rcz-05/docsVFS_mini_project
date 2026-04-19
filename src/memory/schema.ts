/**
 * schema.ts — SQLite DDL for the writable mounts (libSQL/Turso compatible).
 *
 * One table (`nodes`) stores both files and directories. Provenance is a JSON
 * blob: { session_id, source: "agent"|"human"|"auto", note? }. `ttl_expires_at`
 * is NULL for persistent mounts and a unix ms for TTL'd mounts like /workspace.
 *
 * Paths are stored *absolute* (e.g. "/memory/notes/todo.md"), so a single
 * table serves every writable mount and queries stay simple.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  mount           TEXT NOT NULL,
  path            TEXT NOT NULL,
  parent          TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('file','dir')),
  content         BLOB,
  size            INTEGER NOT NULL DEFAULT 0,
  mode            INTEGER NOT NULL DEFAULT 420,
  provenance      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  ttl_expires_at  INTEGER,
  PRIMARY KEY (mount, path)
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent   ON nodes(parent);
CREATE INDEX IF NOT EXISTS idx_nodes_mount    ON nodes(mount);
CREATE INDEX IF NOT EXISTS idx_nodes_ttl      ON nodes(ttl_expires_at) WHERE ttl_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS index_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mount         TEXT NOT NULL,
  path          TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  enqueued_at   INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_enqueued ON index_queue(enqueued_at);
CREATE INDEX IF NOT EXISTS idx_queue_mount_path ON index_queue(mount, path);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

export interface Provenance {
  session_id: string;
  source: "agent" | "human" | "auto" | "tool";
  note?: string;
}

export interface NodeRow {
  path: string;
  parent: string;
  name: string;
  kind: "file" | "dir";
  content: Uint8Array | null;
  size: number;
  mode: number;
  mount: string;
  provenance: string | null;
  created_at: number;
  updated_at: number;
  ttl_expires_at: number | null;
}
