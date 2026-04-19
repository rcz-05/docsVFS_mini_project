# DocsVFS vs Traditional RAG — Benchmark Results

Tested against 28 real documentation files (320KB, 610+ chunks).

## Boot

| | DocsVFS | RAG |
|---|---|---|
| Boot time | **18ms** | 7ms |
| Files indexed | 28 | 28 |
| Chunks created | 614 | 610 |

## Query Comparison

### "Show the doc structure"

**DocsVFS** — `tree / -L 2` (6ms):
```
/
|-- 6T_PROVENANCE_PIPELINE.md
|-- BERGSON_COOKBOOK.md
|-- prd/
|   └── SOC-8.md
|-- soc127_modal_handoff/
|   |-- 00_README.md
|   |-- 01_master_agent_prompt.md
|   |-- 02_execution_spec.md
|   |-- 03_runbook.md
|   └── ...
└── unlearning.md

2 directories, 28 files
```

**RAG**: Flat file list. No hierarchy, no directory structure, no file counts.

---

### "Find all mentions of GPU"

**DocsVFS** — `grep -r "GPU" .` (17ms):
- Returns exact lines with `filename:matching line` format
- 100+ lines across 13 files
- Can pipe to `wc -l`, `sort`, `head`, `grep` again

**RAG**: Returns 82 chunks. No line numbers, arbitrary chunk boundaries, no composability.

---

### "How many lines mention Slurm?"

**DocsVFS** — `grep -r "Slurm" . | wc -l` → **77** (10ms, one command)

**RAG**: Must iterate all chunks, split into lines, count manually. Not a native operation.

---

### "Read first 15 lines of a specific file"

**DocsVFS** — `cat /DOLMA_ENRICHMENT_COOKBOOK.md | head -15` (3ms, exact)

**RAG**: Reassemble chunks for that file, hope ordering is preserved, may lose formatting.

---

### Write protection

**DocsVFS** — `echo "hack" > /test.txt` → `EROFS: read-only file system`
Writes are impossible at the filesystem level.

**RAG**: No built-in write protection. Agent typically has access to the embedding DB and source files.

---

## Semantic Search (--chroma mode)

With Chroma enabled, DocsVFS adds semantic search on top of Unix commands.
These queries return **zero results** with grep but find the right docs via Chroma:

| Natural language query | grep | Chroma |
|---|---|---|
| "compute resource allocation and scheduling" | 0 results | PACE_SLURM_PHOENIX.md |
| "how to run machine learning training jobs" | 0 results | PACE_SLURM_PHOENIX.md, slurm_example.md |
| "data pipeline reliability and error recovery" | 0 results | soc127 execution_spec, runbook, validation |
| "what hardware is available and how much does it cost" | 0 results | PACE_GPU_PHOENIX.md, PACE_ICE_MAKERSPACE.md |
| "debugging failed jobs on the cluster" | 0 results | 6T_PROVENANCE_PIPELINE.md, SOC91 handoff |

The combined workflow: **Chroma finds docs by meaning → grep pinpoints exact lines → cat reads full context.**

---

## Phase 2 additions

Measured against the same 28-file corpus with `--memory` enabled.

### Density

| Query | Time | Notes |
|---|---|---|
| `density /docs Slurm -i` | 1–2ms | Walks 28 files, ranks 8 hits, suggests `cat` when one file dominates |
| `density / "data attribution" -i` | 1–2ms | Spans `/docs`, `/memory`, `/workspace` in one pass |

One command replaces a grep + `wc -l` per file pipeline. Output includes ASCII bars plus a drill-in hint (`cat` when the top file dominates, `grep -n` otherwise).

### Janitor

Seeded DB: 2 expired `/workspace` rows, 2 duplicate pairs in `/memory`, 1 stale agent-only note, 1 fresh agent note, 1 human-sourced note.

| Mode | Time | Result |
|---|---|---|
| `janitor --dry-run` | 1ms | Reports 2 expired, 3 dedup drops, 1 flagged stale — zero mutations |
| `janitor` | 2–3ms | Prunes + dedups + flags + VACUUMs; 5 rows removed |
| `janitor --aggressive` | 2–3ms | Also deletes the flagged hallucination |

Exact SHA-256 dedup within a mount, so similar-but-distinct notes never merge silently. Human-sourced notes are always protected from the stale-flag.

### Async Chroma indexer

With `--memory` and `--chroma` both on, writes to `/memory` and `/workspace` queue durably in SQLite and drain every 250ms (32 items/batch, both configurable). Tested end-to-end with a real Chroma server: a note written under `/memory` becomes searchable by `chroma.coarseFilter` within one poll cycle. Failed rows accumulate attempts + `last_error`; the janitor surfaces any row with attempts ≥ 5 so a human can investigate.

### The "persistent hallucination" failure mode — fixed

Phase 1's fresh-agent run wrote a note asserting *"Several runbooks reference PACE_SLURM AND DOLMA_ENRICHMENT"* — which grep could not actually confirm. That kind of note persists forever unless something scrubs it. Phase 2's janitor flags it (agent-only, untouched for 24h) and `--aggressive` removes it. `scripts/fresh-agent-run-v2.mjs` reproduces this exact fix end-to-end.
