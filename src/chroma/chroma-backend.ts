/**
 * chroma-backend.ts — Optional Chroma integration for DocsVFS.
 *
 * When enabled (--chroma flag), this module:
 *   1. Chunks each doc file into ~500-char segments
 *   2. Stores them in a local Chroma collection with page_slug + chunk_index
 *   3. Provides a coarse filter for grep: query Chroma first, then fine-filter
 *
 * This mirrors Mintlify's ChromaFS architecture:
 *   grep → Chroma $contains/$regex → bulk prefetch → in-memory regex
 */

import type { PathTree } from "../fs/path-tree.js";

/** A single chunk of a document */
export interface DocChunk {
  /** The file path this chunk belongs to */
  filePath: string;
  /** Index of this chunk within the file (0-based) */
  chunkIndex: number;
  /** The actual text content */
  content: string;
}

/**
 * Chunk a document into segments of ~chunkSize characters,
 * splitting at paragraph boundaries when possible.
 */
export function chunkDocument(
  filePath: string,
  content: string,
  chunkSize: number = 500
): DocChunk[] {
  if (content.length <= chunkSize) {
    return [{ filePath, chunkIndex: 0, content }];
  }

  const chunks: DocChunk[] = [];
  const paragraphs = content.split(/\n\n+/);
  let current = "";
  let idx = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push({ filePath, chunkIndex: idx++, content: current.trim() });
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }

  if (current.trim()) {
    chunks.push({ filePath, chunkIndex: idx, content: current.trim() });
  }

  return chunks;
}

/**
 * In-memory search index that provides Chroma-like coarse filtering
 * without requiring an actual Chroma server (for the basic mode).
 */
export class InMemorySearchIndex {
  private chunks: DocChunk[] = [];
  private fileChunks = new Map<string, DocChunk[]>();

  /** Index all documents from a path tree */
  async indexDocuments(
    tree: PathTree,
    readFile: (path: string) => string
  ): Promise<void> {
    this.chunks = [];
    this.fileChunks.clear();

    for (const filePath of tree.files) {
      try {
        const content = readFile(filePath);
        const fileChunks = chunkDocument(filePath, content);
        this.chunks.push(...fileChunks);
        this.fileChunks.set(filePath, fileChunks);
      } catch {
        // Skip files that can't be read
      }
    }
  }

  /** Get total chunk count */
  get size(): number {
    return this.chunks.length;
  }

  /**
   * Coarse filter: find files that likely contain the search term.
   * Returns file paths that have at least one matching chunk.
   * This is the equivalent of ChromaFS's Chroma $contains query.
   */
  coarseFilter(query: string, caseInsensitive: boolean = false): string[] {
    const matchedFiles = new Set<string>();
    const searchTerm = caseInsensitive ? query.toLowerCase() : query;

    for (const chunk of this.chunks) {
      const text = caseInsensitive ? chunk.content.toLowerCase() : chunk.content;
      if (text.includes(searchTerm)) {
        matchedFiles.add(chunk.filePath);
      }
    }

    return Array.from(matchedFiles);
  }

  /**
   * Regex coarse filter: find files matching a regex pattern.
   * Equivalent of ChromaFS's $regex query.
   */
  coarseFilterRegex(pattern: string, flags: string = ""): string[] {
    const matchedFiles = new Set<string>();
    try {
      const regex = new RegExp(pattern, flags);
      for (const chunk of this.chunks) {
        if (regex.test(chunk.content)) {
          matchedFiles.add(chunk.filePath);
        }
      }
    } catch {
      // Invalid regex — fall back to empty results
    }
    return Array.from(matchedFiles);
  }

  /** Get all chunks for a specific file (for reassembly) */
  getFileChunks(filePath: string): DocChunk[] {
    return this.fileChunks.get(filePath) ?? [];
  }
}

/**
 * ChromaDB-backed search index.
 * Requires a running Chroma server (default: http://localhost:8000).
 *
 * This provides the full ChromaFS experience: vector embeddings +
 * metadata filtering for truly semantic search alongside keyword grep.
 */
export class ChromaSearchIndex {
  private client: any = null;
  private collection: any = null;
  private collectionName: string;
  private chromaUrl: string;

  constructor(collectionName: string = "docsvfs", chromaUrl: string = "http://localhost:8000") {
    this.collectionName = collectionName;
    this.chromaUrl = chromaUrl;
  }

  /** Initialize the Chroma client and collection */
  async init(): Promise<void> {
    try {
      // Dynamic import to keep chromadb optional
      const { ChromaClient } = await import("chromadb");
      this.client = new ChromaClient({ path: this.chromaUrl });
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: { "hnsw:space": "cosine" },
      });
    } catch (err) {
      throw new Error(
        `Failed to connect to Chroma at ${this.chromaUrl}. ` +
        `Make sure Chroma is running: docker run -p 8000:8000 chromadb/chroma\n` +
        `Error: ${err}`
      );
    }
  }

  /** Index all documents */
  async indexDocuments(
    tree: PathTree,
    readFile: (path: string) => string
  ): Promise<void> {
    if (!this.collection) await this.init();

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Array<Record<string, string | number>> = [];

    for (const filePath of tree.files) {
      try {
        const content = readFile(filePath);
        const chunks = chunkDocument(filePath, content);
        for (const chunk of chunks) {
          ids.push(`${filePath}::${chunk.chunkIndex}`);
          documents.push(chunk.content);
          metadatas.push({
            page_slug: filePath,
            chunk_index: chunk.chunkIndex,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      await this.collection.upsert({
        ids: ids.slice(i, i + batchSize),
        documents: documents.slice(i, i + batchSize),
        metadatas: metadatas.slice(i, i + batchSize),
      });
    }
  }

  /** Coarse filter using Chroma's $contains */
  async coarseFilter(query: string): Promise<string[]> {
    if (!this.collection) return [];

    const results = await this.collection.get({
      where_document: { $contains: query },
      include: ["metadatas"],
    });

    const files = new Set<string>();
    for (const meta of results.metadatas ?? []) {
      if (meta?.page_slug) files.add(meta.page_slug as string);
    }
    return Array.from(files);
  }

  /** Semantic search using vector similarity */
  async semanticSearch(query: string, nResults: number = 10): Promise<string[]> {
    if (!this.collection) return [];

    const results = await this.collection.query({
      queryTexts: [query],
      nResults,
      include: ["metadatas"],
    });

    const files = new Set<string>();
    for (const metaList of results.metadatas ?? []) {
      for (const meta of metaList) {
        if (meta?.page_slug) files.add(meta.page_slug as string);
      }
    }
    return Array.from(files);
  }
}
