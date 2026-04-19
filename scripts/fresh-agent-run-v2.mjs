/**
 * fresh-agent-run-v2.mjs — Phase 2 fresh-agent run.
 *
 * Same shape as fresh-agent-run.mjs but uses the Phase 2 additions:
 *   - `density` instead of blind grep-tallying to find the best file for a term
 *   - a deliberately-duplicated note to demonstrate dedup
 *   - a stale "hallucinated" note so the janitor has something to flag
 *   - `janitor --dry-run` inside the REPL, then a real `janitor` at the end
 *
 * Prints every command + output so the trace reads like an agent session.
 */
import { createDocsVFS } from "../dist/index.js";
import { rmSync, existsSync } from "node:fs";

const TARGET = process.argv[2] ?? "/Users/rayancastillazouine/data-attribution/docs";

// Fresh DB so the run starts cold.
const DB = `${TARGET}/.docsvfs.db`;
if (existsSync(DB)) rmSync(DB);

const vfs = await createDocsVFS({
  rootDir: TARGET,
  memory: true,
  noCache: true,
});

const divider = "─".repeat(72);
const log = (...a) => console.log(...a);

log(`\n${divider}\nFRESH AGENT RUN v2 — target: ${TARGET}`);
log(`Boot: ${vfs.stats.bootTimeMs}ms | ${vfs.stats.fileCount} files, ${vfs.stats.dirCount} dirs | mounts: ${vfs.stats.memoryMounts?.join(", ")}`);
log(`Session: ${vfs.memory?.sessionId}\n${divider}`);

async function run(cmd, narrate) {
  log(`\n$ ${cmd}`);
  const r = await vfs.exec(cmd);
  const out = (r.stdout || r.stderr).trimEnd();
  if (out) log(out.length > 2000 ? out.slice(0, 2000) + `\n… [truncated ${out.length - 2000} chars]` : out);
  if (narrate) log(`  >> ${narrate}`);
  return r;
}

async function note(heading, body) {
  const existing = await vfs.exec("cat /memory/notes.md");
  const prior = existing.exitCode === 0 ? existing.stdout : "";
  const entry = `## ${heading}\n${body.trim()}\n\n`;
  const { mounts } = vfs.memory;
  const memFs = mounts.find((m) => m.mountPoint === "/memory").filesystem;
  await memFs.writeFile("/notes.md", prior + entry);
  log(`  [noted -> /memory/notes.md :: "${heading}"]`);
}

// ── PHASE 1: orient ────────────────────────────────────────────────
log(`\n${divider}\n# PHASE 1 — orient\n${divider}`);
await run("ls /docs", "mass of SHOUTING_CASE markdown — prefixes encode topic tags");
await run("tree /docs -L 2", "get the hierarchy");

await note(
  "Corpus layout",
  "~20 top-level .md files + subdirs. Prefixes cluster into PACE_*, SOC*_, DOLMA_*, 6T_*, BERGSON_*. " +
  "Likely a data-attribution research group running on Georgia Tech's PACE HPC."
);

// ── PHASE 2: density over blind grep ───────────────────────────────
log(`\n${divider}\n# PHASE 2 — use density to surface the Slurm-heaviest files\n${divider}`);
await run(`density /docs Slurm -i`, "ranked by occurrence count with ASCII bars + drill-in suggestion");
await run(`density /docs "data attribution" -i --top 5`, "which files really teach data attribution?");
await run(`density /docs DOLMA --top 3`, "narrow to DOLMA-centric files");

await note(
  "Density findings",
  "For Slurm: one file dominates — `density` suggests `cat` over `grep`. " +
  "For data attribution: 5 files share the term but one is authoritative. " +
  "For DOLMA: three cookbook-flavored files. Follow-up reads are targeted, not shotgun."
);

// ── PHASE 3: drill into the winner ─────────────────────────────────
log(`\n${divider}\n# PHASE 3 — drill into the density winner\n${divider}`);
await run(`head -30 /docs/PACE_SLURM.md`, "top of the Slurm primer");
await run(`grep -n "^##" /docs/PACE_SLURM.md | head -10`, "section structure");

