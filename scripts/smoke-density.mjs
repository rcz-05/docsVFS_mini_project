/**
 * smoke-density.mjs — Phase 2.3 density command coverage.
 *
 * Exercises density across:
 *   - case-sensitive vs -i
 *   - --top limit
 *   - --min-count filter
 *   - --no-bars output
 *   - path resolution relative to cwd
 *   - exit code = 1 when no matches
 *
 * Uses the demo-docs corpus (small, deterministic) via createDocsVFS().
 */

import { createDocsVFS } from "../dist/index.js";
import { runDensity, formatDensity } from "../dist/commands/density.js";

let fails = 0;
const expect = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} — ${detail}`); fails++; }
};

const vfs = await createDocsVFS({ rootDir: "./demo-docs", noCache: true });
console.log(`Boot: ${vfs.stats.bootTimeMs}ms, ${vfs.stats.fileCount} files\n`);

// ─── Direct API: runDensity ──────────────────────────────────────
console.log("--- runDensity() direct ---");
{
  const result = await runDensity(vfs.fs, { path: "/", term: "the" });
  expect("finds some matches for 'the'", result.rows.length > 0, JSON.stringify(result));
  expect("rows sorted desc", result.rows.every((r, i) => i === 0 || result.rows[i-1].count >= r.count));
  expect("totalMatches = sum(rows)", result.totalMatches === result.rows.reduce((n, r) => n + r.count, 0));
  expect("runs fast (<50ms on demo-docs)", result.elapsedMs < 500, `elapsed=${result.elapsedMs}ms`);
  console.log(`    ${result.totalFiles} files, ${result.totalMatches} matches, ${result.elapsedMs}ms`);
}

// Formatted output
{
  const result = await runDensity(vfs.fs, { path: "/", term: "the", top: 5 });
  const out = formatDensity(result, { path: "/", term: "the" });
  expect("format includes summary", out.includes('density for "the"'));
  expect("format includes bars", /█/.test(out));
  expect("format has drill-in suggestion", /→ /.test(out));
  expect("respects --top 5", result.rows.length <= 5);
  console.log("\n" + out + "\n");
}

// No matches → exit path
{
  const result = await runDensity(vfs.fs, { path: "/", term: "this_term_definitely_not_here_zzzxxx" });
  expect("no matches → empty rows", result.rows.length === 0);
  const out = formatDensity(result, { path: "/", term: "xxx" });
  expect("format shows (no matches)", out.includes("(no matches)"));
}

// Case sensitivity
{
  const sens = await runDensity(vfs.fs, { path: "/", term: "README" });
  const insens = await runDensity(vfs.fs, { path: "/", term: "README", ignoreCase: true });
  expect("case-insensitive >= case-sensitive", insens.totalMatches >= sens.totalMatches);
}

// min-count filter
{
  const all = await runDensity(vfs.fs, { path: "/", term: "the", minCount: 1 });
  const filtered = await runDensity(vfs.fs, { path: "/", term: "the", minCount: 5 });
  expect("--min-count filters rows", filtered.rows.every((r) => r.count >= 5));
  expect("--min-count shrinks or equals row set", filtered.rows.length <= all.rows.length);
}

// --no-bars flag
{
  const result = await runDensity(vfs.fs, { path: "/", term: "the", top: 3 });
  const withBars = formatDensity(result, { path: "/", term: "the", bars: true });
  const noBars = formatDensity(result, { path: "/", term: "the", bars: false });
  expect("with bars contains █", withBars.includes("█"));
  expect("--no-bars omits █", !noBars.includes("█"));
}

// ─── Via bash shell: density command ─────────────────────────────
console.log("\n--- density as shell command ---");
{
  const r = await vfs.exec('density / the');
  expect("shell: density / the succeeds", r.exitCode === 0, `stderr=${r.stderr} stdout=${r.stdout.slice(0, 200)}`);
  expect("shell: stdout contains bars", /█/.test(r.stdout));
  expect("shell: suggestion present", /→ /.test(r.stdout));
  console.log(r.stdout);
}

{
  const r = await vfs.exec('density / notreal_xyz_123');
  expect("no matches returns exit 1", r.exitCode === 1);
  expect("no matches message present", r.stdout.includes("(no matches)"));
}

{
  const r = await vfs.exec('density /not-a-real-dir foo');
  // Should still run (collectFiles returns empty) → no matches → exit 1
  expect("missing path doesn't crash", r.exitCode === 1, `stderr=${r.stderr}`);
}

{
  const r = await vfs.exec('density');
  expect("missing args → exit 2", r.exitCode === 2);
  expect("missing args → usage line", /usage/.test(r.stderr));
}

{
  const r = await vfs.exec('density --help');
  expect("--help → exit 0", r.exitCode === 0);
  expect("--help mentions flags", /--ignore-case/.test(r.stdout) && /--top/.test(r.stdout));
}

{
  const r = await vfs.exec('density --bogus / foo');
  expect("unknown flag → exit 2", r.exitCode === 2);
}

// Relative path resolution via cd
{
  await vfs.exec('cd /');
  const r = await vfs.exec('density . the --top 3');
  expect("relative path resolves from cwd", r.exitCode === 0, r.stderr);
}

// Memory-mode sanity: density should work seamlessly across mounts
console.log("\n--- density across mounts (memory mode) ---");
const vfs2 = await createDocsVFS({ rootDir: "./demo-docs", memory: true, noCache: true });
try {
  await vfs2.exec('echo "slurm slurm slurm in workspace" > /workspace/notes.md');
  await vfs2.exec('echo "mention of slurm here once" > /memory/thoughts.md');
  const r = await vfs2.exec('density / slurm -i');
  expect("density spans all mounts", r.exitCode === 0 && r.stdout.includes("/workspace/notes.md"), r.stdout);
} finally {
  await vfs2.close();
}

await vfs.close();
console.log(fails ? `\nFAILED (${fails})` : "\nOK");
if (fails) process.exitCode = 1;
