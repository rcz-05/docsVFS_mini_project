/**
 * create.ts — Factory function that wires up DocsFileSystem + just-bash + caching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Bash } from "just-bash";
import { DocsFileSystem } from "./fs/docs-fs.js";
import { buildPathTree } from "./fs/path-tree.js";
import { loadCachedTree, saveCachedTree } from "./cache/disk-cache.js";
import { InMemorySearchIndex, ChromaSearchIndex } from "./chroma/chroma-backend.js";

export interface DocsVFSOptions {
  /** Path to the documentation root folder */
  rootDir: string;
  /** Enable Chroma integration for semantic search */
  chroma?: boolean;
  /** Chroma server URL (default: http://localhost:8000) */
  chromaUrl?: string;
  /** Chroma collection name (default: "docsvfs") */
  chromaCollection?: string;
  /** Skip disk cache */
  noCache?: boolean;
  /** Maximum content cache size */
  cacheSize?: number;
}

export interface DocsVFSInstance {
  /** The just-bash shell instance */
  bash: InstanceType<typeof Bash>;
  /** The virtual filesystem */
  fs: DocsFileSystem;
  /** Search index (in-memory or Chroma) */
  searchIndex: InMemorySearchIndex | ChromaSearchIndex;
  /** Execute a bash command */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Summary stats */
  stats: {
    fileCount: number;
    dirCount: number;
    chunkCount: number;
    bootTimeMs: number;
  };
}

/**
 * Create a DocsVFS instance — the main entry point.
 *
 * @example
 * ```ts
 * const vfs = await createDocsVFS({ rootDir: "./docs" });
 * const result = await vfs.exec('tree /');
 * console.log(result.stdout);
 * ```
 */
export async function createDocsVFS(
  options: DocsVFSOptions
): Promise<DocsVFSInstance> {
  const startTime = performance.now();
  const rootDir = path.resolve(options.rootDir);

  if (!fs.existsSync(rootDir)) {
    throw new Error(`Documentation root not found: ${rootDir}`);
  }

  // Step 1: Build or load the path tree
  let pathTree = options.noCache ? null : loadCachedTree(rootDir);
  if (!pathTree) {
    pathTree = buildPathTree(rootDir);
    if (!options.noCache) {
      saveCachedTree(rootDir, pathTree);
    }
  }

  // Step 2: Create the virtual filesystem
  const docsFs = new DocsFileSystem({
    rootDir,
    pathTree,
    cacheSize: options.cacheSize,
  });

  // Step 3: Set up search index
  let searchIndex: InMemorySearchIndex | ChromaSearchIndex;
  let chunkCount = 0;

  if (options.chroma) {
    searchIndex = new ChromaSearchIndex(
      options.chromaCollection,
      options.chromaUrl
    );
    await (searchIndex as ChromaSearchIndex).init();
    // Index documents in Chroma
    await searchIndex.indexDocuments(pathTree, (filePath) => {
      return fs.readFileSync(path.join(rootDir, filePath), "utf-8");
    });
  } else {
    searchIndex = new InMemorySearchIndex();
    await searchIndex.indexDocuments(pathTree, (filePath) => {
      return fs.readFileSync(path.join(rootDir, filePath), "utf-8");
    });
    chunkCount = searchIndex.size;
  }

  // Step 4: Create the just-bash instance with our filesystem
  const bash = new Bash({
    fs: docsFs,
    cwd: "/",
    env: {
      HOME: "/",
      USER: "docsvfs",
      TERM: "xterm-256color",
      DOCSVFS_ROOT: rootDir,
      DOCSVFS_FILES: String(pathTree.files.size),
    },
  });

  const bootTimeMs = Math.round(performance.now() - startTime);

  return {
    bash,
    fs: docsFs,
    searchIndex,
    exec: async (command: string) => {
      try {
        const result = await bash.exec(command);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (err: any) {
        return {
          stdout: "",
          stderr: err.message || String(err),
          exitCode: 1,
        };
      }
    },
    stats: {
      fileCount: pathTree.files.size,
      dirCount: pathTree.directories.size,
      chunkCount,
      bootTimeMs,
    },
  };
}
