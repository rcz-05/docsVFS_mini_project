# DocsVFS Demo Runs

Append-only log of multi-session demo runs against real documentation. Each
entry is self-contained and labeled by date + corpus + model so results stay
comparable over time.

The canonical demo is the 3-session PACE-GPU exploration driven by
`scripts/demo-multi.mjs` against a read-only checkout of
`eilab-gt/social-data-attribution`'s `docs/` directory. State lives under
`~/.docsvfs-demo/` — completely outside both DocsVFS and the docs repo.

## How to run a demo and record results

```bash
# one-time setup
git worktree add ~/data-attribution-demo origin/main \
  --cwd ~/data-attribution       # if not already present
mkdir -p ~/.docsvfs-demo/{db,logs}

# tmux layout (optional; makes it visual)
./scripts/demo-tmux.sh
tmux attach -t docsvfs-demo

# the run itself (left pane or any terminal)
node scripts/demo-multi.mjs --fresh
```

After the run, summarize below. A single run entry contains:

1. **Header** — date, model, corpus commit, file/dir counts.
2. **Per-session scorecard** — steps, docsCalls, rememberCalls, rememberFallbacks, runMs.
3. **Transcript excerpts** — the highest-signal tool calls + the final answer.
4. **Post-janitor state** — what remained in `/memory` and what got flagged.
5. **Verdict** — what DocsVFS clearly helped with, and what didn't work.

Always include one "surprises" bullet. Demos without surprises are suspect.

### Parsing logs → run entry

The per-session NDJSON at `~/.docsvfs-demo/logs/S{1,2,3}.ndjson` has one event
per line. Useful jq one-liners:

```bash
# scorecard for each session
for s in S1 S2 S3; do
  jq 'select(.kind=="scorecard")' ~/.docsvfs-demo/logs/$s.ndjson
done

# every tool call (docs + remember) across all three
jq -c 'select(.kind=="tool_call") | {session, tool, cmd: .command // .topic, ms: .elapsedMs}' \
   ~/.docsvfs-demo/logs/S*.ndjson

# every fallback (cases where the model emitted remember() as text instead of a tool call)
jq -c 'select(.kind=="remember_fallback_parsed")' ~/.docsvfs-demo/logs/S*.ndjson

# final /memory state after the run
sqlite3 ~/.docsvfs-demo/db/shared.db \
  "SELECT mount, path, length(content), json_extract(provenance,'\$.session_id'), json_extract(provenance,'\$.source') FROM nodes WHERE path != '/' AND kind = 'file';"
```

---

## Run template (copy below for each new run)

```markdown
### YYYY-MM-DD — <corpus> @ <short-sha> — <model>

**Corpus:** `~/data-attribution-demo/docs` @ `<git rev-parse --short HEAD>`
— N files, M dirs
**Model:** `<ollama-model-or-provider>` via `<endpoint>`
**Steps budget:** 12 per session
**DB:** `~/.docsvfs-demo/db/shared.db` (fresh)

| Session | Goal summary           | steps | docsCalls | remember | fallbacks | runMs |
|---------|------------------------|------:|----------:|---------:|----------:|------:|
| S1      | GPU inventory          |       |           |          |           |       |
| S2      | SLURM gotchas          |       |           |          |           |       |
| S3      | Synth runbook          |       |           |          |           |       |

#### S1 highlights
- first bash call: ...
- notes pinned: ...

#### S2 highlights
- proof of cross-session handoff (did S2 read /memory first?): ...

#### S3 highlights
- how closely did the runbook match ground truth? ...

#### Janitor outcome
- pruned: X rows (expired workspace)
- flagged stale agent-only: Y rows
- deleted (--aggressive): Z rows

#### Verdict
- **What worked:** ...
- **What didn't:** ...
- **Surprise:** ...
```

---

## Runs (newest first)

<!-- Append new entries directly below this line. -->
