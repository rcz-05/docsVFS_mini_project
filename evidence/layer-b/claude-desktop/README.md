# evidence/layer-b/claude-desktop/

Per-session capture for the 3-goal Layer B run on Claude Desktop.

## What goes where

| File / folder            | What to drop in                                                                                                  |
|--------------------------|------------------------------------------------------------------------------------------------------------------|
| `S1.md`                  | Full transcript of Goal S1 (storage layout). Use Claude Desktop's "Copy as Markdown" or Export Conversation.     |
| `S2.md`                  | Full transcript of Goal S2 (sample stratification).                                                              |
| `S3.md`                  | Full transcript of Goal S3 (onboarding runbook synthesis).                                                       |
| `screenshots/`           | At minimum: one shot per session showing a successful `remember` tool-call rendering. Filename `S{n}-remember.png`. |
| `db-snapshots/`          | After each session, a snapshot of `/memory` rows from the SQLite DB. See "DB snapshot recipe" below.             |

## Recipe: DB snapshot after each session

After each chat ends, capture the growing `/memory` row count. The
default DB lives at the corpus path. Note: `source` lives inside the
`provenance` JSON blob, not as its own column, so the query uses
`json_extract`:

```bash
DB="$HOME/data-attribution-demo/docs/.docsvfs.db"
sqlite3 "$DB" \
  "SELECT path, json_extract(provenance,'\$.source') AS source, length(content) AS bytes
   FROM nodes WHERE mount='/memory' AND kind='file' ORDER BY path;" \
  > evidence/layer-b/claude-desktop/db-snapshots/after-S1.tsv
```

Repeat with `after-S2.tsv`, `after-S3.tsv`. The growing list is the
C2 (memory across sessions) evidence — independent of how good the
model's prose answers are.

## Capture checklist (per session)

- [ ] Fresh chat (do not reuse the previous session's chat — that
      defeats the cross-session premise)
- [ ] Paste the goal prompt verbatim (see `DEMO_RUNS.md` §Goals)
- [ ] After the model finishes, "Copy as Markdown" → save here as `S{n}.md`
- [ ] Screenshot one `remember` tool-call render → `screenshots/S{n}-remember.png`
- [ ] Run the DB snapshot command → `db-snapshots/after-S{n}.tsv`
- [ ] Note final scorecard numbers in `DEMO_RUNS.md` Claude Desktop table

## Reset between full runs

If you need to re-run the entire 3-goal chain from scratch (e.g. you
made a mistake in S1 prompt and want to redo it cleanly):

```bash
rm "$HOME/data-attribution-demo/docs/.docsvfs.db"*
```

This clears the shared memory DB. Restart Claude Desktop after the
delete so the MCP server reboots against a fresh DB.
