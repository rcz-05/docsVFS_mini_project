# MCP Tool Schemas — DocsVFS

> **Purpose.** The contract for the 4 MCP tools DocsVFS exposes. Locked on paper before implementation so the wire surface is decided deliberately, not accreted from code.
>
> **Status (2026-04-21):** all 4 tools `specced`. No server code yet.
>
> **Change rule.** Any edit to a tool name, description, input schema, output shape, error case, or capability declaration in this file requires a matching entry in [`MCP_POSITIONING.md §8`](MCP_POSITIONING.md) in the **same commit**. The changelog lives there, not here — this file stays a clean contract.

---

## 0. Protocol baseline

- **MCP spec target:** 2025-06-18 or later (current Claude Desktop / Claude Code / Cursor baseline).
- **Transport (v1):** stdio only. SSE / streamable-HTTP deferred to the hosted remote mode (tracked in `MCP_POSITIONING.md §6 Q5`).
- **Capabilities advertised:**
  ```json
  { "tools": { "listChanged": false } }
  ```
  No `resources`, no `prompts`, no `sampling`, no `roots`. Reasons:
  - `resources` duplicates `docs` (`cat` already returns file bytes, and two read paths confuses the agent).
  - `prompts` / `sampling` / `roots` aren't relevant to a docs-exploration surface in v1.
- **Server info:**
  ```json
  { "name": "docsvfs", "version": "<pkg.version>" }
  ```
- **Auth:** none — stdio is parent-process trust. When hosted remote mode ships, it will require an API key; that change will add a new §0 entry here.
- **Pagination:** none. All responses bounded by per-tool size caps (see each tool).

---

## 1. Tool: `docs`

**One-liner.** Bash shell over the DocsVFS virtual filesystem.

**Why it exists.** This is the primary primitive — `ls`, `cat`, `grep`, `find`, `tree`, `head`, `tail`, `wc`, pipes, redirects — the surface every agent has seen in training. A single tool with one argument keeps the Cursor 40-tool-ceiling budget intact while covering ~90% of docs-exploration needs.

### Input schema

```json
{
  "name": "docs",
  "description": "Run a bash command over the DocsVFS virtual filesystem. Mounts: /docs (read-only source documentation), /memory (persistent notes across sessions), /workspace (24h scratch). Supports ls, cd, cat, grep, find, tree, head, tail, wc, pipes (|), and redirects (>, >>). Writes to /docs return EROFS. Start with `tree / -L 2` to orient. Use `.` (not `/`) as the search path when cwd is / to avoid a double-slash bug in the underlying grep.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "A bash command. One-line; semicolons and pipes allowed."
      }
    },
    "required": ["command"],
    "additionalProperties": false
  }
}
```

### Response shape

MCP tools return `content[]` — an array of content parts. `docs` always returns exactly one `text` part:

```json
{
  "content": [
    { "type": "text", "text": "<stdout>[\nstderr: <stderr>][\nexit <N>]" }
  ],
  "isError": false
}
```

Rules:
- `stdout` verbatim, capped at **64 KB**. Overflow is truncated with a trailing `\n[truncated: M bytes]`.
- If `stderr` is non-empty, it's appended as `\nstderr: <stderr>` (also 64 KB cap).
- If `exitCode !== 0` and there is no stdout/stderr at all, the text becomes `exit <N>`.
- `isError` stays `false` for non-zero exits — a failed grep or an EROFS on `/docs` is **an agent-recoverable result**, not an MCP error. The agent reads it and tries something else.

### Error cases (MCP-level, `isError: true`)

Only three:
1. `command` missing or non-string → `{ content: [{type:"text", text:"docs: `command` is required and must be a string"}], isError: true }`.
2. VFS not ready (boot failed or closed) → `"docs: filesystem unavailable — see server logs"`.
3. Internal exception the just-bash runtime couldn't catch → `"docs: internal error: <message>"`.

Anything else, including a malformed bash command, stays `isError: false` and surfaces via stderr.

### Security invariants

