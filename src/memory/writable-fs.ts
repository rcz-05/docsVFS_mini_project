/**
 * writable-fs.ts — libSQL-backed IFileSystem for the writable mounts.
 *
 * One instance per mount (e.g. /memory, /workspace). All rows share one DB
 * file and are partitioned by the `mount` column so the janitor can operate
 * per-mount without per-mount files.
 *
 * Paths at this layer are *relative to the mount point*. MountableFs strips
 * the mount prefix before routing, so /memory/notes/todo.md arrives here
 * as /notes/todo.md. We store the mount-relative path in the DB.
 *
 * Reads: consult FreshMap first (read-your-writes), fall back to SQLite.
 * Writes: update SQLite + FreshMap synchronously. Provenance is recorded
 * on every mutation so `docsvfs janitor` can prune agent-only garbage later.
 */

import * as path from "node:path";
import type { Client } from "@libsql/client";
import type {
  IFileSystem,
  FsStat,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
} from "just-bash";

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
interface ReadFileOptions { encoding?: BufferEncoding | null }
interface WriteFileOptions { encoding?: BufferEncoding }
import { FreshMap } from "./fresh-map.js";
import type { Provenance } from "./schema.js";

class FsError extends Error {
  constructor(public code: string, op: string, filePath: string, msg: string) {
    super(`${code}: ${msg}, ${op} '${filePath}'`);
    this.name = `${code}Error`;
  }
}
/** libSQL returns BLOBs as ArrayBuffer; normalize to Uint8Array (or null). */
function toBytes(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

const enoent = (op: string, p: string) =>
  new FsError("ENOENT", op, p, "no such file or directory");
const enotdir = (op: string, p: string) =>
  new FsError("ENOTDIR", op, p, "not a directory");
const eisdir = (op: string, p: string) =>
  new FsError("EISDIR", op, p, "illegal operation on a directory");
const eexist = (op: string, p: string) =>
  new FsError("EEXIST", op, p, "file already exists");
const enotempty = (op: string, p: string) =>
  new FsError("ENOTEMPTY", op, p, "directory not empty");

export interface WritableFileSystemOptions {
  /** libSQL client shared across mounts */
  client: Client;
  /** Mount name (e.g. "/memory"), used as partition key in the DB */
  mount: string;
  /** Default TTL for new files, in ms. null = no TTL. */
  defaultTtlMs?: number | null;
  /** Session id tagged on every write's provenance */
  sessionId: string;
  /** Shared fresh-map (scoped to this mount) */
  fresh?: FreshMap;
}

export class WritableFileSystem implements IFileSystem {
  private client: Client;
  private mount: string;
  private defaultTtlMs: number | null;
  private sessionId: string;
  private fresh: FreshMap;

  constructor(opts: WritableFileSystemOptions) {
    this.client = opts.client;
    this.mount = opts.mount;
    this.defaultTtlMs = opts.defaultTtlMs ?? null;
    this.sessionId = opts.sessionId;
    this.fresh = opts.fresh ?? new FreshMap();
  }

  /** Ensure the root directory row exists for this mount. */
  async init(): Promise<void> {
    const now = Date.now();
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO nodes
            (mount, path, parent, name, kind, content, size, mode, provenance, created_at, updated_at, ttl_expires_at)
            VALUES (?, ?, ?, ?, 'dir', NULL, 0, ?, ?, ?, ?, NULL)`,
      args: [
        this.mount,
        "/",
        "",
        "",
        0o755,
        JSON.stringify({ session_id: this.sessionId, source: "auto" } satisfies Provenance),
        now,
        now,
      ],
    });
  }

  // ─── path helpers ─────────────────────────────────────────────

  private normalize(p: string): string {
    const n = path.posix.normalize(p);
    if (n === ".") return "/";
    if (!n.startsWith("/")) return "/" + n;
    if (n.length > 1 && n.endsWith("/")) return n.slice(0, -1);
    return n;
  }

  private parentOf(p: string): string {
    if (p === "/") return "";
    return path.posix.dirname(p);
  }

  private basenameOf(p: string): string {
    if (p === "/") return "";
    return path.posix.basename(p);
  }

  // ─── DB helpers ───────────────────────────────────────────────

  private async fetchNode(p: string): Promise<{
    kind: "file" | "dir";
    content: Uint8Array | null;
    size: number;
    mode: number;
    mtime: Date;
  } | null> {
    const now = Date.now();
    const res = await this.client.execute({
      sql: `SELECT kind, content, size, mode, updated_at
            FROM nodes
            WHERE mount = ? AND path = ?
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)`,
      args: [this.mount, p, now],
    });
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      kind: r.kind as "file" | "dir",
      content: toBytes(r.content),
      size: Number(r.size ?? 0),
      mode: Number(r.mode ?? 0o644),
      mtime: new Date(Number(r.updated_at)),
    };
  }

  private async ensureParent(filePath: string, op: string): Promise<void> {
    const parent = this.parentOf(filePath);
    if (parent === "") return;
    const node = await this.fetchNode(parent);
    if (!node) throw enoent(op, filePath);
    if (node.kind !== "dir") throw enotdir(op, filePath);
  }

  // ─── Read operations ──────────────────────────────────────────

  async readFile(filePath: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const p = this.normalize(filePath);
    const encoding = typeof options === "string" ? options : options?.encoding ?? "utf-8";

    const fresh = this.fresh.get(p);
    if (fresh) {
      if (fresh.kind === "tombstone") throw enoent("open", filePath);
      if (fresh.kind === "dir") throw eisdir(filePath, filePath);
      const buf = fresh.content ?? new Uint8Array();
      return Buffer.from(buf).toString((encoding ?? "utf-8") as BufferEncoding);
    }

    const node = await this.fetchNode(p);
    if (!node) throw enoent("open", filePath);
    if (node.kind === "dir") throw eisdir("read", filePath);
    const buf = node.content ?? new Uint8Array();
    return Buffer.from(buf).toString((encoding ?? "utf-8") as BufferEncoding);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const p = this.normalize(filePath);
    const fresh = this.fresh.get(p);
    if (fresh) {
      if (fresh.kind === "tombstone") throw enoent("open", filePath);
      if (fresh.kind === "dir") throw eisdir("read", filePath);
      return fresh.content ?? new Uint8Array();
    }
    const node = await this.fetchNode(p);
    if (!node) throw enoent("open", filePath);
    if (node.kind === "dir") throw eisdir("read", filePath);
    return node.content ?? new Uint8Array();
  }

  async exists(filePath: string): Promise<boolean> {
    const p = this.normalize(filePath);
    const fresh = this.fresh.get(p);
    if (fresh) return fresh.kind !== "tombstone";
    const node = await this.fetchNode(p);
    return node !== null;
  }

  async stat(filePath: string): Promise<FsStat> {
    const p = this.normalize(filePath);
    const fresh = this.fresh.get(p);
    if (fresh && fresh.kind !== "tombstone") {
      return {
        isFile: fresh.kind === "file",
        isDirectory: fresh.kind === "dir",
        isSymbolicLink: false,
        mode: fresh.kind === "dir" ? 0o755 : 0o644,
        size: fresh.content?.byteLength ?? 0,
        mtime: new Date(fresh.ts),
      };
    }
    const node = await this.fetchNode(p);
    if (!node) throw enoent("stat", filePath);
    return {
      isFile: node.kind === "file",
      isDirectory: node.kind === "dir",
      isSymbolicLink: false,
      mode: node.mode,
      size: node.size,
      mtime: node.mtime,
    };
  }

  async lstat(filePath: string): Promise<FsStat> {
    return this.stat(filePath);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const p = this.normalize(dirPath);
    const node = await this.fetchNode(p);
    if (!node) throw enoent("scandir", dirPath);
    if (node.kind !== "dir") throw enotdir("scandir", dirPath);
    const now = Date.now();
    const res = await this.client.execute({
      sql: `SELECT name FROM nodes
            WHERE mount = ? AND parent = ? AND path != ?
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
            ORDER BY name`,
      args: [this.mount, p, p, now],
    });
    return res.rows.map((r) => String(r.name));
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const p = this.normalize(dirPath);
    const node = await this.fetchNode(p);
    if (!node) throw enoent("scandir", dirPath);
    if (node.kind !== "dir") throw enotdir("scandir", dirPath);
    const now = Date.now();
    const res = await this.client.execute({
      sql: `SELECT name, kind FROM nodes
            WHERE mount = ? AND parent = ? AND path != ?
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
            ORDER BY name`,
      args: [this.mount, p, p, now],
    });
    return res.rows.map((r) => ({
      name: String(r.name),
      isFile: r.kind === "file",
      isDirectory: r.kind === "dir",
      isSymbolicLink: false,
    }));
  }

  resolvePath(base: string, relPath: string): string {
    if (relPath.startsWith("/")) return path.posix.normalize(relPath);
    return path.posix.normalize(path.posix.join(base, relPath));
  }

  async getAllPathsAsync(): Promise<string[]> {
    const now = Date.now();
    const res = await this.client.execute({
      sql: `SELECT path FROM nodes
            WHERE mount = ?
              AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)`,
      args: [this.mount, now],
    });
    return res.rows.map((r) => String(r.path));
  }

  getAllPaths(): string[] {
    // Sync signature required by IFileSystem. We return an empty list;
    // glob matching against writable mounts can be added later if needed.
    return [];
  }

  async realpath(filePath: string): Promise<string> {
    const p = this.normalize(filePath);
    const node = await this.fetchNode(p);
    if (!node) throw enoent("realpath", filePath);
    return p;
  }

  // ─── Write operations ─────────────────────────────────────────

  async writeFile(
    filePath: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const p = this.normalize(filePath);
    if (p === "/") throw eisdir("write", filePath);
    await this.ensureParent(p, "write");

    const existing = await this.fetchNode(p);
    if (existing?.kind === "dir") throw eisdir("write", filePath);

    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const now = Date.now();
    const ttl = this.defaultTtlMs === null ? null : now + this.defaultTtlMs;
    const provenance = JSON.stringify({
      session_id: this.sessionId,
      source: "agent",
    } satisfies Provenance);

    await this.client.execute({
      sql: `INSERT INTO nodes (mount, path, parent, name, kind, content, size, mode, provenance, created_at, updated_at, ttl_expires_at)
            VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(mount, path) DO UPDATE SET
              content = excluded.content,
              size = excluded.size,
              mode = excluded.mode,
              provenance = excluded.provenance,
              updated_at = excluded.updated_at,
              ttl_expires_at = excluded.ttl_expires_at`,
      args: [
        this.mount,
        p,
        this.parentOf(p),
        this.basenameOf(p),
        buf,
        buf.byteLength,
        0o644,
        provenance,
        now,
        now,
        ttl,
      ],
    });

    this.fresh.set(p, { kind: "file", content: buf });
  }

  async appendFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const p = this.normalize(filePath);
    const existing = await this.fetchNode(p);
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (existing?.kind === "dir") throw eisdir("append", filePath);
    const prev = existing?.content ?? new Uint8Array();
    const merged = new Uint8Array(prev.byteLength + buf.byteLength);
    merged.set(prev, 0);
    merged.set(buf, prev.byteLength);
    await this.writeFile(filePath, merged, options);
  }

  async mkdir(dirPath: string, options?: MkdirOptions): Promise<void> {
    const p = this.normalize(dirPath);
    if (p === "/") return;
    const existing = await this.fetchNode(p);
    if (existing) {
      if (existing.kind === "dir" && options?.recursive) return;
      throw eexist("mkdir", dirPath);
    }
    const parent = this.parentOf(p);
    const parentNode = parent === "" ? null : await this.fetchNode(parent);
    if (parent !== "" && !parentNode) {
      if (options?.recursive) {
        await this.mkdir(parent, options);
      } else {
        throw enoent("mkdir", dirPath);
      }
    } else if (parentNode && parentNode.kind !== "dir") {
      throw enotdir("mkdir", dirPath);
    }
    const now = Date.now();
    const ttl = this.defaultTtlMs === null ? null : now + this.defaultTtlMs;
    const provenance = JSON.stringify({
      session_id: this.sessionId,
      source: "agent",
    } satisfies Provenance);
    await this.client.execute({
      sql: `INSERT INTO nodes (mount, path, parent, name, kind, content, size, mode, provenance, created_at, updated_at, ttl_expires_at)
            VALUES (?, ?, ?, ?, 'dir', NULL, 0, ?, ?, ?, ?, ?)`,
      args: [
        this.mount,
        p,
        this.parentOf(p),
        this.basenameOf(p),
        0o755,
        provenance,
        now,
        now,
        ttl,
      ],
    });
    this.fresh.set(p, { kind: "dir", content: null });
  }

  async rm(filePath: string, options?: RmOptions): Promise<void> {
    const p = this.normalize(filePath);
    if (p === "/") throw new FsError("EPERM", "unlink", filePath, "operation not permitted");
    const node = await this.fetchNode(p);
    if (!node) {
      if (options?.force) return;
      throw enoent("unlink", filePath);
    }
    if (node.kind === "dir") {
      const res = await this.client.execute({
        sql: `SELECT COUNT(*) as c FROM nodes
              WHERE mount = ? AND parent = ? AND path != ?`,
        args: [this.mount, p, p],
      });
      const count = Number(res.rows[0].c ?? 0);
      if (count > 0 && !options?.recursive) throw enotempty("rmdir", filePath);
      await this.client.execute({
        sql: `DELETE FROM nodes WHERE mount = ? AND (path = ? OR path LIKE ?)`,
        args: [this.mount, p, p === "/" ? "/%" : `${p}/%`],
      });
    } else {
      await this.client.execute({
        sql: `DELETE FROM nodes WHERE mount = ? AND path = ?`,
        args: [this.mount, p],
      });
    }
    this.fresh.set(p, { kind: "tombstone", content: null });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const sp = this.normalize(src);
    const dp = this.normalize(dest);
    const node = await this.fetchNode(sp);
    if (!node) throw enoent("copy", src);
    if (node.kind === "dir") {
      if (!options?.recursive) {
        throw new FsError("EISDIR", "copy", src, "source is a directory, use recursive");
      }
      await this.mkdir(dp, { recursive: true });
      const children = await this.readdir(sp);
      for (const name of children) {
        await this.cp(path.posix.join(sp, name), path.posix.join(dp, name), options);
      }
    } else {
      const buf = node.content ?? new Uint8Array();
      await this.writeFile(dp, buf);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const p = this.normalize(filePath);
    const node = await this.fetchNode(p);
    if (!node) throw enoent("chmod", filePath);
    await this.client.execute({
      sql: `UPDATE nodes SET mode = ?, updated_at = ? WHERE mount = ? AND path = ?`,
      args: [mode, Date.now(), this.mount, p],
    });
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new FsError("ENOSYS", "symlink", linkPath, "symlinks not supported");
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw new FsError("ENOSYS", "link", newPath, "hard links not supported");
  }

  async readlink(filePath: string): Promise<string> {
    throw new FsError("EINVAL", "readlink", filePath, "not a symlink");
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const p = this.normalize(filePath);
    const node = await this.fetchNode(p);
    if (!node) throw enoent("utimes", filePath);
    await this.client.execute({
      sql: `UPDATE nodes SET updated_at = ? WHERE mount = ? AND path = ?`,
      args: [mtime.getTime(), this.mount, p],
    });
  }
}
