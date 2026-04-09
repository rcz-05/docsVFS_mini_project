/**
 * docs-fs.ts — DocsFileSystem: a read-only IFileSystem implementation
 * that presents a folder of documentation as a virtual filesystem.
 *
 * Architecture (mirrors Mintlify ChromaFS):
 *   - Boot: Scan real folder → build path_tree → cache to disk
 *   - ls/cd/find: Resolved from in-memory path_tree (zero I/O)
 *   - cat: Read from real filesystem, with LRU cache
 *   - grep: In-memory search (or Chroma coarse filter when enabled)
 *   - Writes: Throw EROFS (read-only filesystem)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  IFileSystem,
  FsStat,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
} from "just-bash";

/** DirentEntry (not re-exported from just-bash root) */
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** ReadFileOptions */
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

/** WriteFileOptions */
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
import { type PathTree, buildPathTree } from "./path-tree.js";

/** EROFS = Read-Only File System (errno 30 on Linux) */
class EROFSError extends Error {
  code = "EROFS";
  errno = -30;
  constructor(op: string, filePath: string) {
    super(`EROFS: read-only file system, ${op} '${filePath}'`);
    this.name = "EROFSError";
  }
}

/** ENOENT = No such file or directory */
class ENOENTError extends Error {
  code = "ENOENT";
  errno = -2;
  constructor(op: string, filePath: string) {
    super(`ENOENT: no such file or directory, ${op} '${filePath}'`);
    this.name = "ENOENTError";
  }
}

/** ENOTDIR = Not a directory */
class ENOTDIRError extends Error {
  code = "ENOTDIR";
  errno = -20;
  constructor(op: string, filePath: string) {
    super(`ENOTDIR: not a directory, ${op} '${filePath}'`);
    this.name = "ENOTDIRError";
  }
}

export interface DocsFileSystemOptions {
  /** Absolute path to the documentation root folder */
  rootDir: string;
  /** Pre-built path tree (skip scanning) */
  pathTree?: PathTree;
  /** Maximum number of file contents to keep in LRU cache */
  cacheSize?: number;
}

export class DocsFileSystem implements IFileSystem {
  private rootDir: string;
  private tree: PathTree;
  private contentCache = new Map<string, string>();
  private cacheOrder: string[] = [];
  private maxCacheSize: number;

  constructor(options: DocsFileSystemOptions) {
    this.rootDir = options.rootDir;
    this.tree = options.pathTree ?? buildPathTree(options.rootDir);
    this.maxCacheSize = options.cacheSize ?? 200;
  }

  /** Get the path tree (useful for serialization/caching) */
  getPathTree(): PathTree {
    return this.tree;
  }

  /** Get file count */
  getFileCount(): number {
    return this.tree.files.size;
  }

  // ─── Path helpers ─────────────────────────────────────────────

  private isFile(vPath: string): boolean {
    return this.tree.files.has(vPath);
  }

  private isDir(vPath: string): boolean {
    return this.tree.directories.has(vPath);
  }

  private pathExists(vPath: string): boolean {
    return this.isFile(vPath) || this.isDir(vPath);
  }

  /** Map virtual path → real filesystem path */
  private realPath(vPath: string): string {
    // vPath is like "/guides/onboarding.md", rootDir is "/home/user/docs"
    return path.join(this.rootDir, vPath);
  }

  // ─── LRU content cache ────────────────────────────────────────

