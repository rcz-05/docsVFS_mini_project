/**
 * path-tree.ts — In-memory path tree for instant ls/cd/find resolution.
 *
 * Inspired by Mintlify's ChromaFS __path_tree__: a gzipped JSON mapping of
 * every page slug to metadata, decompressed once on boot into two structures:
 *   1. A Set<string> of all file paths
 *   2. A Map<string, string[]> mapping directories → children
 *
 * This enables ls, cd, and find to resolve instantly with zero I/O.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

export interface PathNode {
  /** Relative path from root (e.g. "guides/onboarding.md") */
  slug: string;
  /** Size in bytes */
  size: number;
  /** Last modification time */
  mtime: Date;
}

export interface PathTree {
  /** Every known file path (relative to root) */
  files: Set<string>;
  /** Every known directory path → child names */
  directories: Map<string, string[]>;
  /** Metadata per file */
  metadata: Map<string, PathNode>;
}

/** File extensions to include when scanning a docs folder */
const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".html",
  ".htm",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

/**
 * Recursively scan a real directory and build a PathTree.
 */
export function buildPathTree(rootDir: string): PathTree {
  const files = new Set<string>();
  const directories = new Map<string, string[]>();
  const metadata = new Map<string, PathNode>();

  // Root directory always exists
  directories.set("/", []);

  function scan(dir: string, virtualDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const children: string[] = [];

    for (const entry of entries) {
      // Skip hidden files/dirs and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const realPath = path.join(dir, entry.name);
      const vPath = virtualDir === "/" ? `/${entry.name}` : `${virtualDir}/${entry.name}`;

      if (entry.isDirectory()) {
        children.push(entry.name);
        directories.set(vPath, []);
        scan(realPath, vPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (DOC_EXTENSIONS.has(ext)) {
          children.push(entry.name);
          files.add(vPath);
          try {
            const stat = fs.statSync(realPath);
            metadata.set(vPath, {
              slug: vPath.slice(1), // remove leading /
              size: stat.size,
              mtime: stat.mtime,
            });
          } catch {
            metadata.set(vPath, {
              slug: vPath.slice(1),
              size: 0,
              mtime: new Date(),
            });
          }
        }
      }
    }

    // Update parent's children
    if (directories.has(virtualDir)) {
      const existing = directories.get(virtualDir)!;
      existing.push(...children);
    }
  }

  scan(rootDir, "/");

  // Remove empty directories (that had no doc files in them)
  for (const [dir, children] of directories) {
    if (dir !== "/" && children.length === 0) {
      // Check if any file is beneath this directory
      let hasContent = false;
      for (const f of files) {
        if (f.startsWith(dir + "/")) {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) {
        directories.delete(dir);
        // Remove from parent's children too
        const parentDir = path.posix.dirname(dir);
        const parentChildren = directories.get(parentDir);
        if (parentChildren) {
          const idx = parentChildren.indexOf(path.posix.basename(dir));
          if (idx !== -1) parentChildren.splice(idx, 1);
        }
      }
    }
  }

  return { files, directories, metadata };
}

/**
 * Serialize a PathTree to a gzipped JSON buffer (for disk caching).
 */
export function serializePathTree(tree: PathTree): Buffer {
  const obj: Record<string, { size: number; mtime: string }> = {};
  for (const [filePath, node] of tree.metadata) {
    obj[filePath] = { size: node.size, mtime: node.mtime.toISOString() };
  }
  const json = JSON.stringify(obj);
  return zlib.gzipSync(Buffer.from(json));
}

/**
 * Deserialize a gzipped JSON buffer back into a PathTree.
 */
export function deserializePathTree(buf: Buffer): PathTree {
  const json = zlib.gunzipSync(buf).toString("utf-8");
  const obj: Record<string, { size: number; mtime: string }> = JSON.parse(json);

  const files = new Set<string>();
  const directories = new Map<string, string[]>();
  const metadata = new Map<string, PathNode>();

  directories.set("/", []);

  for (const [filePath, meta] of Object.entries(obj)) {
    files.add(filePath);
    metadata.set(filePath, {
      slug: filePath.slice(1),
      size: meta.size,
      mtime: new Date(meta.mtime),
    });

    // Rebuild directory structure
    const parts = filePath.split("/").filter(Boolean);
    let currentDir = "/";
    for (let i = 0; i < parts.length - 1; i++) {
      const nextDir = currentDir === "/" ? `/${parts[i]}` : `${currentDir}/${parts[i]}`;
      if (!directories.has(nextDir)) {
        directories.set(nextDir, []);
        // Add to parent
        const parentChildren = directories.get(currentDir);
        if (parentChildren && !parentChildren.includes(parts[i])) {
          parentChildren.push(parts[i]);
        }
      }
      currentDir = nextDir;
    }
    // Add file to its parent directory
    const fileName = parts[parts.length - 1];
    const parentDir = parts.length === 1 ? "/" : "/" + parts.slice(0, -1).join("/");
    const parentChildren = directories.get(parentDir);
    if (parentChildren && !parentChildren.includes(fileName)) {
      parentChildren.push(fileName);
    }
  }

  return { files, directories, metadata };
}
