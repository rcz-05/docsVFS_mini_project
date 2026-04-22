#!/usr/bin/env node
/**
 * bin.ts — CLI entry for `docsvfs-mcp`.
 *
 * Parses flags, boots a DocsVFS instance, connects the MCP server to
 * stdio, and handles graceful shutdown. Stdout belongs to JSON-RPC —
 * every log, every startup banner, every error goes to stderr.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDocsVFS } from "../create.js";
import { createMcpServer } from "./server.js";

const USAGE = `docsvfs-mcp — MCP server exposing DocsVFS over stdio

Usage:
  docsvfs-mcp <path> [options]

Options:
  --memory                Enable /memory + /workspace writable mounts (SQLite)
  --chroma                Use Chroma for semantic search (requires running server)
  --chroma-url <url>      Chroma server URL (default http://localhost:8000)
  --chroma-collection <n> Chroma collection name (default docsvfs)
  --memory-db <url>       Override libSQL URL (default file:<path>/.docsvfs.db)
  --session <id>          Session id for provenance (default random UUID)
  --no-cache              Skip disk cache
  -v, --version           Print version and exit
  -h, --help              Show this help and exit

Examples:
  docsvfs-mcp ./my-docs --memory
  docsvfs-mcp ~/data-attribution-demo/docs --memory --memory-db file:/tmp/shared.db
`;

interface ParsedArgs {
  rootDir?: string;
  memory: boolean;
  chroma: boolean;
  chromaUrl?: string;
  chromaCollection?: string;
  memoryDb?: string;
  session?: string;
  noCache: boolean;
  showVersion: boolean;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    memory: false,
    chroma: false,
    noCache: false,
    showVersion: false,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.showHelp = true;
    else if (a === "-v" || a === "--version") args.showVersion = true;
    else if (a === "--memory") args.memory = true;
    else if (a === "--chroma") args.chroma = true;
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--chroma-url" && i + 1 < argv.length) args.chromaUrl = argv[++i];
    else if (a === "--chroma-collection" && i + 1 < argv.length)
      args.chromaCollection = argv[++i];
    else if (a === "--memory-db" && i + 1 < argv.length) args.memoryDb = argv[++i];
    else if (a === "--session" && i + 1 < argv.length) args.session = argv[++i];
    else if (a.startsWith("-")) {
      die(`unknown flag: ${a}`);
    } else if (!args.rootDir) {
      args.rootDir = a;
    } else {
      die(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function die(msg: string): never {
  process.stderr.write(`docsvfs-mcp: ${msg}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    // dist/mcp/bin.js → ../../package.json
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    process.stderr.write(USAGE);
    process.exit(0);
  }
  const version = readPackageVersion();
  if (args.showVersion) {
    process.stderr.write(`docsvfs-mcp ${version}\n`);
    process.exit(0);
  }

  if (!args.rootDir) die("missing <path> positional argument");
  const rootDir = path.resolve(args.rootDir!);
  if (!fs.existsSync(rootDir)) die(`path not found: ${rootDir}`);
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) die(`not a directory: ${rootDir}`);

  process.stderr.write(
    `docsvfs-mcp ${version} — root=${rootDir} memory=${args.memory} chroma=${args.chroma}\n`
  );

  const vfs = await createDocsVFS({
    rootDir,
    memory: args.memory,
    chroma: args.chroma,
    chromaUrl: args.chromaUrl,
    chromaCollection: args.chromaCollection,
    memoryDbUrl: args.memoryDb,
    sessionId: args.session,
    noCache: args.noCache,
    alwaysMountDocs: true,
  });

  process.stderr.write(
    `docsvfs-mcp: booted in ${vfs.stats.bootTimeMs}ms (${vfs.stats.fileCount} files, ${vfs.stats.dirCount} dirs, ${vfs.stats.chunkCount} chunks)\n`
  );

  const server = createMcpServer({ vfs, version });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string, code = 0) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`docsvfs-mcp: shutting down (${reason})\n`);
    try {
      await server.close();
    } catch (err) {
      process.stderr.write(
        `docsvfs-mcp: server.close() failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    try {
      await vfs.close();
    } catch (err) {
      process.stderr.write(
        `docsvfs-mcp: vfs.close() failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    process.exit(code);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("close", () => shutdown("stdin closed"));

  try {
    await server.connect(transport);
    process.stderr.write(`docsvfs-mcp: listening on stdio\n`);
  } catch (err) {
    process.stderr.write(
      `docsvfs-mcp: failed to connect transport: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await shutdown("transport-failure", 1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `docsvfs-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
  );
  process.exit(1);
});
