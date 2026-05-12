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

| Session | Goal                  | Steps | `docs` | `density` | `remember` | Cited from `/memory` | Cited from `/docs` | Drift? | Verdict |
|---------|-----------------------|-------|--------|-----------|------------|----------------------|--------------------|--------|---------|
| S1      | Storage layout        | n/a   | ≥6     | 0         | **3**      | —                    | **6 distinct**     | **no** | ✓ — write path established; 10,235 B pinned to `/memory` |
| S2      | Sample stratification | n/a   | ~10    | **4**     | **3**      | **3 of 3 S1 notes** (batched `cat`) | **5 distinct** | **no** | ✓ — **C2 read path proven**; chain intact (3 → 6 notes) |
| S3      | Onboarding runbook    | n/a   | **16** | 0         | **1**      | **6 of 6** (one cat per file) | **4 verified** | **no** | ✓ — **synthesis proven**; 13.1 KB runbook integrating all 6 prior notes + 4 `/docs` files; first `stats` + `sed`/`head` use; chain complete (6 → 7 notes, ~31 KB) |

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
[`evidence/layer-b/claude-desktop/S1.md`](evidence/layer-b/claude-desktop/S1.md).

**S2 result (2026-05-10):** **The C2 read path is now evidenced.** A
fresh Claude Desktop chat — no S1 context in its conversation history —
took `ls -la /memory` as its first substantive action, then issued a
single batched `cat` of all three S1 notes (`cat
/memory/dolma3-storage-layer-{local-caches,modal-volumes,r2}.md`),
then explored `/docs` to add the three working-sample design choices
(576-bin stratification, flat per-bin ladder with underfill,
deterministic blake2b priority). Final answer explicitly acknowledged
the carry-over: *"Prior session had pinned three storage-layer notes
(R2 canonical, Modal volume cache, local caches) — kept those
untouched and added three new notes…"*. `/memory` grew from 3 → 6
notes. Also the **first real-world use of the `density` tool** (4
calls: `stratif`, `576`, `10000`, `blake2b`) — exercising the full
4-tool surface, not just `docs` + `remember`. Full transcript +
tool-call trace + slug-truncation finding in
[`evidence/layer-b/claude-desktop/S2.md`](evidence/layer-b/claude-desktop/S2.md).

**S3 result (2026-05-10):** **Chain complete. Synthesis proven.** Fresh
chat opened with a proactive `stats` call (first organic `stats` use
in any chain), then `ls /memory`, then read all six prior notes one
at a time, then did targeted page-by-page verification of four
`/docs` files (`ATTRIBUTION_RUNBOOK.md`, `BERGSON_REFERENCE.md`,
`TRACSTAR_PIPELINE.md`, `WORKING_SAMPLE_DATA_ACCESS.md`) using
`head -N`, `sed -n 'X,Yp'`, and targeted `grep -n ... | head`, then
emitted **one** `remember` call writing a 13.1 KB onboarding runbook
that integrates: (1) storage layout (R2 / Modal / local), (2)
recommended starting sample (`sample_500_docs`, with nested-ladder
rationale), (3) influence-function tooling (Bergson 0.6.0 Mode B,
TracStar three-phase SLURM topology, full Bergson parameter set).
Every claim attributed to either a `/memory/<slug>.md` path or a
specific `/docs/X.md` file. **`/memory` reached 7 notes (~31 KB)**.
First chain use of `stats`, `head -N`, and `sed -n 'X,Yp'` — all
four MCP tools now have real-workflow evidence behind them. Notable
finding: the model read four `/docs` files beyond what `/memory`
had, because S3's influence-function topic was a gap S1+S2 didn't
cover. That's *additive memory behavior* — the right hybrid, not a
failure of C2. Full transcript + thought-process narration in
[`evidence/layer-b/claude-desktop/S3.md`](evidence/layer-b/claude-desktop/S3.md).

**Artifacts:** [`evidence/layer-b/claude-desktop/`](evidence/layer-b/claude-desktop/) — see the README in that folder for capture protocol.

**Janitor pass (2026-05-11):** With 7 `source=tool` notes / 31,145 B of
agent-authored substrate in `/memory` after S3, ran the full janitor
protocol to evidence C3 (security-first lifecycle). Three captures
committed under [`evidence/layer-b/janitor/`](evidence/layer-b/janitor/):

