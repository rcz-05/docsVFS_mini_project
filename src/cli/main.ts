#!/usr/bin/env node
/**
 * docsvfs CLI — Start an interactive bash REPL over your documentation.
 *
 * Usage:
 *   npx docsvfs ./my-docs
 *   npx docsvfs ./my-docs --chroma
 *   npx docsvfs ./my-docs --no-cache
 */

import { createInterface } from "node:readline";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import { createDocsVFS } from "../create.js";
import { runJanitor, formatJanitorReport, type JanitorOptions } from "../memory/janitor.js";

// ─── Argument parsing (minimal, no dep needed) ─────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let rootDir = ".";
  let chroma = false;
  let chromaUrl = "http://localhost:8000";
  let noCache = false;
  let memory = false;
  let memoryDbUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--chroma") {
      chroma = true;
    } else if (arg === "--chroma-url" && i + 1 < args.length) {
      chromaUrl = args[++i];
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--memory") {
      memory = true;
    } else if (arg === "--memory-db" && i + 1 < args.length) {
      memoryDbUrl = args[++i];
      memory = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log("docsvfs 0.1.0");
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      rootDir = arg;
    }
  }

  return { rootDir, chroma, chromaUrl, noCache, memory, memoryDbUrl };
}

function printHelp() {
  console.log(`
docsvfs — A ChromaFS-inspired virtual filesystem for documentation.

USAGE
  docsvfs <folder>                      Start a bash REPL over your docs
  docsvfs <folder> --chroma             Enable Chroma-backed semantic search
  docsvfs janitor <folder> [flags]      Clean up the writable layer

OPTIONS
  --chroma          Enable Chroma integration (requires running Chroma server)
  --chroma-url URL  Chroma server URL (default: http://localhost:8000)
  --memory          Mount writable /memory and /workspace beside /docs
  --memory-db URL   libSQL/Turso DB URL (default: file:<root>/.docsvfs.db)
  --no-cache        Skip disk cache, always rescan
  -h, --help        Show this help
  -v, --version     Show version

EXAMPLES
  docsvfs ./docs
  docsvfs ./api-specs --chroma
  docsvfs ~/project/documentation --no-cache

COMMANDS (once inside the REPL)
  ls, tree          List files and directories
  cd <dir>          Navigate the doc tree
  cat <file>        Read a document
  grep -r "term" .  Search across all docs
  find . -name "*.md"  Find files by pattern
  exit              Quit the REPL
`);
}

// ─── REPL ──────────────────────────────────────────────────────

async function runJanitorCli(argv: string[]): Promise<number> {
  // argv starts at the token after "janitor"
  const opts: JanitorOptions = {};
  let rootDir = ".";
  let dbUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--aggressive") opts.aggressive = true;
    else if (a === "--compact") { /* default */ }
    else if (a === "--older-than-days" && i + 1 < argv.length) {
      const days = Number(argv[++i]);
      if (!Number.isFinite(days) || days <= 0) {
        console.error("janitor: --older-than-days expects a positive number");
        return 2;
      }
      opts.olderThanMs = days * 24 * 60 * 60 * 1000;
    } else if (a === "--memory-db" && i + 1 < argv.length) {
      dbUrl = argv[++i];
    } else if (a === "--help" || a === "-h") {
      console.log(JANITOR_HELP);
      return 0;
    } else if (!a.startsWith("-")) {
      rootDir = a;
    } else {
      console.error(`janitor: unknown argument "${a}"`);
      return 2;
    }
  }

  const resolvedUrl = dbUrl ?? `file:${path.resolve(rootDir, ".docsvfs.db")}`;
  const client = createClient({ url: resolvedUrl });
  try {
    const report = await runJanitor(client, opts);
    console.log(formatJanitorReport(report));
    return 0;
  } catch (err) {
    console.error(`janitor: ${(err as Error).message}`);
    return 1;
  } finally {
    client.close();
  }
}