  private cacheGet(vPath: string): string | undefined {
    const val = this.contentCache.get(vPath);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.cacheOrder = this.cacheOrder.filter((p) => p !== vPath);
      this.cacheOrder.push(vPath);
    }
    return val;
  }

  private cacheSet(vPath: string, content: string): void {
    if (this.contentCache.has(vPath)) {
      this.cacheOrder = this.cacheOrder.filter((p) => p !== vPath);
    }
    this.contentCache.set(vPath, content);
    this.cacheOrder.push(vPath);
    // Evict LRU if over limit
    while (this.cacheOrder.length > this.maxCacheSize) {
      const evict = this.cacheOrder.shift()!;
      this.contentCache.delete(evict);
    }
  }

  // ─── Read operations (the core of DocsVFS) ────────────────────

  async readFile(
    filePath: string,
    _options?: ReadFileOptions | BufferEncoding
  ): Promise<string> {
    const vPath = this.normalizePath(filePath);

    if (this.isDir(vPath)) {
      throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
    }
    if (!this.isFile(vPath)) {
      throw new ENOENTError("open", filePath);
    }

    // Check cache first
    const cached = this.cacheGet(vPath);
    if (cached !== undefined) return cached;

    // Read from real filesystem
    const realFilePath = this.realPath(vPath);
    try {
      const content = fs.readFileSync(realFilePath, "utf-8");
      this.cacheSet(vPath, content);
      return content;
    } catch {
      throw new ENOENTError("open", filePath);
    }
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const content = await this.readFile(filePath);
    return new TextEncoder().encode(content);
  }

  async exists(filePath: string): Promise<boolean> {
    const vPath = this.normalizePath(filePath);
    return this.pathExists(vPath);
  }

  async stat(filePath: string): Promise<FsStat> {
    const vPath = this.normalizePath(filePath);

    if (this.isDir(vPath)) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 4096,
        mtime: new Date(),
      };
    }

    if (this.isFile(vPath)) {
      const meta = this.tree.metadata.get(vPath);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o444, // read-only
        size: meta?.size ?? 0,
        mtime: meta?.mtime ?? new Date(),
      };
    }

    throw new ENOENTError("stat", filePath);
  }

  async lstat(filePath: string): Promise<FsStat> {
    // No symlinks in DocsVFS
    return this.stat(filePath);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const vPath = this.normalizePath(dirPath);

    if (this.isFile(vPath)) {
      throw new ENOTDIRError("scandir", dirPath);
    }

    const children = this.tree.directories.get(vPath);
    if (!children) {
      throw new ENOENTError("scandir", dirPath);
    }

    return [...children].sort();
  }

  async readdirWithFileTypes(dirPath: string): Promise<DirentEntry[]> {
    const vPath = this.normalizePath(dirPath);
    const children = this.tree.directories.get(vPath);
    if (!children) {
      throw new ENOENTError("scandir", dirPath);
    }

    return children.sort().map((name) => {
      const childPath = vPath === "/" ? `/${name}` : `${vPath}/${name}`;
      return {
        name,
        isFile: this.isFile(childPath),
        isDirectory: this.isDir(childPath),
        isSymbolicLink: false,
      };
    });
  }

  // ─── Path resolution ──────────────────────────────────────────

  resolvePath(base: string, relPath: string): string {
    if (relPath.startsWith("/")) return path.posix.normalize(relPath);
    return path.posix.normalize(path.posix.join(base, relPath));
  }

  getAllPaths(): string[] {
    const paths: string[] = [];
    for (const dir of this.tree.directories.keys()) {
      paths.push(dir);
    }
    for (const file of this.tree.files) {
      paths.push(file);
    }
    return paths;
  }

  async realpath(filePath: string): Promise<string> {
    const vPath = this.normalizePath(filePath);
    if (!this.pathExists(vPath)) {
      throw new ENOENTError("realpath", filePath);
    }
    return vPath;
  }

  // ─── Write operations (all throw EROFS) ────────────────────────

  async writeFile(
    filePath: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    throw new EROFSError("write", filePath);
  }

  async appendFile(
    filePath: string,
    _content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    throw new EROFSError("append", filePath);
  }

  async mkdir(dirPath: string, _options?: MkdirOptions): Promise<void> {
    throw new EROFSError("mkdir", dirPath);
  }

  async rm(filePath: string, _options?: RmOptions): Promise<void> {
    throw new EROFSError("unlink", filePath);
  }

  async cp(
    _src: string,
    dest: string,
    _options?: CpOptions
  ): Promise<void> {
    throw new EROFSError("cp", dest);
  }

  async mv(_src: string, dest: string): Promise<void> {
    throw new EROFSError("rename", dest);
  }

  async chmod(filePath: string, _mode: number): Promise<void> {
    throw new EROFSError("chmod", filePath);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new EROFSError("symlink", linkPath);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw new EROFSError("link", newPath);
  }

  async readlink(filePath: string): Promise<string> {
    throw new Error(`EINVAL: invalid argument, readlink '${filePath}'`);
  }

  async utimes(filePath: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new EROFSError("utimes", filePath);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private normalizePath(p: string): string {
    const normalized = path.posix.normalize(p);
    if (normalized === ".") return "/";
    if (!normalized.startsWith("/")) return "/" + normalized;
    // Remove trailing slash unless root
    if (normalized.length > 1 && normalized.endsWith("/")) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }
}
