/**
 * docsvfs — A ChromaFS-inspired virtual filesystem for documentation.
 *
 * Give AI agents a Unix shell over your docs. They already know
 * ls, cd, grep, cat, and find — why force them into RAG?
 *
 * @example
 * ```ts
 * import { createDocsVFS } from "docsvfs";
 *
 * const bash = await createDocsVFS("./my-docs");
 * const result = await bash.exec('grep -r "authentication" .');
 * console.log(result.stdout);
 * ```
 */

export { DocsFileSystem } from "./fs/docs-fs.js";
export { buildPathTree, serializePathTree, deserializePathTree } from "./fs/path-tree.js";
export type { PathTree, PathNode } from "./fs/path-tree.js";
export { loadCachedTree, saveCachedTree } from "./cache/disk-cache.js";
export {
  InMemorySearchIndex,
  ChromaSearchIndex,
  chunkDocument,
} from "./chroma/chroma-backend.js";
export type { DocChunk } from "./chroma/chroma-backend.js";
export { createDocsVFS, type DocsVFSOptions } from "./create.js";
export { WritableFileSystem } from "./memory/writable-fs.js";
export { FreshMap } from "./memory/fresh-map.js";
export { setupMemory } from "./memory/setup.js";
export type { Provenance, NodeRow } from "./memory/schema.js";
export {
  createRememberTool,
  slugifyTopic,
  type RememberTool,
  type RememberToolOptions,
  type RememberArgs,
  type RememberResult,
} from "./remember-tool.js";
