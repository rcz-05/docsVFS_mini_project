# evidence/layer-b/cursor/

Per-session capture for the 3-goal Layer B run on **Cursor**. This is
the cross-vendor companion to `evidence/layer-b/claude-desktop/` —
same three prompts, same DocsVFS MCP server, different host, different
model class.

## Test setup

- **Host:** Cursor (VS Code-derived editor with native MCP support)
- **Model:** Cursor Free-plan default (Sonnet 4.x-class auto-router; not Opus 4.7)
- **MCP wiring:** Global (`~/.cursor/mcp.json`) — verified by opening
  Cursor in a non-DocsVFS folder and confirming docsvfs still appears
  under "Installed MCP Servers".
- **Server display name in Cursor UI:** `user-docsvfs` (Cursor prefixes
  user-installed MCP servers with `user-`). The server name in
  `mcp.json` is still `docsvfs`.
- **Corpus:** `~/data-attribution-demo-cursor/docs` (a copy of
  `~/data-attribution-demo/docs` with `.docsvfs.db*` wiped, so Cursor's
  chain starts from a fresh 0-row DB independent of Claude Desktop).
- **Workspace open in Cursor:** `~/Documents/Claude/Projects/DocsVFS`.
  Deliberately *not* the corpus folder — keeps the corpus reachable
  only via the docsvfs MCP and avoids Cursor's built-in `read_file`
  tools serving the corpus directly.

## What goes where

| File / folder              | What to drop in                                                                                                                   |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `S1.md`                    | Full transcript of Goal S1 (storage layout). Scorecard, tool-call trace, comparison to Claude Desktop S1.                         |
| `S2.md`                    | Full transcript of Goal S2 (sample stratification). Crucial: fresh chat — load-bearing C2 read-path test.                          |
| `S3.md`                    | Full transcript of Goal S3 (onboarding runbook). Synthesis from `/memory` + targeted `/docs` re-reads.                             |
| `screenshots/`             | At minimum one shot per session showing a `remember` tool-call render in Cursor's UI. Filename: `S{n}-remember.png`.               |
| `db-snapshots/`            | After each session, json_extract snapshot of `/memory` rows. See recipe below.                                                    |

## Recipe: DB snapshot after each session

```bash
DB="$HOME/data-attribution-demo-cursor/docs/.docsvfs.db"
sqlite3 "$DB" \
  "SELECT path, json_extract(provenance,'\$.source') AS source, length(content) AS bytes
   FROM nodes WHERE mount='/memory' AND kind='file' ORDER BY path;" \
  > evidence/layer-b/cursor/db-snapshots/after-S1.tsv
```

Repeat with `after-S2.tsv`, `after-S3.tsv`. Growing row count + byte
totals across the chain is the C2 substrate evidence, independent of
how good the model's prose answers are.

## Capture checklist (per session)

- [ ] Fresh chat (do **not** reuse the previous session's chat — that
      defeats the cross-session premise; this is what makes S2/S3 the
      C2 read-path test)
- [ ] Paste the goal prompt verbatim from `DEMO_RUNS.md` §Goals — no
      paraphrase, no "use the docsvfs MCP" preamble (we want to see if
      the model figures it out on its own)
- [ ] After the model finishes, copy the chat as markdown into
      `S{n}.md` (with full tool-call trace if possible)
- [ ] Screenshot one `remember` tool-call render → `screenshots/S{n}-remember.png`
- [ ] Run the DB snapshot command → `db-snapshots/after-S{n}.tsv`
- [ ] Note any Cursor-specific quirks (auto-accept on tool calls,
      built-in tools used before MCP, server display name, etc.)

## Discoverability finding (recorded in S1)

The Cursor free-default model made ~9 calls to Cursor's *built-in*
file tools (`Searched files`, `Grepped`, `Read remember.json`,
`Read docs.json`) before reaching for the docsvfs MCP. It explicitly
read the MCP tool JSON schemas to verify the surface. Worth tracking
across S1/S2/S3 — if it persists, it's a real adoption friction point
that a system-prompt nudge could fix. Not a C1 failure; the Unix
vocabulary itself translated cleanly once the model trusted the MCP
surface.

## Reset between full runs

If you need to re-run the full 3-goal chain from scratch (e.g. you
made a mistake in S1 and want to redo it cleanly):

```bash
rm "$HOME/data-attribution-demo-cursor/docs/.docsvfs.db"*
```

This clears the Cursor-scoped memory DB without affecting the Claude
Desktop DB at `~/data-attribution-demo/docs/.docsvfs.db`. Restart
Cursor afterward so the MCP server reboots against a fresh DB.