await note(
  "PACE_SLURM.md outline",
  "Slurm primer for PACE cluster. Covers `sbatch`, `salloc`, partitions, and GPU requests. " +
  "Use this as the canonical Slurm reference; other docs only allude to it."
);

// ── PHASE 4: demonstrate janitor targets ───────────────────────────
log(`\n${divider}\n# PHASE 4 — seed conditions the janitor will clean up\n${divider}`);
// Exact duplicate of an earlier note → dedup
await run(`echo "Slurm primer lives in PACE_SLURM.md" > /memory/slurm-ref.md`, "canonical reference note");
await run(`echo "Slurm primer lives in PACE_SLURM.md" > /memory/slurm-ref-copy.md`, "accidental duplicate");

// A TTL'd scratch that's already expired (older than now)
const { mounts } = vfs.memory;
const ws = mounts.find((m) => m.mountPoint === "/workspace").filesystem;
await ws.writeFile("/stale-scratch.md", "notes I stopped caring about");
// Expire it by patching the ttl in the DB directly
await vfs.memory.client.execute({
  sql: `UPDATE nodes SET ttl_expires_at = ? WHERE mount='/workspace' AND path='/stale-scratch.md'`,
  args: [Date.now() - 60 * 60 * 1000],
});
log(`  [expired /workspace/stale-scratch.md — TTL set 1h in the past]`);

// A "hallucinated" agent note that's been sitting untouched for 2 days
const memFs = mounts.find((m) => m.mountPoint === "/memory").filesystem;
await memFs.writeFile("/hallucination.md", "several runbooks reference PACE_SLURM AND DOLMA_ENRICHMENT");
const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
await vfs.memory.client.execute({
  sql: `UPDATE nodes SET created_at = ?, updated_at = ? WHERE mount='/memory' AND path='/hallucination.md'`,
  args: [twoDaysAgo, twoDaysAgo],
});
log(`  [aged /memory/hallucination.md to 48h old, untouched since creation]`);

// ── PHASE 5: janitor dry-run ───────────────────────────────────────
log(`\n${divider}\n# PHASE 5 — janitor --dry-run: see what would happen\n${divider}`);
await run(`janitor --dry-run`, "report only; should show 1 expired + 1 dedup pair + 1 flagged stale");

// ── PHASE 6: janitor for real ──────────────────────────────────────
log(`\n${divider}\n# PHASE 6 — janitor: actually prune + dedup + VACUUM\n${divider}`);
await run(`janitor`, "note: flagged stale is reported, not auto-deleted");
await run(`ls /memory`, "duplicate should be gone, hallucination still present (flagged)");
await run(`ls /workspace`, "expired scratch should be gone");

// ── PHASE 7: aggressive mode removes flagged ────────────────────────
log(`\n${divider}\n# PHASE 7 — janitor --aggressive: delete flagged agent-only notes\n${divider}`);
await run(`janitor --aggressive`, "this is the one that kills hallucinated persistent notes");
await run(`ls /memory`, "hallucination.md should now be gone");

// ── FINAL: persistence check ───────────────────────────────────────
log(`\n${divider}\n# FINAL — persistence across reboot\n${divider}`);
await vfs.close();
const vfs2 = await createDocsVFS({ rootDir: TARGET, memory: true, noCache: true });
const recNotes = await vfs2.exec("cat /memory/notes.md");
const recRef = await vfs2.exec("cat /memory/slurm-ref.md");
const recHalluc = await vfs2.exec("cat /memory/hallucination.md");
log(`/memory/notes.md:         ${recNotes.stdout.length} chars — ${recNotes.stdout.length > 100 ? "PRESERVED" : "LOST"}`);
log(`/memory/slurm-ref.md:     ${recRef.exitCode === 0 ? "PRESERVED (canonical dup was kept)" : "LOST"}`);
log(`/memory/hallucination.md: ${recHalluc.exitCode === 0 ? "STILL HERE (bad)" : "REMOVED by --aggressive"}`);
await vfs2.close();

log(`\n${divider}\nRUN v2 COMPLETE\n${divider}`);
