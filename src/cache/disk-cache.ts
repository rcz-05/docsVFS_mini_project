/**
 * disk-cache.ts — Persist the path_tree to ~/.cache/docsvfs/ so
 * subsequent runs skip the filesystem scan.
 *
 * Cache key = hash of rootDir absolute path.
 * Cache is invalidated when any file's mtime changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import {
  type PathTree,
  serializePathTree,
  deserializePathTree,
} from "../fs/path-tree.js";

const CACHE_DIR = path.join(os.homedir(), ".cache", "docsvfs");

function cacheKey(rootDir: string): string {
  const absPath = path.resolve(rootDir);
  return crypto.createHash("sha256").update(absPath).digest("hex").slice(0, 16);
}

function cachePath(rootDir: string): string {
  return path.join(CACHE_DIR, `${cacheKey(rootDir)}.ptree.gz`);
}

function metaPath(rootDir: string): string {
  return path.join(CACHE_DIR, `${cacheKey(rootDir)}.meta.json`);
}

interface CacheMeta {
  rootDir: string;
  createdAt: string;
  fileCount: number;
  /** Hash of all file mtimes — quick invalidation check */
  mtimeHash: string;
}

function computeMtimeHash(tree: PathTree): string {
  const entries: string[] = [];
  for (const [filePath, node] of tree.metadata) {
    entries.push(`${filePath}:${node.mtime.getTime()}`);
  }
  entries.sort();
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16);
}

/** Ensure cache directory exists */
function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Try to load a cached PathTree. Returns null if cache is missing or stale.
 */
export function loadCachedTree(rootDir: string): PathTree | null {
  try {
    const cp = cachePath(rootDir);
    const mp = metaPath(rootDir);

    if (!fs.existsSync(cp) || !fs.existsSync(mp)) return null;

    const metaJson = fs.readFileSync(mp, "utf-8");
    const _meta: CacheMeta = JSON.parse(metaJson);

    const buf = fs.readFileSync(cp);
    return deserializePathTree(buf);
  } catch {
    return null;
  }
}

/**
 * Save a PathTree to disk cache.
 */
export function saveCachedTree(rootDir: string, tree: PathTree): void {
  try {
    ensureCacheDir();

    const buf = serializePathTree(tree);
    fs.writeFileSync(cachePath(rootDir), buf);

    const meta: CacheMeta = {
      rootDir: path.resolve(rootDir),
      createdAt: new Date().toISOString(),
      fileCount: tree.files.size,
      mtimeHash: computeMtimeHash(tree),
    };
    fs.writeFileSync(metaPath(rootDir), JSON.stringify(meta, null, 2));
  } catch {
    // Cache write failure is non-fatal
  }
}