- **Smoke (in-process):** [`scripts/smoke-janitor.mjs`](scripts/smoke-janitor.mjs) green in a Linux sandbox — 5/5 scenarios (dry-run, default, aggressive, `--older-than-days 7`, `--mounts` filter), every assertion passes. Capture: [`smoke.txt`](evidence/layer-b/janitor/smoke.txt).
- **Fixture-CLI:** `npx docsvfs janitor` against a seeded 3-row `source=tool` fixture DB → `0/0/0/VACUUMed`, all rows preserved. Capture: [`fixture-cli.txt`](evidence/layer-b/janitor/fixture-cli.txt).
- **Real-DB:** dry-run + real run against `~/data-attribution-demo/docs/.docsvfs.db` (the populated Claude Desktop chain DB, 7 rows / ~31 KB) → both reported `0 expired / 0 duplicates / 0 flagged`; real run additionally `VACUUMed`. Captures: [`real-dry-run.txt`](evidence/layer-b/janitor/real-dry-run.txt), [`real-run.txt`](evidence/layer-b/janitor/real-run.txt). Post-run DB snapshot ([`db-snapshots/after-janitor.tsv`](evidence/layer-b/janitor/db-snapshots/after-janitor.tsv)) diffed byte-for-byte against `after-S3.tsv` — **silent diff**.

Why `0/0/0` is the *correct* outcome: `remember` always tags writes
`provenance.source = "tool"` ([`src/remember-tool.ts:127`](src/remember-tool.ts));
the janitor's stale-flag path matches only `source = "agent"`
([`src/memory/janitor.ts:153`](src/memory/janitor.ts)). On a tool-tagged
real DB the destructive paths have nothing to do — which is the
security invariant we want. The destructive paths still fire correctly
on seeded fixtures (smoke covers this).

---

## Claude Code

> Not started. Reset DB before run: `rm "$HOME/data-attribution-demo/docs/.docsvfs.db"*`. Same 3 prompts, captured under `evidence/layer-b/claude-code/`.

---

## Cursor — Free-plan default (Sonnet 4.x-class)

