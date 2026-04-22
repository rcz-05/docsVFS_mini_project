# docsvfs

**Context7 for your own docs, with a memory the agent keeps between sessions.**

An [MCP](https://modelcontextprotocol.io) server that mounts any local
documentation folder as a Unix-shell-addressable virtual filesystem —
plus a writable `/memory` mount tagged with provenance so findings
survive across MCP sessions. Ships as an MCP server first, a CLI REPL
second, and a Vercel AI SDK library third.

## Why an MCP server

Agents converge on filesystems. `ls`, `cat`, `grep`, `find`, `tree` —
that's vocabulary every model was trained on. Other doc-tooling MCPs
either invent a new query surface (Context7), stay public-read-only
(GitMCP), or expose a generic filesystem with no doc awareness and no
memory (`@modelcontextprotocol/server-filesystem`). DocsVFS's lane is
private/local docs, Unix primitives, and a writable provenance-tagged
`/memory` mount that the janitor can audit later.

Positioning details + competitive claims + testing layers live in
[`MCP_POSITIONING.md`](MCP_POSITIONING.md); the wire contract for the
four tools is locked in [`MCP_TOOL_SCHEMAS.md`](MCP_TOOL_SCHEMAS.md).

## Install — MCP server

Add DocsVFS to your client's MCP config (Claude Desktop, Claude Code,
Cursor, Zed, etc.). One block, stdio transport, no server process to
manage:

```json
{
  "mcpServers": {
    "docsvfs": {
      "command": "npx",
      "args": [
        "-y",
        "docsvfs",
        "/absolute/path/to/your/docs",
        "--memory"
      ]
    }
  }
}
```

> Smithery, Cursor deeplink, and `.mcpb` bundle install paths follow
> once registry publication lands — see
> [`MCP_POSITIONING.md §4`](MCP_POSITIONING.md#4-distribution).

### Startup modes

| Flag              | Effect                                                                  |
|-------------------|-------------------------------------------------------------------------|
| *(none)*          | Read-only. Exposes `docs`, `density`, `stats`.                          |
| `--memory`        | Adds `remember` + writable `/memory` (persistent) and `/workspace` (24h TTL). SQLite at `<path>/.docsvfs.db`. |
| `--memory --chroma` | Semantic search via Chroma; writes are async-indexed into the vector store. |

## Tools

Each tool's input schema, response shape, and error cases are locked in
[`MCP_TOOL_SCHEMAS.md`](MCP_TOOL_SCHEMAS.md). Summary:

| Tool       | One-liner                                                                                             |
|------------|-------------------------------------------------------------------------------------------------------|
| `docs`     | Run a bash command over the VFS. `ls`, `cat`, `grep`, `find`, `tree`, pipes, redirects. Writes to `/docs` return EROFS. |
| `remember` | Structured write to `/memory/<slug>.md` with overwrite/append. Tagged `source: "tool"` in provenance. Available only with `--memory`. |
| `density`  | Rank files under a path by occurrence count of a term. Returns ranked rows with ASCII bars + a drill-in suggestion. |
| `stats`    | Per-mount file counts, total bytes, last-write timestamp, chunk-index size, server boot time. No bash overhead. |

Inspector transcripts proving schema validity and clean responses live
in [`tests/inspector/`](tests/inspector/).

## Non-MCP surfaces

The library and CLI are still supported — they're the shared core the
MCP server wraps, and they remain useful for non-MCP embedders.

### CLI REPL (explore docs from a terminal)

```bash
npm install -g docsvfs     # or: npx docsvfs ./my-docs
docsvfs ./my-docs          # REPL
```

```bash
docsvfs:/$ tree / -L 2
/
|-- api-reference
|-- architecture
`-- guides

docsvfs:/$ grep -r "authentication" /
docsvfs:/$ cat /guides/getting-started.md | head -10
docsvfs:/$ find / -name "*.md" | wc -l
```

### Programmatic (Node)

```typescript
import { createDocsVFS } from "docsvfs";

const vfs = await createDocsVFS({ rootDir: "./docs" });
const result = await vfs.exec('grep -r "API key" /');
console.log(result.stdout);
```

### Vercel AI SDK tool

Shipped alongside the MCP server for non-MCP embedders. Same underlying
primitives — `createDocsVFS` + `createRememberTool`:

```typescript
import { createDocsVFS } from "docsvfs";
import { createDocsVFSTool } from "docsvfs/tool";
import { createRememberTool } from "docsvfs/remember";
import { generateText } from "ai";

const vfs = await createDocsVFS({ rootDir: "./docs", memory: true });
const docs = await createDocsVFSTool({ rootDir: "./docs", memory: true });
const remember = createRememberTool({ vfs });

await generateText({
  // Routes through Vercel AI Gateway — no provider SDK import needed.
  model: "openai/gpt-4o",
  tools: { docs, remember },
  prompt: "Summarize the Slurm setup and pin it.",
});
```

## Chroma mode (optional)

For larger doc sets, semantic search alongside keyword grep:

```bash
docker run -p 8000:8000 chromadb/chroma
npx docsvfs ./docs --chroma         # CLI mode
# or pass --chroma to docsvfs-mcp for the MCP server.
```

This mirrors ChromaFS's coarse-to-fine filtering: grep queries Chroma's
`$contains` first, then runs regex in-memory on matching files only.

## Writable mounts (`--memory`)

```
/docs        read-only (EROFS on writes)   ←   your documentation
/memory      persistent                    ←   notes that survive across sessions
/workspace   24h TTL                       ←   scratch that garbage-collects itself
```

Every write records provenance — `session_id` and `source`
(`agent` / `tool` / `human` / `auto`) — so you can audit or prune later.
State lives in `<folder>/.docsvfs.db` (libSQL / SQLite).

### Janitor (CLI only — intentionally agent-unreachable)

```bash
npx docsvfs janitor ./docs --dry-run
npx docsvfs janitor ./docs               # prune expired + dedup + flag + VACUUM
npx docsvfs janitor ./docs --aggressive  # also delete flagged stale agent-only writes
```

- **Prune**: TTL-expired rows under `/workspace`
- **Dedup**: exact SHA-256 match within a mount — keeps the oldest
- **Flag**: agent-only writes older than 24h with no subsequent edits
- **VACUUM**: reclaim space

Janitor is deliberately not exposed as an MCP tool — destructive
operations stay human-gated. See
[`MCP_POSITIONING.md §3`](MCP_POSITIONING.md#3-tool-surface).

## Architecture

Mirrors Mintlify's [ChromaFS](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant):

- **Boot**: Scan folder → build gzipped `path_tree` JSON → cache to disk (~9ms for 7 files)
- **`ls` / `cd` / `find`**: Resolved from in-memory path tree (zero I/O)
- **`cat`**: Read from real filesystem with LRU cache
- **`grep -r`**: In-memory chunk search (or Chroma coarse filter + regex)
- **Writes to `/docs`**: `EROFS`, always. The writable mounts are `/memory` and `/workspace`.

Built on [just-bash](https://github.com/nichochar/just-bash) (TypeScript
bash reimplementation by Vercel Labs) with a custom `IFileSystem`
backend.

## Supported file types

`.md` `.mdx` `.txt` `.rst` `.html` `.htm` `.json` `.yaml` `.yml` `.toml`

## License

MIT
