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

### 2026-04-19 — social-data-attribution/docs @ 8db3886 — llama3.1:8b (Ollama)

**Corpus:** `~/data-attribution-demo/docs` @ `8db3886` ("SOC-170: BBH attribution
scoring pipeline"), 32 files across 3 directories, bootTimeMs ~13–38ms.
**Model:** `llama3.1:8b` via Ollama's OpenAI-compat endpoint
(`http://localhost:11434/v1`).
**Steps budget:** 12 per session
**DB:** `~/.docsvfs-demo/db/shared.db` (fresh)
**Orchestrator:** `scripts/demo-multi.mjs --fresh --no-pause`
**Visualization:** `scripts/demo-tmux.sh` → `tmux attach -t docsvfs-demo`

| Session | Goal summary           | steps | docsCalls | remember | fallbacks | runMs  |
|---------|------------------------|------:|----------:|---------:|----------:|-------:|
| S1      | GPU inventory          |   3   |     2     |    0     |     0     | 45,308 |
| S2      | SLURM gotchas          |   2   |     1     |    0     |     0     |  6,214 |
| S3      | Synth runbook          |   3   |     2     |    0     |     0     |  6,800 |

#### S1 highlights
- `tree / -L 2` → complete structure inventory in one call
- `cat /docs/PACE_GPU_PHOENIX.md` → returned 9841 bytes, agent extracted
  **correct** facts: H100 80GB (DGX + HGX nodes, embers QoS only), A100 40/80GB
  (GPU-512GB-A100 nodes on AMD Epyc 7513), L40S 48GB (GPU-L40S on Intel Xeon
  6426Y). These match the real doc verbatim.
- Final text cited the nodes and QoS caveat accurately but **never emitted a
  `remember(...)` call** — instead ended with an unrelated `` `sbatch --gres=gpu:1 --partition=gpu-a100` `` one-liner in backticks. The fallback regex did not match, so nothing persisted to `/memory`.

#### S2 highlights
- First call was `ls /memory` ✓ (proves the "read memory first" instruction
  works even without prior contents)
- `/memory` was empty (S1 wrote nothing), so S2 concluded "nothing to build on"
  and stopped at step 2 with the text `` `docs(ls /docs/slurm)` `` — another
  textual tool-call description the fallback doesn't parse (fallback catches
  `remember`, not `docs`).
- Total elapsed 6.2s. No SLURM content ever reached the agent.

#### S3 highlights
- `ls /memory` empty, tried `cat /memory/pace-gpu-runbook.md` (the file it was
  *supposed to create*), got stderr, and bailed.
- Final text: `Since there is no prior note for 'pace-gpu-runbook', I will
  start from scratch.` followed by `{"name": "docs", "parameters": {"command":"ls /workspace"}}` — again, JSON-in-text, not a real tool call.
- 0 runbook produced.

#### Janitor outcome (`--aggressive`)
- pruned (TTL-expired workspace rows): 0
- dedup: 0
- flagged stale agent-only: 0
- deleted: 0
- Runtime: 3ms, VACUUMed.
- Correct for an empty DB. The fake-age step that aged rows by 48h had nothing
  to age because `nodes` was empty.

#### Verdict

- **What worked:**
  - DocsVFS itself is rock solid. 38ms boot, `tree`/`cat`/`ls` all returned
    correct content from 32 real docs in milliseconds. The `/memory` mount was
    writable and queryable; `ls /memory` returned correctly even when empty;
    the multi-process shared-DB layout held up across three back-to-back agent
    processes. The janitor ran cleanly against the shared DB via `--memory-db`.
  - The read side of the agent loop was accurate: when S1 did `cat /docs/PACE_GPU_PHOENIX.md`, it extracted the exact GPU models and node types that appear in the file.

- **What didn't:**
  - `llama3.1:8b` via Ollama's OpenAI-compat Chat Completions layer **never emitted a structured `remember` tool call** in any of the three sessions. It wrote shell-like backtick commands (S1), textual pseudo-calls like `` `docs(...)` `` (S2), or JSON-in-content like `{"name":"docs","parameters":{...}}` (S3). The regex fallback only catches `remember(...)` patterns, so it rescued nothing this run.
  - Because S1 produced no `/memory` content, S2 and S3 had no handoff material and stopped almost immediately. Cross-session persistence is the whole point of the demo, and the model's tool-call drift collapsed the whole chain.
  - Earlier smoke tests across four models (llama3.1:8b, qwen3:8b, mistral-nemo, hermes3:8b) showed every small local Ollama model fails this step differently. See `memory/ollama_tool_calls.md`.

- **Surprise:**
  - The single-goal smoke test from earlier ("List the docs directory. Find the file about PACE GPUs. Read enough of it ... Then call the remember tool with topic='smoke-gpu-check'") *did* trigger the fallback and wrote a 153-byte `/memory/smoke-gpu-check.md` with `source: "tool"` provenance. The failure mode isn't "this model cannot call tools" — it's "this model fails the *terminal* tool call more often when goals are open-ended enough that it decides to answer in prose." Narrow, imperative goals produced at least the text form of the call (which the fallback catches); broader multi-step goals produced unrelated trailing content (which the fallback misses).

#### Next steps implied by this run

1. Widen the fallback parser to also catch `docs(...)` and JSON-object
   `{"name":"docs",...}` patterns, so mid-run failures don't terminate the
   session either.
2. Re-run with a model that actually emits structured tool calls — Groq's
   free tier of `llama-3.3-70b-versatile` is the obvious next test, since it
   speaks OpenAI Chat Completions natively and has no cost.
3. Tighten the S1 goal to force a `remember` call before the agent is allowed
   to "finish" — e.g., stopping condition = "at least one remember tool call".
4. The smoke-test log at `~/.docsvfs-demo/logs/SMOKE.ndjson` should probably
   be archived as `examples/transcripts/SMOKE-2026-04-19.ndjson` so the
   "happy path" proof isn't lost on re-runs.
