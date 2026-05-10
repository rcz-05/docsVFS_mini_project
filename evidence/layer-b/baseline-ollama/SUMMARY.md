# Baseline — Ollama llama3.1:8b (the floor)

**Run date:** 2026-05-09
**Harness:** `node scripts/demo-multi.mjs --no-pause --fresh --model llama3.1:8b`
**Corpus:** `~/data-attribution-demo/docs` (32 files)
**Shared DB:** `~/.docsvfs-demo/db/shared.db` (cleaned via `--fresh`)
**Step budget:** 12 per session

This is the **floor** that Lane B Claude Desktop / Code / Cursor runs are
measured against. It exists to make the frontier delta legible.

## Scorecard

| Session | Goal              | Steps used | docs calls | remember calls | Final state |
|---------|-------------------|------------|------------|----------------|-------------|
| S1      | GPU inventory     | 3 / 12     | 2          | **0**          | answered, persisted nothing |
| S2      | SLURM gotchas     | 2 / 12     | 1          | **0**          | drifted, no progress |
| S3      | Runbook synthesis | 3 / 12     | 2          | **0**          | drifted, no synthesis |
| Janitor | prune/dedup/flag  | —          | —          | —              | 0 expired, 0 dup, 0 flagged (`/memory` empty) |

`/memory` and `/workspace` ended the run with **only the mount-root
`dir` rows** — zero file content, zero provenance entries. Confirmed by
`sqlite3 shared.db "SELECT mount, COUNT(*) FROM nodes GROUP BY mount"`:

```
/memory|1
/workspace|1
```

(both rows are the directory inodes themselves).

## What broke — three distinct failure modes

### 1. Tool selection failure (S1)

S1's prompt was unambiguous: *"For each GPU model you confirm from a
specific file, call the `remember` tool so a future session can pick up
where you left off."* The model produced a competent textual list of
GPU models from `PACE_GPU_PHOENIX.md` and then said:

> Now, let's save this information to a note:
> `sbatch --mem-per-cpu=16GB --gres=gpu:1 --partition=gpu-a100`

The "save this information" promise was emitted as natural-language
narration — no `remember()` call ever fired. `rememberCalls=0`.

### 2. Memory chain collapse (S2 → S3)

S2 correctly ran `ls /memory` as the first action (good instruction
following) but found it empty (because S1 wrote nothing). Instead of
falling back to `/docs` exploration, the model exited after step 2 with:

> `docs(ls /docs/slurm)`

— the literal tool-call syntax printed as plain text in the final
answer. Classic OpenAI-compat tool-call drift, matches the prior memory
note about `llama3.1:8b` final-call drift.

S3 inherited the same empty `/memory`, tried to `cat
/memory/pace-gpu-runbook.md` (ENOENT), then drifted similarly:

> Since there is no prior note for 'pace-gpu-runbook', I will start from scratch.
> `{"name": "docs", "parameters": {"command":"ls /workspace"}}`

Final answer is JSON-as-text — never made it back to the tool channel.

### 3. Janitor had nothing to do

`janitor --aggressive` ran clean — but vacuously. With zero `remember`
writes, there's nothing to prune, dedup, or flag. The `--fake-age` step
also reported `aged 0 row(s) back by 48h` because there were no
non-mount-root rows to age. The C3 (provenance / janitor) story
**cannot be evidenced from this baseline alone** — that requires a
client that actually writes.

## Why this is a useful baseline

The headline claim of the MCP server is **C2: memory across sessions**.
This baseline shows that *memory across sessions only matters if the
model writes in the first place*. With a small local model, it doesn't,
and the chain dies on step 1.

When the Claude Desktop transcripts come in, the meaningful things to
compare are:

1. **rememberCalls in S1** — does the frontier model actually pin notes
   when instructed? (Floor: 0)
2. **Carry-over evidence in S2** — does S2 reference filenames or facts
   discovered in S1's notes? (Floor: nothing to carry, so trivially 0)
3. **Synthesis quality in S3** — runbook citing `/memory/<note>.md` +
   specific `/docs` lines? (Floor: synthesis attempted but with zero
   memory input)
4. **Tool-call drift count** — number of times the model emits
   tool-call syntax as plain text. (Floor: 2 of 3 sessions exhibited
   drift)

The frontier delta on dimensions 1–3 is the C1 / C2 evidence. The
absence of drift (dimension 4) is a separate, smaller win for clients
that route tool calls correctly.

## Artifacts in this folder

- `run.log` — full orchestrator stdout (terminal escapes preserved).
- `S1.ndjson` / `S2.ndjson` / `S3.ndjson` — per-step structured events
  (`tool`, `step`, `done`, `scorecard`).
- `shared-db-nodes.sql` — `.dump nodes` of the shared SQLite, showing
  the empty post-run state.
- `SUMMARY.md` — this file.

## Reproduction

```bash
# Ensure ollama is running and llama3.1:8b is pulled.
ollama list | grep llama3.1:8b

# From repo root:
node scripts/demo-multi.mjs --no-pause --fresh --model llama3.1:8b \
  2>&1 | tee evidence/layer-b/baseline-ollama/run.log
```

Run-to-run variance is expected — the model is non-deterministic and
its drift behaviour shifts with sampling. The qualitative story
(weak-to-zero `remember` adoption, tool-call drift in 1–2 of 3
sessions) reproduces consistently.
