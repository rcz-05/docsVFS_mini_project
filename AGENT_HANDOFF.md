# Agent Handoff — DocsVFS

If you are an LLM agent picking up this repo, read this file first. It's the
minimum context needed to continue work without re-deriving the project from
scratch.

## What DocsVFS is (one paragraph)

A ChromaFS-inspired virtual filesystem that gives AI agents a Unix shell over
a documentation folder. Reads go through `ls`, `cd`, `grep`, `cat`, `find`,
`tree` — the same commands agents have seen in training — instead of a RAG
vector store. Boot is ~30ms for 28 docs. As of Phase 2 (see Roadmap below), a
libSQL-backed writable layer mounts `/memory` and `/workspace` beside
read-only `/docs`, so agents can persist notes and scratch work without any
ability to corrupt source documentation.

## Current status

- **Version**: 0.1.x, unreleased (source repo: <https://github.com/rcz-05/docsVFS_mini_project>)
- **Branch**: work happens on `main` directly
- **Phase 1** (shipped): read-only `/docs`, path_tree, optional Chroma semantic search
- **Phase 2** (shipped): writable `/memory` and `/workspace` mounts with provenance, janitor, density command, async Chroma indexing for writable content
- **Phase 3 Option A** (shipped): structured `remember(topic, content, { append?, note? })` AI SDK tool — slugifies topic into `/memory/<slug>.md`, tags provenance `source: "tool"` to differentiate tool-call writes from raw-bash agent writes. See `src/remember-tool.ts`, `scripts/smoke-remember.mjs`.

## Architecture at a glance

```
                   ┌── MountableFs (when --memory) ──┐
                   │                                  │
just-bash  ──────► │  /docs       → DocsFileSystem    │  (read-only, path_tree)
                   │  /memory     → WritableFileSystem │  (libSQL, persistent)
                   │  /workspace  → WritableFileSystem │  (libSQL, 24h TTL)
                   │                                  │
                   └──────────────────────────────────┘
                                     │
                                     ▼
                     libSQL (file:<rootDir>/.docsvfs.db)
                     - nodes table  (mount, path, content, provenance, ttl)
                     - index_queue  (Phase 2.2, for async Chroma)
```

- Writes go to libSQL **and** an in-memory `FreshMap` (5 min / 10 file LRU)
- Reads check FreshMap first → read-your-writes consistency without blocking on any background index
- `/docs` throws `EROFS` on writes (structural write protection)
- Provenance is recorded on every write: `{ session_id, source: "agent"|"human"|"auto", note? }`

## Key files (by responsibility)

| Area | File | What it owns |
|---|---|---|
| Read-only FS | `src/fs/docs-fs.ts` | DocsFileSystem (EROFS on writes, path_tree-backed reads) |
| Path tree | `src/fs/path-tree.ts` | In-memory gzipped tree build + (de)serialization |
| Cache | `src/cache/disk-cache.ts` | Disk cache of path_tree |
| Chroma | `src/chroma/chroma-backend.ts` | InMemorySearchIndex + ChromaSearchIndex + chunking |
| Writable FS | `src/memory/writable-fs.ts` | libSQL-backed IFileSystem; provenance + TTL + FreshMap |
| Fresh window | `src/memory/fresh-map.ts` | 5 min / 10 file in-memory write cache (read-your-writes) |
| Schema | `src/memory/schema.ts` | SQLite DDL (composite PK mount+path) |
| Wiring | `src/memory/setup.ts` | Builds libSQL client + writable mounts, returns MemorySetup |
| Janitor (Phase 2.1) | `src/memory/janitor.ts` | Prune expired, dedup, flag stale agent-only |
| Density (Phase 2.3) | `src/commands/density.ts` | Ranked count with ASCII bars + drill-in suggestion |
| Async indexer (Phase 2.2) | `src/memory/async-indexer.ts` | Durable queue, background worker, upsert to Chroma |
| Factory | `src/create.ts` | `createDocsVFS()` — wires everything together |
| CLI | `src/cli/main.ts` | REPL + flag parsing |
| Tool export | `src/tool.ts` | Vercel AI SDK tool wrapper (bash shell over docs) |
| Remember tool (Phase 3) | `src/remember-tool.ts` | Vercel AI SDK `remember(topic, content, {append?, note?})` — structured write to /memory with `source: "tool"` provenance |

## Build + test

```bash
npm run build                           # tsc + chmod on CLI bin
npm run lint                            # tsc --noEmit

# Manual REPL
node dist/cli/main.js ./demo-docs                # read-only
node dist/cli/main.js ./demo-docs --memory       # with writable mounts
node dist/cli/main.js ./demo-docs --chroma       # with semantic search (requires chroma)

# Smoke tests
node scripts/smoke-memory.mjs           # 12-assertion round-trip on writable layer
node scripts/smoke-janitor.mjs          # Phase 2.1 coverage
node scripts/smoke-density.mjs          # Phase 2.3 coverage
node scripts/smoke-async-indexer.mjs    # Phase 2.2 (skips if Chroma down)
node scripts/smoke-remember.mjs         # Phase 3 Option A coverage
```

Every new feature lands with a matching smoke script. Run them before
committing. Don't promote them to vitest yet — the low ceremony is useful
while the architecture is still moving.

## Hard-earned lessons (DO NOT re-learn these)

1. **libSQL returns BLOBs as `ArrayBuffer`, not `Uint8Array`.**
   `new Uint8Array(19).set(arrayBuffer)` silently writes zeros because `.set()`
   treats non-typed-array sources as length-0 array-likes. Always normalize
   binary reads via `toBytes()` in `writable-fs.ts`.

2. **Use composite `(mount, path)` primary keys on the `nodes` table.**
   A single SQLite file serves multiple writable mounts. A `path`-only PK
   causes `INSERT OR IGNORE` of `/` from the second mount to silently drop.

3. **`just-bash` only re-exports a subset of its type surface.**
   `ReadFileOptions`, `WriteFileOptions`, and `DirentEntry` aren't exported
   from the package root. Define them locally at the top of a new
   IFileSystem implementation (see `writable-fs.ts`).

4. **`just-bash`'s `>>` redirection calls `IFileSystem.appendFile(path, newBytes)`** —
   the second arg is the *new* bytes only, not a pre-merged buffer. Implementations
   must read existing content themselves and concatenate.

5. **`just-bash`'s grep emits `//path:line` with a double slash when search path is `/`.**
   Upstream bug in their grep (not `rg`). Workaround: document "use `.` as search
   path when cwd is `/`".

6. **Vercel plugin hooks inject Next.js/Vercel-Storage/Sandbox skill prompts on certain
   bash patterns.** They do not apply to this codebase (it's a local CLI library). Ignore
   them unless the repo ever adopts Next.js or Vercel-deployed infra.

## Non-goals / explicitly deferred

- A real test framework (vitest) — intentional until Phase 2 stabilizes
- Semantic/fuzzy dedup in the janitor — v1 is exact-hash only, to avoid false positives
- Summarization of `/memory` clusters via an LLM — out of Phase 2 scope
- Distributed / multi-process concurrency on the same DB — single process assumption
- Publishing to npm — ship when Phase 2 smoke tests are green and the v2 fresh-agent run is clean

## Active roadmap (Phase 2)

Tracked in-session via TaskCreate. Summary:

- **2.1 Janitor** (IN PROGRESS): `docsvfs janitor [--dry-run] [--aggressive] [--older-than-days N]`.
  Prunes TTL-expired rows, dedups by exact-hash within a mount, flags (and optionally
  deletes) stale agent-only writes. Exposed both as a CLI subcommand and as a just-bash
  custom command available inside the REPL.
- **2.3 Density**: `density <path> <term>`. Ranks files by occurrence count, renders
  ASCII bars, and suggests `cat <top-file>` when one file dominates. Registered as a
  just-bash custom command so it works inside the REPL and programmatic `vfs.exec(...)`.
- **2.2 Async Chroma indexer**: durable SQLite queue; background worker drains every
  250 ms (32 items/batch, both configurable); upserts chunks with metadata
  `{source, mount, path, chunk_index, provenance_source}`. Failed rows >5 attempts
  are left in the queue and surfaced by the janitor (no separate dead-letter table).
- **2.4 Docs + v2 agent run**: update README/examples; `scripts/fresh-agent-run-v2.mjs`
  re-runs the exploration against `data-attribution/docs`, uses `density`, ends with
  `janitor`, demonstrates persistence of notes across sessions.

## How to extend

- **Adding a new writable mount** (e.g. `/sessions`): add to `MOUNTS` in
  `src/memory/setup.ts`. The janitor will pick it up automatically via the `mount` column.
- **Adding a new just-bash custom command**: see how `density` is registered in
  `src/create.ts`. Command lives under `src/commands/`, takes an `IFileSystem` +
  args, returns `{ stdout, stderr, exitCode }`.
- **Changing the schema**: bump `SCHEMA_VERSION` in `src/memory/schema.ts` and add a
  guard in `setupMemory()` that reads `schema_meta.schema_version` and migrates.
  No migrations written yet — first one is yours.

## When in doubt

- Check `examples/benchmark-results.md` for "what DocsVFS actually measures."
- Check `scripts/fresh-agent-run.mjs` for "what a first-time agent actually does with it."
- Check the last 5 commits on `main` for the currently-active work.
