# docsvfs

A [ChromaFS](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant)-inspired virtual filesystem for documentation. Give AI agents a Unix shell over your docs — they already know `ls`, `cd`, `grep`, `cat`, and `find`.

## Why?

AI agents converge on filesystems as their primary interface. Instead of forcing RAG pipelines or sandboxed environments, DocsVFS presents any folder of documentation as a read-only virtual filesystem that agents can explore with standard Unix commands.

**Architecture** (mirrors Mintlify's ChromaFS):

- **Boot**: Scan folder → build gzipped `path_tree` JSON → cache to disk (~9ms for 7 files)
- **`ls` / `cd` / `find`**: Resolved from in-memory path tree (zero I/O)
- **`cat`**: Read from real filesystem with LRU cache
- **`grep -r`**: In-memory chunk search (or optional Chroma coarse filter)
- **Writes**: Throw `EROFS` (read-only file system) — stateless, zero risk

Built on [just-bash](https://github.com/nichochar/just-bash) (TypeScript bash reimplementation by Vercel Labs) with a custom `IFileSystem` backend.

## Quick Start

```bash
# Install
npm install docsvfs

# Start a REPL over any docs folder
npx docsvfs ./my-docs
```

Inside the REPL:

```bash
docsvfs:/$ tree / -L 2
/
|-- api-reference
|   |-- overview.md
|   `-- transactions.md
|-- architecture
|   |-- database-schema.md
|   `-- system-overview.md
`-- guides
    |-- error-handling.md
    |-- getting-started.md
    `-- webhooks.md

docsvfs:/$ grep -r "authentication" /
/architecture/system-overview.md: Kong-based API gateway handling authentication...
/guides/error-handling.md: `authentication_error` — The API key is invalid...

docsvfs:/$ cat /guides/getting-started.md | head -10

docsvfs:/$ find / -name "*.md" | wc -l
7
```

## Programmatic Usage

```typescript
import { createDocsVFS } from "docsvfs";

const vfs = await createDocsVFS({ rootDir: "./docs" });

// Run any bash command
const result = await vfs.exec('grep -r "API key" /');
console.log(result.stdout);

// Stats
console.log(vfs.stats);
// { fileCount: 7, dirCount: 4, chunkCount: 41, bootTimeMs: 9 }
```

## AI SDK Tool Integration

Use DocsVFS as a tool for any AI agent via the Vercel AI SDK:

```typescript
import { createDocsVFSTool } from "docsvfs/tool";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const docsTool = await createDocsVFSTool({ rootDir: "./docs" });

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: { docs: docsTool },
  prompt: "What authentication methods does this API support?",
});
```

The agent will autonomously run `tree`, `grep`, and `cat` to find the answer — just like a developer would.

### Pairing with `remember()`

When you boot DocsVFS with `memory: true`, pair `docsTool` with a structured
`remember()` tool so the agent can pin durable notes into `/memory` without
quoting bash strings. Tool-call writes are tagged `source: "tool"` so the
janitor can later distinguish them from raw-bash writes.

```typescript
import { createDocsVFS } from "docsvfs";
import { createDocsVFSTool } from "docsvfs/tool";
import { createRememberTool } from "docsvfs/remember";

const vfs = await createDocsVFS({ rootDir: "./docs", memory: true });
const docs = await createDocsVFSTool({ rootDir: "./docs", memory: true });
const remember = createRememberTool({ vfs });

await generateText({
  model: openai("gpt-4o"),
  tools: { docs, remember },
  prompt:
    "Explore the docs and pin a one-paragraph summary of the Slurm setup " +
    "under the topic 'slurm-primer'.",
});

// remember({ topic: "Slurm primer", content: "...", note?: "source query" })
// writes /memory/slurm-primer.md and returns { ok, path, bytes, mode }.
// Pass { append: true } to append instead of overwrite.
```

## Chroma Mode

For larger doc sets, enable Chroma for semantic search alongside keyword grep:

```bash
# Start Chroma server
docker run -p 8000:8000 chromadb/chroma

# Run with Chroma enabled
npx docsvfs ./docs --chroma
```

This mirrors ChromaFS's coarse-to-fine filtering: `grep` queries Chroma's `$contains` first, then runs regex in-memory on matching files only.

## Writable Mounts (Phase 2)

Pass `--memory` to mount two writable filesystems alongside read-only `/docs`:

```bash
npx docsvfs ./docs --memory
```

```
/docs        read-only (EROFS on writes)   ←   your documentation
/memory      persistent                    ←   notes that survive across sessions
/workspace   24h TTL                       ←   scratch that garbage-collects itself
```

Every write records provenance (`session_id`, `source: "agent"|"human"|"auto"`) so you can audit or prune later. State is stored in `<folder>/.docsvfs.db` (libSQL).

### Janitor

Clean up the writable layer with provenance-aware rules:

```bash
# Inside the REPL:
docsvfs:/docs$ janitor --dry-run         # report only
docsvfs:/docs$ janitor                   # prune expired + dedup + flag + VACUUM
docsvfs:/docs$ janitor --aggressive      # also delete flagged stale agent-only writes

# Or standalone:
npx docsvfs janitor ./docs --dry-run
```

- **Prune**: TTL-expired rows under `/workspace`
- **Dedup**: exact SHA-256 match within a mount — keeps the oldest, drops copies
- **Flag**: agent-only writes older than 24h with no subsequent edits
  (hallucinated notes that were never confirmed)
- **VACUUM**: reclaim space

### Density

Rank files by occurrence count of a term — faster than re-reading grep output:

```bash
docsvfs:/docs$ density /docs Slurm -i
density for "Slurm" in /docs — 8 file(s), 64 total match(es)

  /docs/PACE_SLURM_PHOENIX.md          32  ████████████████████████
  /docs/PACE_SLURM_ICE.md              13  █████████
  /docs/SOC127_EXECUTION.md             9  ██
  ...

→ /docs/PACE_SLURM_PHOENIX.md dominates. Try: cat /docs/PACE_SLURM_PHOENIX.md
```

Density works across all mounts — `density / myterm` covers `/docs`, `/memory`, and `/workspace` in one pass.

### Async Chroma indexing

When `--memory` and `--chroma` are both on, every write to `/memory` or `/workspace` is enqueued (durably, in SQLite) for background embedding into Chroma. On the next boot, semantic search and grep span your notes as well as the source docs. Failed rows stay in the queue and are surfaced by the janitor once they hit 5 attempts.

## CLI Options

```
docsvfs <folder>              Start REPL over docs
docsvfs <folder> --chroma     Enable Chroma backend
docsvfs <folder> --chroma-url URL   Custom Chroma URL
docsvfs <folder> --memory     Mount writable /memory and /workspace
docsvfs <folder> --memory-db URL    Override libSQL URL
docsvfs <folder> --no-cache   Skip disk cache

docsvfs janitor <folder> [--dry-run|--aggressive|--older-than-days N]
```

## How It Works

1. **Path Tree**: On first run, DocsVFS recursively scans the target folder for doc files (`.md`, `.mdx`, `.txt`, `.yaml`, `.json`, etc.) and builds an in-memory tree structure — exactly like ChromaFS's `__path_tree__` document.

2. **Disk Cache**: The path tree is serialized as gzipped JSON to `~/.cache/docsvfs/` so subsequent runs boot instantly.

3. **IFileSystem**: DocsVFS implements just-bash's `IFileSystem` interface. All read operations resolve against the path tree + real filesystem. All write operations throw `EROFS`.

4. **Search Index**: Documents are chunked into ~500-char segments. In basic mode, chunks are searched in-memory. In Chroma mode, chunks are stored with `page_slug` + `chunk_index` metadata for the same coarse→fine grep pattern ChromaFS uses.

## Supported File Types

`.md` `.mdx` `.txt` `.rst` `.html` `.htm` `.json` `.yaml` `.yml` `.toml`

## License

MIT