- `/docs` is EROFS: any `>` or `>>` redirect targeting `/docs/*` returns stderr immediately, no file mutated.
- No `exec`, `source`, `eval`, or subshell spawn to the host — just-bash is a TypeScript reimplementation, not a passthrough to `/bin/sh`.
- No network primitives (`curl`, `wget`, etc.) are exposed by just-bash.
- Writes to `/memory` and `/workspace` are tagged `provenance: { source: "agent", session_id }` (distinct from `remember`'s `source: "tool"`).

### Example invocation

```jsonc
// request
{ "method": "tools/call", "params": {
    "name": "docs",
    "arguments": { "command": "tree / -L 2" }
}}

// response
{ "content": [{ "type": "text", "text": "/\n|-- docs\n|   |-- PACE_GPU_PHOENIX.md\n..." }],
  "isError": false }
```

---

## 2. Tool: `remember`

**One-liner.** Structured write to `/memory/<slug>.md` with distinct provenance.

**Why it exists.** `docs` + a `>` redirect *can* write to `/memory`, but (1) small models bungle the quoting, (2) un-tagged raw-bash writes are indistinguishable from noise in the provenance log. `remember` gives agents a zero-escape way to commit findings and tags them `source: "tool"` so the janitor can rank them higher than raw-bash writes.

### Input schema

```json
{
  "name": "remember",
  "description": "Save a note to /memory/<slug>.md. <slug> is derived from `topic` (lowercased, punctuation stripped, spaces→hyphens, max 60 chars). This is the agent's persistence primitive — the only way findings survive across MCP sessions. Every write is tagged provenance source=\"tool\" with the session_id. Use for any fact you want a future session to pick up. For scratch work use /workspace instead (via the docs tool with `>` redirect).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "topic":   { "type": "string",  "description": "Short human-readable topic. Gets slugified to the filename.", "minLength": 1, "maxLength": 200 },
      "content": { "type": "string",  "description": "Markdown body. 64 KB cap.",                                   "minLength": 1, "maxLength": 65536 },
      "append":  { "type": "boolean", "description": "If true, append to any existing file under this slug; otherwise overwrite. Default false." },
      "note":    { "type": "string",  "description": "Optional free-form provenance note (e.g. `source query` or `why this matters`). Stored in nodes.provenance.note.", "maxLength": 500 }
    },
    "required": ["topic", "content"],
    "additionalProperties": false
  }
}
```

### Response shape

```json
{
  "content": [
    { "type": "text", "text": "{\"ok\":true,\"path\":\"/memory/<slug>.md\",\"bytes\":<N>,\"mode\":\"overwrite\"|\"append\"}" }
  ],
  "structuredContent": {
    "ok": true,
    "path": "/memory/<slug>.md",
    "bytes": 153,
    "mode": "overwrite"
  },
  "isError": false
}
```

- `structuredContent` is provided for clients that support it (Claude Code, recent Claude Desktop); `content[0].text` is the JSON-serialized fallback for clients that don't.
- `mode` reflects *what actually happened*: `append` if `append=true` and the file already existed, otherwise `overwrite`.

### Error cases (MCP-level, `isError: true`)

1. `topic` or `content` missing / empty / exceeds length cap → descriptive text error.
2. Memory mount not available (vfs booted without `memory: true`) → `"remember: memory mount is not enabled on this server — restart with --memory"`.
3. Write failure from the underlying writable FS (e.g. SQLite closed) → `"remember: write failed: <message>"`.

### Security invariants

- Only writes to `/memory/<slug>.md`. `topic` cannot traverse the slug escape: slashes, dots, and path separators collapse to `-` before the filesystem sees them. `topic: "../../etc/passwd"` → `/memory/etc-passwd.md`.
- Never overwrites `/docs` (structurally impossible — writable mount is `/memory` only).
- Never writes outside the registered mount — the mount is hardcoded at server start.
- Slug collision policy: overwrite (unless `append: true`). This is intentional — `remember({topic:"x", content:"y"})` is idempotent.

### Example

```jsonc
// request
{ "method": "tools/call", "params": {
    "name": "remember",
    "arguments": {
      "topic": "Phoenix GPU inventory",
      "content": "Phoenix has H100 (embers QoS), A100 40/80GB, L40S 48GB, RTX6000 Pro Blackwell 96GB. Source: /docs/PACE_GPU_PHOENIX.md lines 8–40.",
      "note": "Extracted during goal S1 of the 3-session demo."
    }
}}

// response.structuredContent
{ "ok": true, "path": "/memory/phoenix-gpu-inventory.md", "bytes": 192, "mode": "overwrite" }
```

---

## 3. Tool: `density`

**One-liner.** Rank files under a path by occurrence count of a term.

**Why it exists.** When the agent already grepped and got 40 hits, it doesn't know which file is the *center of gravity*. `density` answers that in one call: "`/docs/PACE_SLURM_PHOENIX.md` dominates with 32 matches, try `cat` on it next." This saves the agent from re-reading grep's raw output or opening files at random.

### Input schema

```json
{
  "name": "density",
  "description": "Rank files under <path> by occurrence count of <term>. Returns a ranked list with ASCII bars and a drill-in suggestion (e.g. \"→ /docs/FOO.md dominates. Try: cat /docs/FOO.md\"). Works across all mounts — pass `/` to scan /docs, /memory, and /workspace together. Faster than re-reading grep output when you just want to know where a term concentrates.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":            { "type": "string",  "description": "Root path to scan. Use `/` for all mounts." },
      "term":            { "type": "string",  "description": "Term to count. Literal substring match.", "minLength": 1, "maxLength": 200 },
      "caseInsensitive": { "type": "boolean", "description": "Case-insensitive match. Default false." },
      "top":             { "type": "integer", "description": "Max rows returned. Default 10, max 100.", "minimum": 1, "maximum": 100 }
    },
    "required": ["path", "term"],
    "additionalProperties": false
  }
}
```

### Response shape

```json
{
  "content": [
    { "type": "text", "text": "density for \"Slurm\" in /docs — 8 file(s), 64 total match(es)\n\n  /docs/PACE_SLURM_PHOENIX.md   32  ████████████████████████\n  /docs/PACE_SLURM_ICE.md       13  █████████\n  ...\n\n→ /docs/PACE_SLURM_PHOENIX.md dominates. Try: cat /docs/PACE_SLURM_PHOENIX.md" }
  ],
  "structuredContent": {
    "term": "Slurm",
    "path": "/docs",
    "totalFiles": 8,
    "totalMatches": 64,
    "rows": [
      { "path": "/docs/PACE_SLURM_PHOENIX.md", "count": 32 },
      { "path": "/docs/PACE_SLURM_ICE.md",     "count": 13 }
    ],
    "suggestion": "cat /docs/PACE_SLURM_PHOENIX.md",
    "elapsedMs": 12
  },
  "isError": false
}
```

### Error cases (MCP-level, `isError: true`)

1. `path` does not resolve → `"density: path not found: <path>"`.
2. `term` missing or empty → `"density: term is required"`.

Zero matches returns `isError: false` with `totalMatches: 0` — that's a legitimate negative result.

### Security invariants

- Read-only. Does not write anywhere.
- Size cap: skips files over 2 MB (existing density behavior) — prevents a hostile megabyte file from stalling the scan.

---

## 4. Tool: `stats`

**One-liner.** Lightweight filesystem introspection — counts, last-write timestamps, boot time.

**Why it exists.** At session start, the agent wants to know the scale before deciding how to explore ("is this 5 files or 500?"). `tree / -L 2` answers it but is overkill; `stats` returns numbers only. Also: handy for clients that want to display a status line without shelling out.

### Input schema

```json
{
  "name": "stats",
  "description": "Return per-mount file counts, total bytes, chunk-index size, last-write timestamp, and server boot time. Use at session start to see scale before deciding how to explore. Cheaper than `tree / -L 2` when you only need numbers.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "mount": {
        "type": "string",
        "enum": ["/docs", "/memory", "/workspace"],
        "description": "Optional: restrict to one mount. Omit for all."
      }
    },
    "additionalProperties": false
  }
}
```

### Response shape

```json
{
  "content": [
    { "type": "text", "text": "docsvfs — booted 2026-04-21T14:03:11Z (32ms)\n  /docs        32 files,  3 dirs,  1.8 MB,  last write: —\n  /memory       0 files,  0 dirs,  0 B,    last write: —\n  /workspace    0 files,  0 dirs,  0 B,    last write: —\nchunk index: 690 chunks (in-memory)" }
  ],
  "structuredContent": {
    "bootedAt": "2026-04-21T14:03:11Z",
    "bootTimeMs": 32,
    "chunkCount": 690,
    "chunkBackend": "in-memory",
    "mounts": [
      { "mount": "/docs",      "fileCount": 32, "dirCount": 3, "totalBytes": 1843200, "lastWriteAt": null, "writable": false },
      { "mount": "/memory",    "fileCount":  0, "dirCount": 0, "totalBytes":       0, "lastWriteAt": null, "writable": true  },
      { "mount": "/workspace", "fileCount":  0, "dirCount": 0, "totalBytes":       0, "lastWriteAt": null, "writable": true, "ttlHours": 24 }
    ]
  },
  "isError": false
}
```

### Error cases (MCP-level, `isError: true`)

1. `mount` supplied but not registered (possible if the server was started without `--memory`) → `"stats: mount not available: <mount>"`.

Otherwise always succeeds — stats is a read-only snapshot of server state.

### Security invariants

- Read-only.
- No path information about individual files is returned (just counts and totals). Directory names are not enumerated.

---

## 5. Cross-cutting conventions

### Error format (all tools)

MCP errors are returned as regular tool responses with `isError: true`:

```json
{
  "content": [{ "type": "text", "text": "<tool>: <human-readable message>" }],
  "isError": true
}
```

Never throw at the MCP layer for agent-caused errors. Throw only on structural server failures (SQLite closed, VFS boot crash) — those become transport-level `JSONRPCError` frames and terminate the tool call, which is correct.

### Size caps (summary)

| Limit | Value | Enforced by |
|---|---|---|
| `docs` stdout in response | 64 KB | tool |
| `docs` stderr in response | 64 KB | tool |
| `remember.content` | 64 KB | schema `maxLength` + tool |
| `remember.topic` | 200 chars | schema `maxLength` |
| `remember.note` | 500 chars | schema `maxLength` |
| `density.top` | 100 rows | schema `maximum` |
| `density` per-file scan | 2 MB | tool (pre-existing) |

### Capabilities declared on startup

```json
{
  "protocolVersion": "2025-06-18",
  "serverInfo": { "name": "docsvfs", "version": "<pkg.version>" },
  "capabilities": { "tools": { "listChanged": false } }
}
```

`listChanged: false` because tool surface is static per server process (adding `--memory` changes availability, but that's a restart, not a runtime list-change notification).

### Logging

Structured JSON lines to stderr, one event per line:
```json
{"ts":1776888000,"level":"info","tool":"docs","command":"tree / -L 2","elapsedMs":14,"exitCode":0}
```
Never to stdout — that channel belongs to the MCP JSON-RPC transport.

### Tool availability by startup flags

| Server started as | `docs` | `remember` | `density` | `stats` |
|---|:---:|:---:|:---:|:---:|
| `docsvfs-mcp <path>` (read-only) | ✓ | ✗¹ | ✓ | ✓ (no /memory row) |
| `docsvfs-mcp <path> --memory` | ✓ | ✓ | ✓ | ✓ |
| `docsvfs-mcp <path> --memory --chroma` | ✓ | ✓ | ✓ (semantic) | ✓ (chunkBackend: "chroma") |

¹ Without `--memory`, `remember` is omitted from `tools/list` entirely — not returned-and-errored. That matches Claude Desktop's expectation that missing-capability = missing-tool.

---

## 6. Non-goals for v1

Listed so future-us doesn't silently expand the surface:

- **No `search` / `grep` as a dedicated tool** — `docs` covers both via `grep -r`. Splitting them hurts the tool-count budget.
- **No `write_docs` / `edit_docs`** — `/docs` is structurally read-only. A write path would break C1 ("just a filesystem the agent knows") and C3 (security).
- **No `janitor` tool** — destructive potential; stays CLI-only, agent-unreachable.
- **No `resources`** — duplicates `docs` cat and adds a second read surface the agent has to learn.
- **No `prompts`, no `sampling`, no `roots`** — not relevant for docs exploration.
- **No streaming tool responses** — everything fits in the size caps above.
- **No `fs_write_raw` or similar** — raw writes to `/memory` go through `docs` (bash redirect) and are tagged `source: "agent"`; structured writes go through `remember` and are tagged `source: "tool"`. Those two paths are deliberate; a third would muddy provenance.
