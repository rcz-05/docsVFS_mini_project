# Layer B — Real-client demo runs

> **Status:** 2026-05-10 — Ollama baseline `published`; Claude Desktop runs `in-progress`; Claude Code + Cursor `not-started`.
>
> Three demo goals chained through `/memory` to evidence the C1
> ("works in real MCP clients") and C2 ("memory survives across
> sessions") claims from [`MCP_POSITIONING.md`](MCP_POSITIONING.md).
> Each session runs in its own fresh chat against a single shared
> SQLite DB at `<corpus>/.docsvfs.db`.

## Corpus

`/Users/rayancastillazouine/data-attribution-demo/docs` — HCAI Lab
data-attribution pipeline operational docs. 32 supported files
(`*.md`/`*.mdx`/`*.txt`/`*.rst`/`*.json`/`*.yaml`/`*.toml`/etc),
`DATA_INVENTORY.md` is the index. Topics: Dolma 3 ~6T-token corpus,
R2 shard storage, Modal volume caches, stratified working samples
(500/1k/5k/10k per bin) over 576 WebOrganizer topic × format bins,
and Bergson influence-function tooling.

> **Footnote on baseline corpus mismatch.** The 2026-05-09 Ollama
> baseline (below) was driven by `scripts/demo-multi.mjs`, whose goal
> prompts were authored against an earlier PACE-supercomputing
> corpus (GPU inventory, SLURM gotchas, PACE runbook). The corpus
> on disk on 2026-05-09 was already the data-attribution corpus
> documented above, so the local model was prompted to look for
> `/docs/slurm` paths that didn't exist. This *amplified* the local
> failure but doesn't undermine the floor — the failure mode was
> tool-call drift (the model emitted tool syntax as plain text), not
> prompt mismatch. The Claude Desktop run uses corpus-matched goal
> prompts (below) for a cleaner test.

## Goals (corpus-matched, 2026-05-10)

These are the three prompts to paste into three separate fresh chats,
in order, sharing one DB. Same chain structure as the original demo:
S1 forces writes, S2 forces memory reads, S3 forces synthesis from
memory.

### S1 — Storage layout (write path)

> You're new to this data-attribution pipeline. Explore `/docs` to
> figure out how the Dolma 3 corpus is sharded and stored across the
> layers in use (R2, Modal volumes, any local caches). For each
> storage layer you confirm from a specific file, call the `remember`
> tool to pin a note so a future session can pick up where you left
> off. Cite filenames in your final answer.

### S2 — Sample stratification (read path)

> A teammate is about to run their first attribution experiment.
> First run `ls /memory` to pick up anything the prior session
> pinned. Then explore `/docs` to find how the working samples are
> stratified — the 500/1k/5k/10k bin sizes and the 576 WebOrganizer
> topic × format breakdown — and the 3 most important design choices
> behind that stratification. Use `remember` to pin each as its own
> note with a `note` field explaining why it matters. Cite filenames.

### S3 — Onboarding runbook (synthesis-from-memory)

> Act as the last session before a new RA joins the project. Read
> `ls /memory` and `cat` the relevant prior notes. Using ONLY the
> facts already in `/memory` + specific lines you verify against
> `/docs`, produce a short onboarding runbook under topic
> `data-attribution-onboarding` that tells the RA: (1) where the data
> lives across R2/Modal, (2) which working sample to start from for a
> one-day prototype, (3) the relevant influence-function tooling.
> Cite the source notes and docs.

---

## Baseline — Ollama llama3.1:8b (the floor)

**Run date:** 2026-05-09 · **Harness:** `node scripts/demo-multi.mjs --no-pause --fresh --model llama3.1:8b` · **Step budget:** 12/session · **DB:** `~/.docsvfs-demo/db/shared.db` (separate from frontier-client DB by design — the harness owns its own state).

| Session | Goal              | Steps | `docs` | `remember` | Final state |
|---------|-------------------|-------|--------|------------|-------------|
| S1      | GPU inventory     | 3/12  | 2      | **0**      | answered competently in text, persisted nothing |
| S2      | SLURM gotchas     | 2/12  | 1      | **0**      | tool-call drift — emitted `docs(ls /docs/slurm)` as plain text |
| S3      | Runbook synthesis | 3/12  | 2      | **0**      | tool-call drift — emitted `{"name":"docs","parameters":{…}}` as plain text |
| Janitor | prune/dedup/flag  | —     | —      | —          | 0 expired, 0 dup, 0 flagged — `/memory` was empty |

**Key observation:** zero `remember` calls across all three sessions.
The `/memory` and `/workspace` mounts ended with only their root inode
rows — confirmed by `sqlite3 shared.db "SELECT mount, COUNT(*) FROM nodes GROUP BY mount"` returning `/memory|1, /workspace|1`. Three distinct
failure modes captured: tool-selection failure (S1), memory-chain
collapse (S2 → S3), janitor vacuous because nothing was written.

**Artifacts:** [`evidence/layer-b/baseline-ollama/`](evidence/layer-b/baseline-ollama/) — full `SUMMARY.md`, `run.log`, per-session `.ndjson`, post-run SQLite dump.

---

## Claude Desktop (Opus 4.7)

**Run date:** 2026-05-10 · **Model:** Opus 4.7 (Adaptive) · **DB:** `~/data-attribution-demo/docs/.docsvfs.db` (default; shared across all 3 chats).

| Session | Goal                  | Steps | `docs` | `remember` | Cited from `/memory` | Cited from `/docs` | Drift? | Verdict |
|---------|-----------------------|-------|--------|------------|----------------------|--------------------|--------|---------|
| S1      | Storage layout        | n/a   | ≥6     | **3**      | —                    | **6 distinct**     | **no** | ✓ — write path established; 10,235 B pinned to `/memory` |
| S2      | Sample stratification | TBD   | TBD    | TBD        | TBD                  | TBD                | TBD    | TBD |
| S3      | Onboarding runbook    | TBD   | TBD    | TBD        | TBD                  | TBD                | TBD    | TBD |

**Pre-run sanity check (2026-05-10):** `stats` tool returned
`{bootedAt: 2026-05-10T19:45:36Z, bootTimeMs: 23, chunkCount: 690,
mounts: [/docs (32 files, ro), /memory (writable), /workspace (24h
TTL, writable)]}`. Server boots clean in <25ms; all four tools
register.

**S1 result (2026-05-10):** Three structured `remember` tool calls
landed cleanly via stdio JSON-RPC, pinning the R2 / Modal-volumes /
local-caches storage layers as separate notes (2,883 B + 3,722 B +
3,630 B = 10,235 B total in `/memory`, all `provenance.source = "tool"`).
Final answer cited 6 distinct files from `/docs`. Zero tool-call
drift. Full transcript + the three Request/Response payloads in
[`evidence/layer-b/claude-desktop/S1.md`](evidence/layer-b/claude-desktop/S1.md);
DB row dump in [`db-snapshots/after-S1.tsv`](evidence/layer-b/claude-desktop/db-snapshots/after-S1.tsv).
This is the **C2 write-path** evidence in isolation; S2 will test
whether a fresh chat can recover and use these notes.

**Artifacts:** [`evidence/layer-b/claude-desktop/`](evidence/layer-b/claude-desktop/) — see the README in that folder for capture protocol.

---

## Claude Code

> Not started. Reset DB before run: `rm "$HOME/data-attribution-demo/docs/.docsvfs.db"*`. Same 3 prompts, captured under `evidence/layer-b/claude-code/`.

---

## Cursor

> Not started. Same protocol. Captured under `evidence/layer-b/cursor/`.

---

## Delta vs Ollama floor

> Filled in after Claude Desktop runs complete. Four headline dimensions:
>
> 1. **`remember` calls in S1** — floor 0; expected ≥3 from Sonnet/Opus.
> 2. **Carry-over from S1 → S2** — floor: nothing to carry. Expected: S2 cites filenames or facts that originated in S1 notes.
> 3. **Synthesis quality in S3** — floor: drifted JSON-as-text, no synthesis. Expected: a complete runbook citing `/memory/<note>.md` + 1-2 lines from `/docs`.
> 4. **Tool-call drift count** — floor: 2 of 3 sessions exhibited drift. Expected: 0 of 3.

---

## Status (mirrors `MCP_POSITIONING.md`)

| Claim | Status                | Evidence                                                                  |
|-------|-----------------------|---------------------------------------------------------------------------|
| C1    | `partially-evidenced` | Server attaches in Cowork + classic Claude Desktop; 4 tools register; `stats` round-trips; **S1 emitted 3 structured `remember` calls with zero drift** (Opus 4.7, 2026-05-10). S2/S3 pending. |
| C2    | `partially-evidenced` | Write path proven (S1 pinned 10.2 KB across 3 notes). Cross-session **read** path pending — S2 must recover S1's notes from a fresh chat. |
| C3    | `claim`               | `/memory` now has 3 rows, all `source=tool` — janitor finally has substrate to operate on. Will test after the chain completes. |

---

## Changelog

- **2026-05-09** — Ollama baseline run, artifacts published to `evidence/layer-b/baseline-ollama/`.
- **2026-05-10** — Claude Desktop wired (config patched for nvm-managed node). Pre-run `stats` sanity check passed (boot 23ms, chunkCount 690, all 3 mounts healthy). Corpus-matched goal prompts authored. Folder scaffold ready under `evidence/layer-b/claude-desktop/`.
- **2026-05-10** — **S1 (storage layout) complete on Opus 4.7.** Three structured `remember` calls landed; `/memory` populated with `dolma3-storage-layer-{r2,modal-volumes,local-caches}.md` totaling 10,235 bytes; final answer cited 6 distinct `/docs` files; zero tool-call drift. C1 strengthened, C2 advanced from `claim` → `partially-evidenced` (write path).
