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

## Chroma Mode

For larger doc sets, enable Chroma for semantic search alongside keyword grep:

```bash
# Start Chroma server
docker run -p 8000:8000 chromadb/chroma

# Run with Chroma enabled
npx docsvfs ./docs --chroma
```

This mirrors ChromaFS's coarse-to-fine filtering: `grep` queries Chroma's `$contains` first, then runs regex in-memory on matching files only.

## CLI Options

```
docsvfs <folder>              Start REPL over docs
docsvfs <folder> --chroma     Enable Chroma backend
docsvfs <folder> --chroma-url URL   Custom Chroma URL
docsvfs <folder> --no-cache   Skip disk cache
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
