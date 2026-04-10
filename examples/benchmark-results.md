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