const JANITOR_HELP = `Usage: docsvfs janitor <folder> [flags]

Cleans up the writable layer for a DocsVFS root. The folder must be the same
one you pass to \`docsvfs <folder> --memory\` — the janitor looks for
<folder>/.docsvfs.db unless --memory-db is given.

Flags:
  --dry-run                Report only; make no changes
  --aggressive             Also delete flagged stale agent-only writes
  --older-than-days N      Stale threshold (default 1 day)
  --memory-db URL          libSQL URL (default: file:<folder>/.docsvfs.db)
  -h, --help               Show this help
`;

async function main() {
  // Subcommand dispatch: first non-flag arg decides.
  const raw = process.argv.slice(2);
  if (raw[0] === "janitor") {
    const code = await runJanitorCli(raw.slice(1));
    process.exit(code);
  }

  const { rootDir, chroma, chromaUrl, noCache, memory, memoryDbUrl } = parseArgs(process.argv);

  console.log(`\x1b[36m📁 docsvfs\x1b[0m — Virtual filesystem for documentation`);
  console.log(`   Scanning: \x1b[33m${rootDir}\x1b[0m`);

  try {
    const vfs = await createDocsVFS({
      rootDir,
      chroma,
      chromaUrl,
      noCache,
      memory,
      memoryDbUrl,
    });

    console.log(
      `   Found: \x1b[32m${vfs.stats.fileCount}\x1b[0m files in ` +
      `\x1b[32m${vfs.stats.dirCount}\x1b[0m directories`
    );
    if (vfs.stats.chunkCount > 0) {
      console.log(`   Indexed: \x1b[32m${vfs.stats.chunkCount}\x1b[0m chunks`);
    }
    console.log(
      `   Boot time: \x1b[32m${vfs.stats.bootTimeMs}ms\x1b[0m` +
      (chroma ? " (with Chroma)" : "")
    );
    if (memory && vfs.stats.memoryMounts) {
      console.log(
        `   Mounts: \x1b[32m/docs\x1b[0m (read-only) + ` +
        vfs.stats.memoryMounts.map((m) => `\x1b[32m${m}\x1b[0m`).join(" ") +
        ` (writable)`
      );
      console.log(`   Session: \x1b[2m${vfs.memory?.sessionId}\x1b[0m\n`);
    } else {
      console.log(`   Mode: \x1b[31mread-only\x1b[0m (EROFS on writes)\n`);
    }
    console.log(`Type \x1b[33mexit\x1b[0m to quit, or any bash command to explore.\n`);

    const startCwd = memory ? "/docs" : "/";
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `\x1b[36mdocsvfs\x1b[0m:\x1b[33m${startCwd}\x1b[0m$ `,
      terminal: true,
    });

    let cwd = startCwd;

    const updatePrompt = () => {
      rl.setPrompt(`\x1b[36mdocsvfs\x1b[0m:\x1b[33m${cwd}\x1b[0m$ `);
    };

    rl.prompt();

    rl.on("line", async (line: string) => {
      const cmd = line.trim();

      if (!cmd) {
        rl.prompt();
        return;
      }

      if (cmd === "exit" || cmd === "quit") {
        console.log("Goodbye!");
        await vfs.close();
        rl.close();
        process.exit(0);
      }

      try {
        const result = await vfs.exec(cmd);

        if (result.stdout) {
          process.stdout.write(result.stdout);
          // Ensure newline at end
          if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
        }
        if (result.stderr) {
          process.stderr.write(`\x1b[31m${result.stderr}\x1b[0m`);
          if (!result.stderr.endsWith("\n")) process.stderr.write("\n");
        }

        // Track cwd changes (cd commands)
        if (cmd.startsWith("cd ")) {
          const pwdResult = await vfs.exec("pwd");
          cwd = pwdResult.stdout.trim() || cwd;
          updatePrompt();
        }
      } catch (err: any) {
        console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
      }

      rl.prompt();
    });

    rl.on("close", () => {
      process.exit(0);
    });
  } catch (err: any) {
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

main();
