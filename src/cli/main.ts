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
import { createDocsVFS } from "../create.js";

// ─── Argument parsing (minimal, no dep needed) ─────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let rootDir = ".";
  let chroma = false;
  let chromaUrl = "http://localhost:8000";
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--chroma") {
      chroma = true;
    } else if (arg === "--chroma-url" && i + 1 < args.length) {
      chromaUrl = args[++i];
    } else if (arg === "--no-cache") {
      noCache = true;
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

  return { rootDir, chroma, chromaUrl, noCache };
}

function printHelp() {
  console.log(`
docsvfs — A ChromaFS-inspired virtual filesystem for documentation.

USAGE
  docsvfs <folder>            Start a bash REPL over your docs
  docsvfs <folder> --chroma   Enable Chroma-backed semantic search

OPTIONS
  --chroma          Enable Chroma integration (requires running Chroma server)
  --chroma-url URL  Chroma server URL (default: http://localhost:8000)
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

async function main() {
  const { rootDir, chroma, chromaUrl, noCache } = parseArgs(process.argv);

  console.log(`\x1b[36m📁 docsvfs\x1b[0m — Virtual filesystem for documentation`);
  console.log(`   Scanning: \x1b[33m${rootDir}\x1b[0m`);

  try {
    const vfs = await createDocsVFS({
      rootDir,
      chroma,
      chromaUrl,
      noCache,
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
    console.log(`   Mode: \x1b[31mread-only\x1b[0m (EROFS on writes)\n`);
    console.log(`Type \x1b[33mexit\x1b[0m to quit, or any bash command to explore.\n`);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\x1b[36mdocsvfs\x1b[0m:\x1b[33m/\x1b[0m$ ",
      terminal: true,
    });

    let cwd = "/";

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
