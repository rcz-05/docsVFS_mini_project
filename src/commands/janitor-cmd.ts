/**
 * janitor-cmd.ts — Wraps runJanitor as a just-bash custom command.
 *
 * Usage inside the REPL:
 *   janitor                       # prune expired + dedup + flag + VACUUM
 *   janitor --dry-run             # show what would happen, change nothing
 *   janitor --aggressive          # also delete flagged stale agent-only writes
 *   janitor --older-than-days 7   # override 24h threshold
 */

import type { Client } from "@libsql/client";
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import { runJanitor, formatJanitorReport, type JanitorOptions } from "../memory/janitor.js";

export function makeJanitorCommand(client: Client): Command {
  return defineCommand("janitor", async (args) => {
    const options: JanitorOptions = {};

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--dry-run") options.dryRun = true;
      else if (a === "--aggressive") options.aggressive = true;
      else if (a === "--compact") { /* default; no-op */ }
      else if (a === "--older-than-days" && i + 1 < args.length) {
        const days = Number(args[++i]);
        if (Number.isFinite(days) && days > 0) {
          options.olderThanMs = days * 24 * 60 * 60 * 1000;
        } else {
          return {
            stdout: "",
            stderr: `janitor: --older-than-days expects a positive number\n`,
            exitCode: 2,
          };
        }
      } else if (a === "--help" || a === "-h") {
        return { stdout: HELP, stderr: "", exitCode: 0 };
      } else {
        return {
          stdout: "",
          stderr: `janitor: unknown argument "${a}". Try --help.\n`,
          exitCode: 2,
        };
      }
    }

    try {
      const report = await runJanitor(client, options);
      return {
        stdout: formatJanitorReport(report) + "\n",
        stderr: "",
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: `janitor: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  });
}

const HELP = `Usage: janitor [--dry-run] [--aggressive] [--older-than-days N]

Cleans up the writable layer:
  - prunes entries whose TTL has expired
  - deduplicates files with identical content within a mount
  - flags agent-only writes older than 24h that haven't been touched
  - VACUUMs the database

Options:
  --dry-run              report only; make no changes
  --aggressive           also delete flagged stale agent-only writes
  --older-than-days N    treat writes older than N days as stale (default 1)
  -h, --help             show this help
`;
