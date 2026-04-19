# End-to-end: a DocsVFS session with memory

This is the full arc of an agent session using Phase 2 features. Run it yourself with `scripts/fresh-agent-run-v2.mjs <docs-folder>`.

## 1. Boot with writable mounts

```bash
npx docsvfs ./docs --memory
```

```
📁 docsvfs — Virtual filesystem for documentation
   Scanning: ./docs
   Found: 28 files in 4 directories
   Boot time: 8ms
   Mounts: /docs (read-only) + /memory /workspace (writable)
   Session: 7a3e-4c2b-...
```

Three mounts share one virtual namespace:

| Mount | Writable? | TTL | What goes here |
|---|---|---|---|
| `/docs` | no (EROFS) | — | source documentation |
| `/memory` | yes | none | notes you want to keep |
| `/workspace` | yes | 24h | scratch tallies, intermediate files |

Every write records `{session_id, source: "agent"|"human"|"auto"}` so the janitor can make provenance-aware decisions later.

## 2. Orient → cluster → drill

```bash
docsvfs:/docs$ tree / -L 2
docsvfs:/docs$ find /docs -name "PACE_*" -type f     # topic clustering
docsvfs:/docs$ density /docs Slurm -i                 # best file for a term
```

`density` replaces a pile of `grep -c | sort` pipes. The output includes ASCII bars and a drill-in suggestion: `cat <file>` when one file dominates, `grep -n <file>` when the top two are close.

## 3. Pin notes to /memory, scratch tallies to /workspace

```bash
docsvfs:/docs$ echo "Slurm primer lives in PACE_SLURM_PHOENIX.md" > /memory/refs.md
docsvfs:/docs$ grep -rc "Slurm" /docs > /workspace/slurm-by-file.txt
```

Anything in `/memory` survives forever. Anything in `/workspace` evaporates after 24h — you don't need to remember to clean it up.

## 4. Clean up before handoff

```bash
docsvfs:/docs$ janitor --dry-run      # what would change?
docsvfs:/docs$ janitor                # prune expired + dedup + flag + VACUUM
docsvfs:/docs$ janitor --aggressive   # also delete flagged stale agent-only notes
```

What janitor does, in order:

1. **Prune**: any row under `/workspace` whose TTL has passed
2. **Dedup**: within each mount, exact SHA-256 matches — keeps the oldest, drops copies
3. **Flag**: agent-only notes untouched for 24h (heuristic for hallucinations that were never confirmed) — reported, not deleted, unless `--aggressive`
4. **VACUUM**: reclaim space

Human-sourced notes are protected from the stale-flag. Notes that have been edited since creation (touched) are protected too.

## 5. Reboot — state survives

```bash
docsvfs:/docs$ exit
$ npx docsvfs ./docs --memory
docsvfs:/docs$ cat /memory/refs.md
Slurm primer lives in PACE_SLURM_PHOENIX.md
```

State is stored in `./docs/.docsvfs.db` (libSQL/Turso-compatible). One SQLite file, one composite primary key (`mount`, `path`), one process at a time.

## 6. Optional: semantic search over your notes

```bash
docker run -p 8000:8000 chromadb/chroma
npx docsvfs ./docs --memory --chroma
```

With both on, every write enqueues a durable indexing job. A background worker drains every 250ms (configurable) and upserts chunks into Chroma with metadata `{source, mount, path, chunk_index, provenance_source}`. A week later you can ask Chroma "what did I write about the Slurm scheduler" and it hits your `/memory` notes alongside the source docs.

If Chroma is briefly unavailable, rows stay queued with a per-attempt `last_error`. After 5 failures they stop being retried automatically and the next `janitor` run surfaces them for human review.

## Why this matters

Phase 1 gave agents a Unix shell over docs. Phase 2 gave them a place to write — without letting them corrupt source, without letting their mistakes accumulate forever. The janitor is the critical piece: agents hallucinate, and hallucinated notes left untouched are worse than no notes at all. Provenance + a 24h confidence window means a second session can forget what the first session wasn't sure about.