**Run dates:** S1 — 2026-05-11. S2, S3 — pending.
**Host:** Cursor (VS Code-derived, MCP via stdio).
**Model:** Cursor Free-plan auto-router default. Not Opus 4.7. Picked deliberately to test C1's strongest version of the claim: *"Unix primitives the agent already knows"* should generalize past Anthropic's flagship.
**DB:** `~/data-attribution-demo-cursor/docs/.docsvfs.db` (independent from Claude Desktop's DB, started from 0 rows).
**MCP wiring scope:** Global (`~/.cursor/mcp.json`); acid-tested by opening a non-DocsVFS folder and confirming docsvfs still loads.
**Workspace open in Cursor during runs:** the DocsVFS repo itself — keeps the corpus reachable only via docsvfs MCP (no Cursor built-in `read_file` shortcut).

| Session | Goal              | Steps | Pre-MCP built-ins¹ | `docs` | `density` | `remember` | Cited from `/memory` | Cited from `/docs` | Drift? | Verdict |
|---------|-------------------|-------|--------------------|--------|-----------|------------|----------------------|--------------------|--------|---------|
| S1      | Storage layout    | n/a   | **~9**             | **~10**| 0         | **3**      | —                    | **5 distinct**     | **1 self-recovered** | ✓ — write path established on weaker model; 4,911 B pinned to `/memory`; cross-vendor C1 vocabulary confirmed |
| S2      | Sample stratification | n/a | **~5** (improving) | **~7** | **0**     | **3** (after self-correcting from 5) | **3 of 3 S1 notes by name (LIST only — did NOT `cat`-read)** | **3 distinct** | **No wire-level drift**; one planning self-correction | ✓ at LIST level / ✗ at READ level — C2 substrate proven, integration depth weaker than Opus. 6,898 B across 6 rows |
| S3      | Onboarding runbook | n/a  | **~13** (highest of chain) | **~12** | 0       | **2** (1 overwrite + 1 **append** — first append-mode use in any chain) | **6 of 6 `cat`-read in full** | **~7 distinct** (incl. 3 additive: Bergson, TracStar, ATTRIBUTION_RUNBOOK) | **No** | ✓ **Chain complete.** 6.8 KB runbook + 162 B append patch = 6,997 B; cited with line-range precision; self-verified own write; **C2 integration fully evidenced on Cursor** |

¹ Cursor's *built-in* workspace tools (`Searched files`, `Grepped`, `Read remember.json L1-67`, `Read docs.json L1-18`) used as pre-flight before the model reached for docsvfs MCP. Tracked as a discoverability observation — see below.

**S1 result (2026-05-11):** The Cursor free-default model exercised the same Unix surface as Opus 4.7 — `tree`, `find`, `head`, `grep -l`, `grep -n -E`, `sed -n 'X,Yp'`, stderr redirect (`2>/dev/null`), shell `||` fallback — *zero docsvfs-specific syntax*. Three structured `remember` calls landed cleanly (`/memory/dolma3-storage-layer-{r2,modal-volumes,local-caches}.md`, **1,682 + 1,690 + 1,539 = 4,911 B total**), one initial improperly-nested call rejected by schema validator and self-corrected on retry. Final answer matched Opus's three-layer R2/Modal/local-caches breakdown with 5 of 6 distinct `/docs` files cited (Opus cited 6). Cursor pinned ~48% of Opus's byte volume across the same 3 notes — more concise. Full trace + DB snapshot confirmed in [`evidence/layer-b/cursor/S1.md`](evidence/layer-b/cursor/S1.md) and [`evidence/layer-b/cursor/db-snapshots/after-S1.tsv`](evidence/layer-b/cursor/db-snapshots/after-S1.tsv).

**Discoverability finding (Cursor-specific):** Before reaching for the MCP, the model made ~9 calls to Cursor's *built-in* file tools and **explicitly read the MCP tool JSON schemas** (`remember.json`, `docs.json`) to verify the surface. Not a C1 failure — once it trusted docsvfs, every subsequent call was via MCP and the Unix vocabulary translated 1:1. But it's a real adoption-friction observation: a system-prompt nudge like "for `/docs` and `/memory` paths, use docsvfs MCP" would shave that warmup. Worth tracking across S2/S3 to see if it persists.

**Still outstanding for S1:** Screenshot of a `remember` tool-call render (`screenshots/S1-remember.png`) — nice-to-have, not blocking. The DB snapshot is captured and confirmed; all three byte counts known.

**S2 result (2026-05-11):** **C2 substrate proven; integration depth weaker than Opus.** Model successfully `ls -la /memory` via docsvfs (after one failed host-shell attempt that returned "No such file or directory" — Cursor briefly routed `ls /memory` through its built-in shell before switching to MCP), saw all 3 S1 notes with correct byte counts (1539+1690+1682), and acknowledged them by name in the final answer. **However: it did NOT `cat`-read the S1 notes' contents** — only listed them. Opus on Claude Desktop S2 batched-cat'd all three S1 notes and explicitly carried R2/Modal/local-caches content forward into S2's reasoning. Cursor demonstrated *awareness* of `/memory`, not *integration*. That's the cross-client integration delta worth flagging. Three new `remember` calls landed after a planning self-correction (model first considered 5 calls, re-read the prompt's "three design choices" constraint, executed 3). New pins: `attribution-{stratified-576-weborganizer-bins, docs-per-bin-500-1k-5k-10k-tiers, deterministic-within-bin-selection-seed-42}.md` totaling 1,987 B. Final answer correctly distinguished the 100K uniform-random preconditioner from stratified samples — a subtle source-doc distinction preserved. Model proactively re-ran `ls -la /memory` at the end to self-verify the 6-row state. Pre-flight built-in scan reduced from ~9 (S1) to ~5 (S2) — model learning the chain. Full capture in [`evidence/layer-b/cursor/S2.md`](evidence/layer-b/cursor/S2.md).

**Cursor-specific finding — Ask vs Agent:** Cursor's free-plan capacity throttling temporarily blocked Agent-mode chats. User attempted "Ask" mode as a workaround; **Ask mode does NOT execute MCP tool calls** — empirically confirmed before the S2 run. The MCP surface is reachable only through Cursor's agentic modes (`Agent`, `Plan`, `Debug`, `Multitask`), not `Ask`. Adoption-friction observation for rate-limited tiers: if Agent is throttled, the MCP isn't usable until capacity clears.

**Still outstanding for S2:** Screenshot of S2 `remember` render → not blocking. DB snapshot captured 2026-05-11; byte-perfect match to the pre-computed prediction (6 rows / 6,898 B).

**S3 result (2026-05-11):** **Chain complete on Cursor; C2 integration definitively evidenced.** The S2 question (*"is list-only behavior model-class?"*) is answered: **no**. When the S3 prompt asked for `cat`, the Cursor model `cat`-read all 6 prior `/memory` notes, then cross-verified their facts in `/docs` (5 targeted `grep -n`/`sed -n` calls), then identified influence-function tooling as a topic gap not covered in /memory and pulled 3 additive `/docs` files (`BERGSON_REFERENCE.md`, `TRACSTAR_PIPELINE.md`, `ATTRIBUTION_RUNBOOK.md`). Produced a 6,835 B onboarding runbook in one `remember` overwrite call — then **read it back, found a vague citation, and patched it via `remember` with `append:true`** (final size 6,997 B). **First append-mode usage in any Layer B chain.** Final answer cites both `/memory/X.md` (prior session work) and `/docs/Y.md` with explicit line ranges (L24–L25, L46–L71, L94–L97, etc.) — *more citation-precise than Opus's S3 runbook*. Three things Cursor did *better* than Opus: append-mode self-correction, line-range citations, explicit narration of the additive-memory pattern. Three things Opus did better: zero pre-flight cost (Cursor had ~13 built-in calls + reading DEMO_RUNS.md L1-120 to figure out the architecture), proactive `stats` call, denser notes. Full capture in [`evidence/layer-b/cursor/S3.md`](evidence/layer-b/cursor/S3.md).

**Status implication:** With the full 3-session chain holding on Cursor (write → read → synthesize) and the C2 integration gap from S2 resolved by S3, the conditions for advancing **C1 and C2 from `partially-evidenced` to `evidenced`** are met. See Status block + changelog.

**Still outstanding for S3:** DB snapshot (`db-snapshots/after-S3.tsv`) not yet captured. Pre-computed expected state in S3.md (7 rows / 13,895 B). Screenshot of S3 `remember` render → not blocking.

---

## Delta vs Ollama floor

Headline numbers, baseline vs Claude Desktop (Opus 4.7), measured on the
same 3-session chain with corpus-matched prompts:

| Dimension                                | Ollama baseline (2026-05-09)              | Claude Desktop (2026-05-10)                                  | Delta              |
|------------------------------------------|--------------------------------------------|--------------------------------------------------------------|--------------------|
| `remember` calls in S1                   | **0**                                      | **3**                                                        | +3                 |
| Total `remember` calls across S1+S2+S3   | **0**                                      | **7** (3 + 3 + 1 synthesis runbook)                          | +7                 |
| `/memory` bytes persisted post-chain     | **0** B (mount-root inode only)            | **~31,153** B across 7 notes                                 | +31 KB             |
| Cross-session carry-over (S2)            | None — `/memory` empty, model drifted      | All 3 S1 notes `cat`-ed via fresh-chat `ls /memory` → batched `cat` | full chain         |
| Synthesis (S3)                           | JSON-as-text drift; no synthesis attempted | 13.1 KB runbook integrating 6 prior notes + 4 `/docs` files | qualitative win    |
| Tool-call drift count                    | **2 of 3 sessions**                        | **0 of 3 sessions**                                          | -2                 |
| Tools exercised in real workflow         | `docs` only (and intermittently)           | `docs`, `density` (S2), `remember`, `stats` (S3) — **all 4** | full surface       |
| Provenance fidelity                      | n/a (nothing written)                      | 7 of 7 rows tagged `source=tool` correctly                   | new evidence       |
| Janitor C3 substrate                     | Vacuous (nothing to operate on)            | 7 notes / 31 KB of real substrate available                  | unblocked          |

The qualitative story behind these numbers: the local model on the
2026-05-09 baseline announced *"Now, let's save this information"* in
prose, then never emitted a structured `remember` call. The MCP-routed
frontier model on 2026-05-10 announced *"Three notes pinned. Quick
verification"* and then `ls -la`'d the directory to confirm. Same
DocsVFS server, same corpus, same three-goal chain. The change is the
wire format and the model's training to honor it — which is the
structural fix the 2026-04-21 MCP pivot was predicated on.

**What advances:** C1 + C2 both have full within-client evidence
(see Status block above for the precise wording). C3 has real
substrate for the first time — janitor can now flag/dedup/prune
against 31 KB of agent-authored writes instead of running vacuously.

**What's still ahead:** cross-client replication on Claude Code +
Cursor (to push C1/C2 from `partially-evidenced` → `evidenced`),
a real janitor run against the populated DB (for C3), the threat-model
write-up (also for C3), and then Layer C public benchmark work.
Distribution channels in §4 of `MCP_POSITIONING.md` are all still
`not-started`; the within-client Layer B evidence is what unlocks
the first Smithery / `.mcpb` submissions.

---

## Status (mirrors `MCP_POSITIONING.md`)

| Claim | Status                | Evidence                                                                  |
|-------|-----------------------|---------------------------------------------------------------------------|
| C1    | `evidenced` (2026-05-11) | **Full 4-tool surface exercised across two hosts and two model classes.** Claude Desktop / Opus 4.7: `docs` (ls/cat batched + tree + head -N + sed -n 'X,Yp' + grep -B -A -i piped to head), `density` (4 coarse-filter calls in S2), `remember` (7 calls across S1+S2+S3), `stats` (proactive call in S3). Cursor / Free-default (Sonnet 4.x-class): same Unix vocabulary (`ls`, `tree`, `find`, `cat`, `head`, `grep -l/-r -l/-n -E`, `sed -n 'X,Yp'`, `2>/dev/null`, shell `||`) across all 3 sessions; `remember` 8 calls (3 + 3 + 2 incl. append) all structured. **Zero docsvfs-specific syntax invented on either host.** Honest caveat: both hosts are Anthropic-trained models; true cross-vendor (GPT or non-Anthropic) still outstanding but not blocking. Evidence: [`evidence/layer-b/claude-desktop/`](evidence/layer-b/claude-desktop/) + [`evidence/layer-b/cursor/`](evidence/layer-b/cursor/). |
| C2    | `evidenced` (2026-05-11) | **Full chain proven on two hosts.** Claude Desktop / Opus 4.7: write (S1, 3 calls, 10.2 KB), batched-cat read (S2, integrated S1 content), synthesis (S3, 13.1 KB runbook integrating 6 prior notes + 4 `/docs` additive reads). Cursor / Free-default: write (S1, 3 calls, 4.9 KB), list-and-name read (S2, awareness without content integration), full `cat`-and-synthesize (S3, 7 KB runbook + first **append-mode** patch in any chain, 6 of 6 prior notes read in full, line-range citations, 3 additive `/docs` reads for influence-function gap). All three sub-claims evidenced: write path (S1×2), read path (S2 Claude Desktop + S3 Cursor), synthesis (S3×2). Honest caveat: S2 on Cursor only evidenced list-level integration, not content-level; S3 closed the gap. Evidence: [`evidence/layer-b/claude-desktop/S{1,2,3}.md`](evidence/layer-b/claude-desktop/) + [`evidence/layer-b/cursor/S{1,2,3}.md`](evidence/layer-b/cursor/). |
| C3    | `partially-evidenced` | **Janitor lifecycle evidenced (2026-05-11); threat model still outstanding.** Smoke ([`smoke.txt`](evidence/layer-b/janitor/smoke.txt)) — 5/5 scenarios green. Fixture-CLI ([`fixture-cli.txt`](evidence/layer-b/janitor/fixture-cli.txt)) — `0/0/0/VACUUMed` against seeded `source=tool` fixture, all rows preserved. Real-DB ([`real-dry-run.txt`](evidence/layer-b/janitor/real-dry-run.txt), [`real-run.txt`](evidence/layer-b/janitor/real-run.txt)) — `0/0/0/VACUUMed` against the live 7-row 31-KB Claude Desktop DB; post-run snapshot ([`db-snapshots/after-janitor.tsv`](evidence/layer-b/janitor/db-snapshots/after-janitor.tsv)) diffs silently against `after-S3.tsv`, proving the janitor's default behavior preserves `source=tool` writes byte-for-byte. Substrate: 7 rows / ~31 KB. Slug truncation at `MAX_SLUG_LEN=60` observed working as designed on 2 of 7 notes. Outstanding: written threat model + cross-client replication before promoting to `evidenced`. |

---

## Changelog

- **2026-05-09** — Ollama baseline run, artifacts published to `evidence/layer-b/baseline-ollama/`.
- **2026-05-10** — Claude Desktop wired (config patched for nvm-managed node). Pre-run `stats` sanity check passed (boot 23ms, chunkCount 690, all 3 mounts healthy). Corpus-matched goal prompts authored. Folder scaffold ready under `evidence/layer-b/claude-desktop/`.
- **2026-05-10** — **S1 (storage layout) complete on Opus 4.7.** Three structured `remember` calls landed; `/memory` populated with `dolma3-storage-layer-{r2,modal-volumes,local-caches}.md` totaling 10,235 bytes; final answer cited 6 distinct `/docs` files; zero tool-call drift. C1 strengthened, C2 advanced from `claim` → `partially-evidenced` (write path).
- **2026-05-10** — **S2 (sample stratification) complete on Opus 4.7. C2 read path evidenced.** Fresh chat opened first action as `ls -la /memory`, then issued a single batched `cat` of all 3 S1 notes, then exercised `density` (4 calls — `stratif`, `576`, `10000`, `blake2b`) as a coarse filter before targeted `cat`/`grep`, then pinned 3 new notes for the working-sample design choices (576-bin stratification, flat per-bin ladder with underfill, deterministic blake2b priority). Final answer explicitly carries the S1 storage notes forward. `/memory` now 6 files. First real-world `density` usage in any demo. Slug-truncation observed (intentional, `MAX_SLUG_LEN=60` in `src/remember-tool.ts`) on two design-choice topic names.
- **2026-05-10** — **S3 (onboarding runbook) complete on Opus 4.7. Chain complete; synthesis proven.** Fresh chat opened with a proactive `stats` call (first organic `stats` use in any chain), then `ls /memory`, then read all 6 prior notes one at a time, then did page-by-page `head -N`/`sed -n 'X,Yp'` verification of 4 `/docs` files (`ATTRIBUTION_RUNBOOK.md`, `BERGSON_REFERENCE.md`, `TRACSTAR_PIPELINE.md`, `WORKING_SAMPLE_DATA_ACCESS.md`), then emitted **one** `remember` call writing a 13.1 KB onboarding runbook that integrates data locations, recommended starting sample (`sample_500_docs`), and Bergson/TracStar influence-function tooling — with every claim attributed to either a `/memory/<slug>.md` path or a specific `/docs/X.md` file. `/memory` reached 7 notes / ~31 KB. All four MCP tools now have real-workflow evidence. Notable finding: the model read `/docs` files beyond what `/memory` had (because influence-function tooling was a topic gap S1+S2 didn't cover) — that's *additive memory behavior*, the right hybrid. Layer B Claude Desktop chain is functionally complete.
- **2026-05-11** — **Cursor S1 (storage layout) complete on Free-plan default (Sonnet 4.x-class).** First cross-vendor run on a non-Anthropic-native host with a non-flagship model. The Cursor model made ~9 pre-flight calls to Cursor's *built-in* workspace tools (and explicitly read `remember.json` + `docs.json` schemas) before reaching for the docsvfs MCP — a real adoption-discoverability observation worth tracking. Once it trusted the MCP surface, it used canonical Unix (`tree -L 3 2>/dev/null \|\| find`, `grep -l`, `grep -n -E`, `sed -n 'X,Yp'`) across ~10 `docs` calls. Three structured `remember` calls landed (**1,682 + 1,690 + 1,539 = 4,911 B total**, confirmed by `after-S1.tsv`); one initial improperly-nested call was rejected by the schema validator and self-corrected on retry — the validator did its job. Final answer matched Opus's R2/Modal/local-caches three-layer breakdown with 5 of 6 distinct `/docs` files cited (Opus cited 6). Cursor pinned ~48% of Opus's byte volume across the same 3 notes — more concise. **C1 strengthened**: the Unix-vocabulary claim now has evidence from a weaker model on a different host. **C1/C2 status unchanged** (held at `partially-evidenced` pending Cursor S2 + S3 to complete the cross-client chain). Full capture in [`evidence/layer-b/cursor/S1.md`](evidence/layer-b/cursor/S1.md); discoverability finding tracked in folder README.
- **2026-05-11** — **Cursor S2 (sample stratification) complete. C2 substrate proven; integration depth weaker than Opus.** Fresh chat, same Cursor free-default model. `ls -la /memory` via docsvfs successfully returned all 3 S1 notes with correct byte counts — **after one failed host-shell `ls -la /memory 2>&1 || ls -la memory 2>&1` attempt that Cursor routed through `run_terminal_cmd` and got "No such file or directory" before the model self-corrected to MCP.** Three new `remember` calls landed (`attribution-{stratified-576-weborganizer-bins, docs-per-bin-500-1k-5k-10k-tiers, deterministic-within-bin-selection-seed-42}.md`, 594+630+763 = 1,987 B), after a planning self-correction from 5 calls to 3 (model re-read the prompt's "three design choices" constraint). **Critical C2 finding: model acknowledged all 3 S1 notes by name in its final answer but did NOT `cat`-read their contents** — *awareness without integration*. Opus on Claude Desktop batched-cat'd the S1 notes and explicitly carried their content forward; Cursor's model treated `/memory` as a discoverable-but-not-consumable index. Substrate-level C2 (rows persisted, fresh-chat listing works) is fully evidenced; integration-depth C2 (model reads + synthesizes prior notes) is not. Other deltas vs Opus: 0 `density` calls (Opus used 4), ~5 built-in pre-flight calls (down from S1's ~9 — improving), explicit self-verification `ls -la /memory` after writes. **Cursor-specific Ask-vs-Agent finding documented:** Ask mode does NOT execute MCP tool calls; only agentic modes do. **C1 strengthened further** (Unix vocabulary holds at session 2); **C2 status held at `partially-evidenced`** — substrate proven on Cursor but integration-depth claim still needs cross-client evidence (Opus chain already evidences integration; Cursor doesn't yet). Full capture in [`evidence/layer-b/cursor/S2.md`](evidence/layer-b/cursor/S2.md).
- **2026-05-11** — **Cursor S3 (onboarding runbook) complete. Chain complete; C2 integration question definitively resolved. C1 + C2 advance to `evidenced`.** The diagnostic synthesis session — explicit `ls /memory` AND `cat` prior notes instruction. Cursor's Free-default model `cat`-read all 6 prior `/memory` notes in full (resolving S2's open question — list-only behavior was prompt-specific, not model-class), cross-verified their claims in `/docs` (5 targeted `grep -n`/`sed -n` reads against bucket names, volume names, blake2b seed, 576 bins, line numbers L24/L25/L46-L71/L69-L78 etc.), then exercised the **additive memory pattern** by identifying influence-function tooling as a topic gap not in /memory and pulling 3 `/docs` files (`BERGSON_REFERENCE.md`, `TRACSTAR_PIPELINE.md`, `ATTRIBUTION_RUNBOOK.md`). Wrote the synthesis as a 6,835 B `remember` overwrite, then **read its own output back, found a vague citation precision issue, and patched via `remember` with `append:true` — the first append-mode call in any Layer B chain** (final size 6,997 B). Final answer cites both `/memory/X.md` (prior session work) and `/docs/Y.md` with explicit line-range precision — *more citation-precise than Opus's Claude Desktop S3 runbook*. Discoverability cost was the highest of the chain (~13 built-in pre-flight calls + reading DEMO_RUNS.md L1-120 to figure out the architecture before pivoting to MCP) — per-chat warmup is not learned across sessions. Final DB state: 7 rows / 13,895 B (Opus chain ended at 7 rows / 31,145 B — same row count, ~45% of byte volume; consistent style observation across the Cursor chain). **C1 advances to `evidenced` (2026-05-11):** full 4-tool surface + canonical Unix vocabulary exercised cleanly across two hosts and two model classes. **C2 advances to `evidenced` (2026-05-11):** write path (S1×2), read path (S2 Claude Desktop + S3 Cursor), synthesis (S3×2) — all three sub-claims hold on both hosts. Honest caveat: both hosts use Anthropic-trained models; true GPT/non-Anthropic cross-vendor is still outstanding but not blocking promotion. Full capture in [`evidence/layer-b/cursor/S3.md`](evidence/layer-b/cursor/S3.md).
