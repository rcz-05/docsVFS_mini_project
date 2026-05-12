# evidence/layer-b/janitor/

Captures the janitor pass that backs **C3 — security-first lifecycle**.
The other Layer B folders (`baseline-ollama/`, `claude-desktop/`) prove
C1 + C2; this one proves the writable layer has a real cleanup story.

## What goes where

| File                       | What's in it                                                                                          |
|----------------------------|--------------------------------------------------------------------------------------------------------|
| `real-dry-run.txt`         | `npx docsvfs janitor ~/data-attribution-demo/docs --dry-run` against the live S1+S2+S3 DB.            |
| `real-run.txt`             | Same DB, real run. Expected report: 0 expired / 0 dup / 0 flagged / VACUUMed.                          |
| `smoke.txt`                | `node scripts/smoke-janitor.mjs` — seeded fixtures that exercise every destructive path.               |
| `db-snapshots/after-janitor.tsv` | json_extract snapshot taken *after* the real run. Should be byte-identical to `after-S3.tsv`.    |

## Why two captures?

The remember tool always tags writes with `provenance.source = "tool"`.
The janitor's stale-flag/aggressive-delete paths only ever touch rows
where `source = "agent"` — i.e. raw bash writes via `echo >> /memory/...`.
That asymmetry is deliberate: deliberate tool calls are trusted, ad-hoc
agent scribbles are not.

So a janitor pass against the real DB will be 0/0/0/VACUUM no matter
how long the DB ages. That's the *first* piece of evidence: **default
behavior cannot eat trusted notes**. The smoke run is the *second*
piece: when the destructive paths *should* fire (expired TTL, dup
content, stale agent-only write), they fire correctly and `--dry-run`
plus `--aggressive` behave as documented.

## How to reproduce

```bash
cd ~/Documents/Claude/Projects/DocsVFS
npm run build

# Real-DB pair
npx docsvfs janitor ~/data-attribution-demo/docs --dry-run \
  | tee evidence/layer-b/janitor/real-dry-run.txt
npx docsvfs janitor ~/data-attribution-demo/docs \
  | tee evidence/layer-b/janitor/real-run.txt

# Smoke (proves destructive paths)
node scripts/smoke-janitor.mjs \
  | tee evidence/layer-b/janitor/smoke.txt

# Post-run DB snapshot — should be identical to after-S3.tsv
DB="$HOME/data-attribution-demo/docs/.docsvfs.db"
sqlite3 "$DB" \
  "SELECT path, json_extract(provenance,'\$.source') AS source, length(content) AS bytes
   FROM nodes WHERE mount='/memory' AND kind='file' ORDER BY path;" \
  > evidence/layer-b/janitor/db-snapshots/after-janitor.tsv

diff evidence/layer-b/claude-desktop/db-snapshots/after-S3.tsv \
     evidence/layer-b/janitor/db-snapshots/after-janitor.tsv \
  && echo "OK: real-DB rows untouched"
```

## The C3 claim, restated

> Writes are bounded (read-only `/docs`, EROFS on the rest), audited
> (provenance JSON per row), and reversible (janitor prunes expired,
> dedups, flags stale agent-only writes, optionally aggressive-deletes).

What this folder proves:
- The lifecycle code path is real (smoke).
- The default cleanup never destroys tool-tagged writes (real run).
- The dry-run mode genuinely doesn't mutate (smoke + diff).
