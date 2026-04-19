/**
 * density.ts — "density <path> <term>" custom command.
 *
 * Walks the VFS under <path>, counts occurrences of <term> in each file,
 * prints a ranked list with ASCII bars, and suggests a drill-in target.
 * Designed to nudge agents toward "which file really has this topic?"
 * without forcing them to re-read all of grep's raw output.
 *
 * Runs against whatever filesystem just-bash hands in via ctx.fs, so it
 * works uniformly across /docs, /memory, and /workspace without knowing
 * anything about the mount topology.
 */
import { defineCommand } from "just-bash";
import type { Command, CommandContext, ExecResult, IFileSystem } from "just-bash";

export interface DensityOptions {
  path: string;
  term: string;
  ignoreCase?: boolean;
  top?: number;
  minCount?: number;
  bars?: boolean;
}

export interface DensityRow {
  path: string;
  count: number;
}

export interface DensityResult {
  rows: DensityRow[];
  totalFiles: number;
  totalMatches: number;
  scannedFiles: number;
  elapsedMs: number;
}

const DEFAULT_TOP = 10;
const DEFAULT_MIN_COUNT = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip huge files

export async function runDensity(
  fs: IFileSystem,
  opts: DensityOptions
): Promise<DensityResult> {
  const started = performance.now();
  const ignoreCase = opts.ignoreCase ?? false;
  const top = opts.top ?? DEFAULT_TOP;
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;

  const needle = ignoreCase ? opts.term.toLowerCase() : opts.term;
  if (!needle.length) {
    return { rows: [], totalFiles: 0, totalMatches: 0, scannedFiles: 0, elapsedMs: 0 };
  }

  const files: string[] = [];
  await collectFiles(fs, opts.path, files);

  const rows: DensityRow[] = [];
  let totalMatches = 0;
  for (const file of files) {
    let content: string;
    try {
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      const raw = await fs.readFile(file, "utf-8");
      content = typeof raw === "string" ? raw : String(raw);
    } catch {
      continue;
    }
    const hay = ignoreCase ? content.toLowerCase() : content;
    const count = countOccurrences(hay, needle);
    if (count >= minCount) {
      rows.push({ path: file, count });
      totalMatches += count;
    }
  }

  rows.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return {
    rows: rows.slice(0, top),
    totalFiles: rows.length,
    totalMatches,
    scannedFiles: files.length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function collectFiles(fs: IFileSystem, start: string, out: string[]): Promise<void> {
  let stat;
  try { stat = await fs.stat(start); } catch { return; }
  if (stat.isFile) {
    out.push(start);
    return;
  }
  if (!stat.isDirectory) return;

  const stack: string[] = [start];
  const useTypes = typeof fs.readdirWithFileTypes === "function";
  while (stack.length) {
    const dir = stack.pop()!;
    try {
      if (useTypes) {
        const entries = await fs.readdirWithFileTypes!(dir);
        for (const e of entries) {
          const full = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
          if (e.isDirectory) stack.push(full);
          else if (e.isFile) out.push(full);
        }
      } else {
        const names = await fs.readdir(dir);
        for (const name of names) {
          const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
          try {
            const s = await fs.stat(full);
            if (s.isDirectory) stack.push(full);
            else if (s.isFile) out.push(full);
          } catch { /* skip */ }
        }
      }
    } catch { /* skip unreadable dir */ }
  }
}

/** Non-overlapping literal substring count. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle.length) return 0;
  let count = 0;
  let i = 0;
  const step = needle.length;
  while (true) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) return count;
    count++;
    i = hit + step;
  }
}

export function formatDensity(
  result: DensityResult,
  opts: { path: string; term: string; bars?: boolean }
): string {
  const bars = opts.bars ?? true;
  const lines: string[] = [];
  const summary = `density for "${opts.term}" in ${opts.path} — ${result.totalFiles} file(s), ${result.totalMatches} total match(es), ${result.scannedFiles} scanned in ${result.elapsedMs}ms`;
  lines.push(summary);

  if (result.rows.length === 0) {
    lines.push(`  (no matches)`);
    return lines.join("\n");
  }

  const maxCount = result.rows[0].count;
  const maxPathLen = Math.min(50, result.rows.reduce((m, r) => Math.max(m, r.path.length), 0));
  const BAR_WIDTH = 24;

  lines.push("");
  for (const row of result.rows) {
    const padded = row.path.length > maxPathLen
      ? "…" + row.path.slice(row.path.length - maxPathLen + 1)
      : row.path.padEnd(maxPathLen);
    const countStr = String(row.count).padStart(5);
    if (bars) {
      const filled = Math.max(1, Math.round((row.count / maxCount) * BAR_WIDTH));
      lines.push(`  ${padded} ${countStr}  ${"█".repeat(filled)}`);
    } else {
      lines.push(`  ${padded} ${countStr}`);
    }
  }

  lines.push("");
  const top = result.rows[0];
  const second = result.rows[1];
  if (!second || top.count >= second.count * 2) {
    lines.push(`→ ${top.path} dominates. Try: cat ${top.path}`);
  } else {
    lines.push(`→ Try: grep -n "${opts.term}" ${top.path}`);
  }
  return lines.join("\n");
}

export function makeDensityCommand(): Command {
  return defineCommand("density", async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    const opts: Partial<DensityOptions> & { bars?: boolean } = { bars: true };
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-i" || a === "--ignore-case") opts.ignoreCase = true;
      else if (a === "--no-bars") opts.bars = false;
      else if (a === "--top" && i + 1 < args.length) {
        const n = Number(args[++i]);
        if (!Number.isFinite(n) || n < 1) {
          return { stdout: "", stderr: `density: --top expects a positive number\n`, exitCode: 2 };
        }
        opts.top = n;
      } else if (a === "--min-count" && i + 1 < args.length) {
        const n = Number(args[++i]);
        if (!Number.isFinite(n) || n < 1) {
          return { stdout: "", stderr: `density: --min-count expects a positive number\n`, exitCode: 2 };
        }
        opts.minCount = n;
      } else if (a === "--help" || a === "-h") {
        return { stdout: DENSITY_HELP, stderr: "", exitCode: 0 };
      } else if (a.startsWith("-")) {
        return { stdout: "", stderr: `density: unknown flag "${a}". Try --help.\n`, exitCode: 2 };
      } else {
        positional.push(a);
      }
    }

    if (positional.length < 2) {
      return {
        stdout: "",
        stderr: `density: usage: density <path> <term> [flags]\n`,
        exitCode: 2,
      };
    }

    const path = resolvePath(positional[0], ctx.cwd);
    const term = positional.slice(1).join(" ");

    try {
      const result = await runDensity(ctx.fs, { ...opts, path, term });
      return {
        stdout: formatDensity(result, { path, term, bars: opts.bars }) + "\n",
        stderr: "",
        exitCode: result.rows.length > 0 ? 0 : 1,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: `density: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  });
}

function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("/")) return normalizeAbs(p);
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return normalizeAbs(base + p);
}

function normalizeAbs(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

const DENSITY_HELP = `Usage: density <path> <term> [flags]

Rank files under <path> by occurrence count of <term>. Prints an ASCII-bar
histogram and suggests a drill-in command (cat or grep) based on the shape
of the distribution.

Flags:
  -i, --ignore-case    Case-insensitive match
  --top N              Show top N rows (default 10)
  --min-count N        Skip files with fewer than N matches (default 1)
  --no-bars            Disable the ASCII bar column
  -h, --help           Show this help
`;
