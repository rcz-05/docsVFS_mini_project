/**
 * server.ts — MCP server wiring for DocsVFS.
 *
 * Builds an McpServer exposing 4 tools (docs, remember, density, stats)
 * per MCP_TOOL_SCHEMAS.md. All handlers delegate to existing primitives
 * (createDocsVFS.exec, createRememberTool, runDensity) — this file is
 * glue + response-shape discipline only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocsVFSInstance } from "../create.js";
import { createRememberTool } from "../remember-tool.js";
import { runDensity, formatDensity } from "../commands/density.js";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface McpServerOptions {
  /** Built DocsVFS instance. Must already be initialized. */
  vfs: DocsVFSInstance;
  /** Semantic version to advertise as `serverInfo.version`. */
  version: string;
}

/**
 * Build a fully-wired MCP server ready to `.connect(transport)`.
 *
 * Tools are registered conditionally based on `vfs` capabilities:
 * `remember` only registers when the memory mount is present.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const { vfs, version } = options;

  const server = new McpServer(
    { name: "docsvfs", version },
    { capabilities: { tools: { listChanged: false } } }
  );

  registerDocsTool(server, vfs);
  registerDensityTool(server, vfs);
  registerStatsTool(server, vfs);
  if (vfs.memory) {
    registerRememberTool(server, vfs);
  }

  return server;
}

// ─── docs ────────────────────────────────────────────────────────────────────

function registerDocsTool(server: McpServer, vfs: DocsVFSInstance) {
  server.registerTool(
    "docs",
    {
      description:
        "Run a bash command over the DocsVFS virtual filesystem. Mounts: " +
        "/docs (read-only source documentation), /memory (persistent notes " +
        "across sessions), /workspace (24h scratch). Supports ls, cd, cat, " +
        "grep, find, tree, head, tail, wc, pipes (|), and redirects (>, >>). " +
        "Writes to /docs return EROFS. Start with `tree / -L 2` to orient. " +
        "Use `.` (not `/`) as the search path when cwd is / to avoid a " +
        "double-slash bug in the underlying grep.",
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe("A bash command. One-line; semicolons and pipes allowed."),
      },
    },
    async ({ command }) => {
      const startedAt = Date.now();
      try {
        const { stdout, stderr, exitCode } = await vfs.exec(command);
        const text = assembleDocsText(stdout, stderr, exitCode);
        logEvent({
          tool: "docs",
          command,
          exitCode,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text", text }],
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({
          tool: "docs",
          command,
          error: message,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text", text: `docs: internal error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

function assembleDocsText(stdout: string, stderr: string, exitCode: number): string {
  const outCap = capBytes(stdout, MAX_STDOUT_BYTES);
  const errCap = capBytes(stderr, MAX_STDERR_BYTES);
  const parts: string[] = [];
  if (outCap.length) parts.push(outCap);
  if (errCap.length) parts.push(`stderr: ${errCap}`);
  if (exitCode !== 0 && !outCap.length && !errCap.length) {
    parts.push(`exit ${exitCode}`);
  }
  return parts.join("\n") || "";
}

// ─── remember ────────────────────────────────────────────────────────────────

function registerRememberTool(server: McpServer, vfs: DocsVFSInstance) {
  const remember = createRememberTool({ vfs });

  server.registerTool(
    "remember",
    {
      description:
        'Save a note to /memory/<slug>.md. <slug> is derived from `topic` ' +
        "(lowercased, punctuation stripped, spaces→hyphens, max 60 chars). " +
        "This is the agent's persistence primitive — the only way findings " +
        "survive across MCP sessions. Every write is tagged provenance " +
        'source="tool" with the session_id. Use for any fact you want a ' +
        "future session to pick up. For scratch work use /workspace instead " +
        "(via the docs tool with `>` redirect).",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .max(200)
          .describe("Short human-readable topic. Gets slugified to the filename."),
        content: z
          .string()
          .min(1)
          .max(65536)
          .describe("Markdown body. 64 KB cap."),
        append: z
          .boolean()
          .optional()
          .describe(
            "If true, append to any existing file under this slug; otherwise overwrite. Default false."
          ),
        note: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional free-form provenance note (e.g. `source query` or `why this matters`). Stored in nodes.provenance.note."
          ),
      },
      outputSchema: {
        ok: z.literal(true),
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        mode: z.enum(["overwrite", "append"]),
      },
    },
    async ({ topic, content, append, note }) => {
      const startedAt = Date.now();
      try {
        const result = await remember.execute({ topic, content, append, note });
        logEvent({
          tool: "remember",
          topic,
          mode: result.mode,
          bytes: result.bytes,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ...result } as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({
          tool: "remember",
          topic,
          error: message,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text", text: `remember: write failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

// ─── density ─────────────────────────────────────────────────────────────────

function registerDensityTool(server: McpServer, vfs: DocsVFSInstance) {
  server.registerTool(
    "density",
    {
      description:
        'Rank files under <path> by occurrence count of <term>. Returns a ' +
        'ranked list with ASCII bars and a drill-in suggestion (e.g. ' +
        '"→ /docs/FOO.md dominates. Try: cat /docs/FOO.md"). Works across ' +
        'all mounts — pass `/` to scan /docs, /memory, and /workspace ' +
        "together. Faster than re-reading grep output when you just want " +
        "to know where a term concentrates.",
      inputSchema: {
        path: z.string().min(1).describe("Root path to scan. Use `/` for all mounts."),
        term: z
          .string()
          .min(1)
          .max(200)
          .describe("Term to count. Literal substring match."),
        caseInsensitive: z
          .boolean()
          .optional()
          .describe("Case-insensitive match. Default false."),
        top: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows returned. Default 10, max 100."),
      },
      outputSchema: {
        term: z.string(),
        path: z.string(),
        totalFiles: z.number().int().nonnegative(),
        totalMatches: z.number().int().nonnegative(),
        rows: z.array(
          z.object({
            path: z.string(),
            count: z.number().int().nonnegative(),
          })
        ),
        suggestion: z.string().nullable(),
        elapsedMs: z.number().int().nonnegative(),
      },
    },
    async ({ path: scanPath, term, caseInsensitive, top }) => {
      const startedAt = Date.now();
      try {
        // density runs against the underlying fs — use bash.fs to get the
        // full mountable filesystem when memory is on.
        const fs = (vfs.bash as any).fs ?? vfs.fs;
        const result = await runDensity(fs, {
          path: scanPath,
          term,
          ignoreCase: caseInsensitive,
          top,
        });

        if (result.totalFiles === 0 && result.scannedFiles === 0) {
          return {
            content: [{ type: "text", text: `density: path not found: ${scanPath}` }],
            isError: true,
          };
        }

        const formatted = formatDensity(result, { path: scanPath, term, bars: true });
        const suggestion = extractSuggestion(result, term);

        const structured = {
          term,
          path: scanPath,
          totalFiles: result.totalFiles,
          totalMatches: result.totalMatches,
          rows: result.rows,
          suggestion,
          elapsedMs: result.elapsedMs,
        };

        logEvent({
          tool: "density",
          path: scanPath,
          term,
          totalMatches: result.totalMatches,
          elapsedMs: Date.now() - startedAt,
        });

        return {
          content: [{ type: "text", text: formatted }],
          structuredContent: structured as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({
          tool: "density",
          path: scanPath,
          term,
          error: message,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          content: [{ type: "text", text: `density: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

function extractSuggestion(
  result: { rows: { path: string; count: number }[] },
  term: string
): string | null {
  if (result.rows.length === 0) return null;
  const top = result.rows[0];
  const second = result.rows[1];
  if (!second || top.count >= second.count * 2) {
    return `cat ${top.path}`;
  }
  return `grep -n "${term}" ${top.path}`;
}

// ─── stats ───────────────────────────────────────────────────────────────────

type MountStat = {
  mount: string;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  lastWriteAt: string | null;
  writable: boolean;
  ttlHours?: number;
};

function registerStatsTool(server: McpServer, vfs: DocsVFSInstance) {
  const bootedAt = new Date().toISOString();

  server.registerTool(
    "stats",
    {
      description:
        "Return per-mount file counts, total bytes, chunk-index size, " +
        "last-write timestamp, and server boot time. Use at session start " +
        "to see scale before deciding how to explore. Cheaper than " +
        "`tree / -L 2` when you only need numbers.",
      inputSchema: {
        mount: z
          .enum(["/docs", "/memory", "/workspace"])
          .optional()
          .describe("Optional: restrict to one mount. Omit for all."),
      },
      outputSchema: {
        bootedAt: z.string(),
        bootTimeMs: z.number().int().nonnegative(),
        chunkCount: z.number().int().nonnegative(),
        chunkBackend: z.enum(["in-memory", "chroma"]),
        mounts: z.array(
          z.object({
            mount: z.string(),
            fileCount: z.number().int().nonnegative(),
            dirCount: z.number().int().nonnegative(),
            totalBytes: z.number().int().nonnegative(),
            lastWriteAt: z.string().nullable(),
            writable: z.boolean(),
            ttlHours: z.number().int().positive().optional(),
          })
        ),
      },
    },
    async ({ mount }) => {
      try {
        const availableMounts = getAvailableMounts(vfs);
        if (mount && !availableMounts.some((m) => m.mount === mount)) {
          return {
            content: [{ type: "text", text: `stats: mount not available: ${mount}` }],
            isError: true,
          };
        }

        const mounts = mount
          ? availableMounts.filter((m) => m.mount === mount)
          : availableMounts;

        if (vfs.memory) {
          await enrichWithMemoryCounts(vfs, mounts);
        }

        const chunkBackend =
          (vfs.searchIndex.constructor?.name || "") === "ChromaSearchIndex"
            ? "chroma"
            : "in-memory";

        const structured = {
          bootedAt,
          bootTimeMs: vfs.stats.bootTimeMs,
          chunkCount: vfs.stats.chunkCount,
          chunkBackend: chunkBackend as "in-memory" | "chroma",
          mounts,
        };

        return {
          content: [{ type: "text", text: renderStats(structured) }],
          structuredContent: structured as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `stats: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

function getAvailableMounts(vfs: DocsVFSInstance): MountStat[] {
  const mounts: MountStat[] = [];

  mounts.push({
    mount: "/docs",
    fileCount: vfs.stats.fileCount,
    dirCount: vfs.stats.dirCount,
    totalBytes: 0, // populated from pathTree file stats below if desired; keep 0 for now
    lastWriteAt: null,
    writable: false,
  });

  if (vfs.memory) {
    for (const entry of vfs.memory.mounts) {
      const ttlHours = entry.mountPoint === "/workspace" ? 24 : undefined;
      mounts.push({
        mount: entry.mountPoint,
        fileCount: 0,
        dirCount: 0,
        totalBytes: 0,
        lastWriteAt: null,
        writable: true,
        ...(ttlHours ? { ttlHours } : {}),
      });
    }
  }

  return mounts;
}

async function enrichWithMemoryCounts(
  vfs: DocsVFSInstance,
  mounts: MountStat[]
): Promise<void> {
  if (!vfs.memory) return;
  const client = vfs.memory.client;
  for (const m of mounts) {
    if (!m.writable) continue;
    const rows = await client.execute({
      sql:
        "SELECT kind, COUNT(*) AS c, COALESCE(SUM(size),0) AS bytes, MAX(updated_at) AS last " +
        "FROM nodes WHERE mount = ? GROUP BY kind",
      args: [m.mount],
    });
    for (const row of rows.rows) {
      const kind = String(row.kind);
      const count = Number(row.c ?? 0);
      const bytes = Number(row.bytes ?? 0);
      const last = row.last == null ? null : Number(row.last);
      if (kind === "file") {
        m.fileCount = count;
        m.totalBytes += bytes;
        if (last) m.lastWriteAt = new Date(last).toISOString();
      } else if (kind === "dir") {
        m.dirCount = count;
      }
    }
  }
}

function renderStats(s: {
  bootedAt: string;
  bootTimeMs: number;
  chunkCount: number;
  chunkBackend: "in-memory" | "chroma";
  mounts: MountStat[];
}): string {
  const lines: string[] = [];
  lines.push(`docsvfs — booted ${s.bootedAt} (${s.bootTimeMs}ms)`);
  for (const m of s.mounts) {
    const w = m.writable ? "w" : "r";
    const last = m.lastWriteAt ? m.lastWriteAt : "—";
    lines.push(
      `  ${m.mount.padEnd(11)} ${String(m.fileCount).padStart(4)} files, ` +
        `${String(m.dirCount).padStart(3)} dirs, ${formatBytes(m.totalBytes).padStart(8)}, ` +
        `[${w}], last write: ${last}` +
        (m.ttlHours ? `, ttl ${m.ttlHours}h` : "")
    );
  }
  lines.push(`chunk index: ${s.chunkCount} chunks (${s.chunkBackend})`);
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── shared utilities ────────────────────────────────────────────────────────

function capBytes(s: string, maxBytes: number): string {
  if (!s) return "";
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= maxBytes) return s;
  const truncated = buf.subarray(0, maxBytes).toString("utf-8");
  return `${truncated}\n[truncated: ${buf.byteLength - maxBytes} bytes]`;
}

function logEvent(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), level: "info", ...event });
  process.stderr.write(line + "\n");
}
