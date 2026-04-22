# MCP Inspector Transcripts

Committed output from `@modelcontextprotocol/inspector --cli` against
`docsvfs-mcp`. These are the Layer-A correctness evidence for
`MCP_POSITIONING.md §5` — they prove schema validity, error handling,
and transport compliance, which is the table-stakes gate for any MCP
server before it goes in front of a real client.

## What "passing Inspector" means

1. `tools/list` returns valid JSON Schema (draft-07) for each tool's
   `inputSchema` and `outputSchema`.
2. `tools/call` for each tool returns a well-formed `CallToolResult` —
   `content[]` populated, `isError` set, `structuredContent` validated
   against the declared `outputSchema` where present.
3. No stderr warnings from the Inspector itself about malformed
   responses or capability mismatches.

Claude Desktop, Claude Code, and Cursor all validate these same shapes
at load time. A server that passes Inspector cleanly will load in every
major client; one that doesn't will fail in at least one.

## How to reproduce

Build first, then run against the bundled `demo-docs/` corpus with a
scratch SQLite DB. The `--cli` flag puts the Inspector in headless mode
(prints JSON to stdout, no browser).

```bash
npm run build

# Inspect the tool list (schemas land here)
npx -y @modelcontextprotocol/inspector --cli --transport stdio \
  node dist/mcp/bin.js demo-docs --memory \
  --memory-db file:/tmp/docsvfs-inspector.db --no-cache \
  --method tools/list > tests/inspector/tools-list.json

# Call each tool
npx -y @modelcontextprotocol/inspector --cli --transport stdio \
  node dist/mcp/bin.js demo-docs --memory \
  --memory-db file:/tmp/docsvfs-inspector.db --no-cache \
  --method tools/call --tool-name docs \
  --tool-arg command="tree / -L 2" \
  > tests/inspector/call-docs.json

# remember, density, stats similarly — see the four call-*.json files.
```

## Transcript index

| File | What it covers |
|---|---|
| `tools-list.json` | `tools/list` response with input + output schemas for all 4 tools |
| `call-docs.json` | `docs(command: "tree / -L 2")` — tree output, `isError: false` |
| `call-remember.json` | `remember(topic, content, note)` — writes `/memory/inspector-validation.md`, `structuredContent.ok: true` |
| `call-density.json` | `density(path: "/docs", term: "API")` — 5-file ranking with ASCII bars, `structuredContent.suggestion` |
| `call-stats.json` | `stats()` — 3 mounts (/docs r, /memory w, /workspace w ttl 24h), bootTimeMs, chunkCount |

Transcripts dated **2026-04-21**, captured against commit visible via
`git log` at transcript time.
