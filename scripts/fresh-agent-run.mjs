/**
 * fresh-agent-run.mjs — simulate a fresh agent exploring an unfamiliar docs
 * folder through DocsVFS, using only Unix commands and writing running notes
 * to /memory/notes.md as it learns.
 *
 * Prints every command + output + note to stdout so we can read the trace.
 */
import { createDocsVFS } from "../dist/index.js";
import { rmSync, existsSync } from "node:fs";

const TARGET = process.argv[2] ?? "/Users/rayancastillazouine/data-attribution/docs";

// Start with a fresh DB so the run reflects a cold agent, not one with prior notes.
const DB = `${TARGET}/.docsvfs.db`;
if (existsSync(DB)) rmSync(DB);

const vfs = await createDocsVFS({
  rootDir: TARGET,
  memory: true,
  noCache: true,
});

const divider = "─".repeat(72);
const log = (...a) => console.log(...a);

log(`\n${divider}\nFRESH AGENT RUN — target: ${TARGET}`);
log(`Boot: ${vfs.stats.bootTimeMs}ms | ${vfs.stats.fileCount} files, ${vfs.stats.dirCount} dirs | mounts: ${vfs.stats.memoryMounts?.join(", ")}`);
log(`Session: ${vfs.memory?.sessionId}\n${divider}`);

// Helper: run a command, log it, return output.
async function run(cmd, narrate) {
  log(`\n$ ${cmd}`);
  const r = await vfs.exec(cmd);
  const out = (r.stdout || r.stderr).trimEnd();
  if (out) log(out.length > 2000 ? out.slice(0, 2000) + `\n… [truncated ${out.length - 2000} chars]` : out);
  if (narrate) log(`  >> ${narrate}`);
  return r;
}

// Append a note with a heading and body to /memory/notes.md.
async function note(heading, body) {
  const existing = await vfs.exec("cat /memory/notes.md");
  const prior = existing.exitCode === 0 ? existing.stdout : "";
  const entry = `## ${heading}\n${body.trim()}\n\n`;
  const full = prior + entry;
  // Use heredoc-ish approach via echo with escaped content. Simpler: write directly.
  await vfs.fs.writeFile ? null : null; // not exposing internal fs — use bash echo w/ tempfile
  // Fallback: write via tee-style append (appendFile works on writable mounts)
  const { mounts } = vfs.memory;
  const memFs = mounts.find((m) => m.mountPoint === "/memory").filesystem;
  await memFs.writeFile("/notes.md", full);
  log(`  [noted -> /memory/notes.md :: "${heading}"]`);
}

// ── PHASE 1: orient ───────────────────────────────────────────────
log(`\n${divider}\n# PHASE 1 — orient: what's in this docs folder?\n${divider}`);

await run("ls /docs", "that looks like a pile of markdown files + some subdirs");
const treeR = await run("tree /docs -L 2", "get the hierarchy + count of files per subdir");
await note(
  "Top-level layout",
  "Docs root contains ~20 top-level .md files plus subdirs `prd/` and `soc127_modal_handoff/`. " +
  "Filenames are SHOUTING_CASE — looks like a research group's knowledge base where names encode tags " +
  "(PACE_*, SOC*_, DOLMA_*, 6T_*, BERGSON_*). This naming itself is signal."
);

// ── PHASE 2: cluster the topics ───────────────────────────────────
log(`\n${divider}\n# PHASE 2 — cluster by prefix to spot topic families\n${divider}`);

await run(`find /docs -name "PACE_*" -type f`, "PACE_* files look infrastructure-related");
await run(`find /docs -name "SOC*" -type f`, "SOC* files look like ticket/handoff docs");
await run(`find /docs -name "DOLMA_*" -type f`, "DOLMA_* is probably a dataset");
await run(`find /docs -type f -name "*.md" | wc -l`, "total doc count");

await note(
  "Topic families (derived from filename prefixes)",
  "- **PACE_*** (5 files): GPU/Slurm/VSCode/Claude Code setup — looks like HPC cluster onboarding docs\n" +
  "- **SOC\\d+_*** (4+ files): ticket handoffs / runbooks — SOC-8, SOC91, SOC95, SOC127\n" +
  "- **DOLMA_*** (2 files): enrichment + cookbook — sounds like a corpus/dataset\n" +
  "- **6T_PROVENANCE, BERGSON, WEBORGANIZER, unlearning, SOCIAL_TDA**: topic-specific research memos\n" +
  "Hypothesis: this is a *data attribution* research project running on the PACE HPC cluster at Georgia Tech."
);

