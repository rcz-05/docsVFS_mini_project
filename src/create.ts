/**
 * create.ts — Factory function that wires up DocsFileSystem + just-bash + caching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Bash, MountableFs, InMemoryFs } from "just-bash";
import { DocsFileSystem } from "./fs/docs-fs.js";
import { buildPathTree } from "./fs/path-tree.js";
import { loadCachedTree, saveCachedTree } from "./cache/disk-cache.js";
import { InMemorySearchIndex, ChromaSearchIndex } from "./chroma/chroma-backend.js";
import { setupMemory, type MemorySetup } from "./memory/setup.js";

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
  /**
   * Enable writable memory mounts: /memory (persistent) and /workspace (24h TTL).
   * When on, the doc root moves from / to /docs and the writable mounts sit
   * beside it in the same virtual namespace.
   */
  memory?: boolean;
  /** Override the libSQL/Turso DB URL (default: file:<rootDir>/.docsvfs.db) */
  memoryDbUrl?: string;
  /** Session id tagged on every write's provenance (default: random UUID) */
  sessionId?: string;
}

export interface DocsVFSInstance {
  /** The just-bash shell instance */
  bash: InstanceType<typeof Bash>;
  /** The virtual filesystem (DocsFileSystem, or MountableFs when memory is on) */
  fs: DocsFileSystem;
  /** Search index (in-memory or Chroma) */
  searchIndex: InMemorySearchIndex | ChromaSearchIndex;
  /** Memory setup when enabled (libSQL client + writable mounts) */
  memory?: MemorySetup;
  /** Execute a bash command */
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Summary stats */
  stats: {
    fileCount: number;
    dirCount: number;
    chunkCount: number;
    bootTimeMs: number;
    memoryMounts?: string[];
  };
  /** Release resources (closes libSQL connection when memory is on) */
  close: () => Promise<void>;
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

  // Step 4: If memory is enabled, wrap DocsFileSystem + writable mounts in a MountableFs.
  let rootFs: DocsFileSystem | MountableFs = docsFs;
  let memory: MemorySetup | undefined;
  let initialCwd = "/";
  const memoryMounts: string[] = [];

  if (options.memory) {
    memory = await setupMemory({
      rootDir,
      dbUrl: options.memoryDbUrl,
      sessionId: options.sessionId,
    });
    const mountable = new MountableFs({ base: new InMemoryFs() });
    mountable.mount("/docs", docsFs);
    for (const { mountPoint, filesystem } of memory.mounts) {
      mountable.mount(mountPoint, filesystem);
      memoryMounts.push(mountPoint);
    }
    rootFs = mountable;
    initialCwd = "/docs";
  }

  const bash = new Bash({
    fs: rootFs,
    cwd: initialCwd,
    env: {
      HOME: "/",
      USER: "docsvfs",
      TERM: "xterm-256color",
      DOCSVFS_ROOT: rootDir,
      DOCSVFS_FILES: String(pathTree.files.size),
      ...(memory ? { DOCSVFS_SESSION: memory.sessionId } : {}),
    },
  });

  const bootTimeMs = Math.round(performance.now() - startTime);

  return {
    bash,
    fs: docsFs,
    searchIndex,
    memory,
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
      memoryMounts: memoryMounts.length ? memoryMounts : undefined,
    },
    close: async () => {
      memory?.close();
    },
  };
}