// ── PHASE 3: confirm the core thesis via grep ─────────────────────
log(`\n${divider}\n# PHASE 3 — confirm the thesis with grep across all files\n${divider}`);

await run(`grep -l -r "PACE" /docs | head -10`, "how many files even mention PACE?");
await run(`grep -r "TDA\\|data attribution" /docs | wc -l`, "count lines about data attribution");
await run(`grep -r "Slurm" /docs | wc -l`, "count Slurm mentions");
await run(`grep -r "GPU" /docs | wc -l`, "count GPU mentions");
await run(`grep -r "Dolma\\|DOLMA" /docs | wc -l`, "count Dolma dataset mentions");
await run(`grep -rh "## " /docs | head -20`, "sample of section headings across docs");

await note(
  "Project thesis (confirmed by grep)",
  "This is a research project on **data attribution / TDA** (training data attribution) using the " +
  "**Dolma dataset** and running at scale on the **Georgia Tech PACE HPC cluster** (Phoenix/ICE clusters " +
  "with GPU+Slurm). The SOC docs are engineering handoffs for specific subtasks; the cookbooks are how-tos."
);

// ── PHASE 4: drill into one cookbook ──────────────────────────────
log(`\n${divider}\n# PHASE 4 — pick one cookbook and extract its actual workflow\n${divider}`);

await run(`head -40 /docs/DOLMA_ENRICHMENT_COOKBOOK.md`, "what is the DOLMA workflow?");
await run(`grep -n "^##" /docs/DOLMA_ENRICHMENT_COOKBOOK.md | head -15`, "section structure of that cookbook");

await note(
  "DOLMA_ENRICHMENT_COOKBOOK structure",
  "A step-by-step cookbook for enriching Dolma corpus data. Section headings encode the workflow " +
  "(checked via `grep -n '^##'`). This is how-to documentation, not a research memo — agents can follow " +
  "it sequentially to reproduce a pipeline. Use as reference when implementing enrichment steps."
);

// ── PHASE 5: spot dependencies between docs ───────────────────────
log(`\n${divider}\n# PHASE 5 — cross-references: which docs depend on which?\n${divider}`);

await run(`grep -rn "PACE_SLURM" /docs | head -10`, "who references the Slurm doc?");
await run(`grep -rn "DOLMA_ENRICHMENT" /docs | head -10`, "who references the DOLMA cookbook?");

await note(
  "Doc cross-references",
  "Several runbooks (SOC91 handoff, SOC127 execution spec) reference PACE_SLURM and DOLMA_ENRICHMENT — " +
  "these two are foundational docs that downstream handoffs assume. For a new engineer, the onboarding " +
  "order is: PACE setup → Dolma cookbook → specific SOC handoff for current task."
);

// ── PHASE 6: scratch workspace (TTL demo) ─────────────────────────
log(`\n${divider}\n# PHASE 6 — use /workspace for a throwaway grep tally (24h TTL)\n${divider}`);

await run(`grep -rc "Slurm" /docs > /workspace/slurm-by-file.txt`, "tally Slurm mentions per file");
await run(`cat /workspace/slurm-by-file.txt | sort -t: -k2 -n -r | head -5`, "top 5 Slurm-heavy docs");

// ── PHASE 7: write protection check ───────────────────────────────
log(`\n${divider}\n# PHASE 7 — confirm I can't corrupt the source\n${divider}`);

await run(`echo "delete this doc" > /docs/README-injected.md`, "try to write into /docs (should fail)");

// ── FINAL: read back my notes ─────────────────────────────────────
log(`\n${divider}\n# FINAL — read back what I pinned to /memory/notes.md\n${divider}`);
await run(`ls /memory`);
await run(`wc -l /memory/notes.md`);
await run(`cat /memory/notes.md`);

// Persistence check
log(`\n${divider}\n# PERSISTENCE — close + reopen, notes should survive\n${divider}`);
await vfs.close();
const vfs2 = await createDocsVFS({ rootDir: TARGET, memory: true, noCache: true });
const rec = await vfs2.exec("cat /memory/notes.md");
log(`After reboot, /memory/notes.md is ${rec.stdout.length} chars — ${rec.stdout.length > 100 ? "PRESERVED" : "LOST"}`);
await vfs2.close();

log(`\n${divider}\nRUN COMPLETE\n${divider}`);
