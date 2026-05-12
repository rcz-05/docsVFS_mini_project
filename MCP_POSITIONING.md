# MCP Positioning — DocsVFS

> **Status:** 2026-04-21 — 4 MCP tools `implemented` locally (smoke + Inspector green); not yet published to a registry.

## 0. Purpose + maintenance contract

This file is the canonical record of **why DocsVFS is positioned as an MCP server**, **what claims we make publicly**, and **what evidence backs each claim**. It is a living document.

Rule: any change to the shipped MCP surface (new tool, renamed tool, changed JSON schema, new install path, new registry listing, new benchmark result) **must update this file in the same commit**. The README, `server.json`, Smithery manifest, and any marketing copy are *derived* from this file — if they conflict, this file wins and the derivatives get rewritten.

Status markers used below — keep them honest; advancing one requires an evidence link:

- Claims: `claim` → `partially-evidenced` → `evidenced`
- Tools: `proposed` → `specced` → `implemented` → `shipped`
- Distribution: `not-started` → `submitted` → `live` → `rejected`
- Testing layers: `designed` → `running` → `published`

---

## 1. Why we shifted

**The failure that motivated the pivot.** Our 3-session live demo on 2026-04-19 used llama3.1:8b via Ollama's OpenAI-compat endpoint. DocsVFS itself performed correctly — 13–38ms boot, 32 real docs readable via `tree`/`cat`/`ls`, `/memory` mount writable across three back-to-back agent processes sharing one SQLite DB, janitor clean. But across all three sessions the model **never emitted a structured `remember` tool call** — it wrote the call as backtick-quoted prose (S1), as textual `docs(...)` descriptions (S2), or as JSON-in-content (S3). `/memory` stayed empty, S2/S3 had no handoff material, and cross-session persistence collapsed. Full entry: [`examples/DEMO_RUNS.md`, 2026-04-19](examples/DEMO_RUNS.md).

Follow-up smoke tests on qwen3:8b, mistral-nemo, and hermes3:8b confirmed the failure generalizes: every small local model we tried emitted the terminal tool call as text, or produced output the compat layer dropped entirely. See [`memory/ollama_tool_calls.md`](.claude/projects/-Users-rayancastillazouine-Documents-Claude-Projects-DocsVFS/memory/ollama_tool_calls.md) in the agent's auto-memory for the per-model breakdown.

**What MCP changes structurally.** The failure is "weak model + lossy wire format," not "DocsVFS is broken." MCP addresses both halves:

- The wire format stops being our problem. MCP is transport-agnostic (stdio / SSE / streamable HTTP) and tool-call discipline lives in the *client* — Claude Desktop, Claude Code, Cursor — using models that were trained for it.
- The audience changes from "anyone who can run the Vercel AI SDK" to "anyone running an MCP-speaking client." That's the install base that actually succeeds at multi-step tool use.
- Every serious doc-tooling competitor — Context7, GitMCP, Mintlify's auto-MCP, the reference `server-filesystem` — is consumed as MCP. The library + CLI we have today is infrastructure; the MCP server is the product.

The existing library + CLI stay shipped. They're the shared core that the MCP server wraps, and they remain useful for non-MCP embedders.

---

## 2. The wedge

**One-line pitch:** *Context7 for your own docs, with a memory the agent keeps between sessions.*

**Competitive landscape:**

| Server | Owns | Our opening |
|---|---|---|
| **Context7** (Upstash, ~14M monthly visits) | library/framework docs from a curated central DB | can't index your own private docs |
| **GitMCP** | public GitHub repos as a remote URL | public-only, read-only, no memory |
| **Mintlify auto-MCP** | Mintlify-hosted doc sites | vendor-locked to Mintlify-hosted content |
| **`@modelcontextprotocol/server-filesystem`** | generic allow-listed file ops | no doc awareness, no memory, no janitor, no density |
| **DocsVFS** | private/local doc folders + Unix primitives + writable `/memory` with provenance | (ours to define) |

**Differentiator claims** (each carries a status marker; advancing one requires evidence):

- **C1 — Unix primitives the agent already knows.** `ls`, `cd`, `cat`, `grep`, `find`, `tree`, `head`, `tail`, `wc` — zero new vocabulary. Every other doc-MCP invents its own query surface. **Status:** `partially-evidenced` (2026-05-10). Opus 4.7 in Claude Desktop exercised the full surface in two back-to-back goal chats: `ls`, `tree`, `cat` (single and batched), `grep -B -A -i ... | head -N` for targeted excerpts, multi-file `grep ... 2>/dev/null`. Cross-client replication on Claude Code + Cursor still outstanding before advancing to `evidenced`. Evidence: [`DEMO_RUNS.md`, Claude Desktop section](DEMO_RUNS.md#claude-desktop-opus-47).
- **C2 — Writable `/memory` + `/workspace` mounts with provenance.** `session_id` + `source` (`agent` / `tool` / `human` / `tool`) tagged on every write; janitor-safe; TTL on `/workspace`. No other docs MCP persists agent-authored notes across sessions. **Status:** `partially-evidenced` (2026-05-10). Within Claude Desktop, the full cross-session handoff is demonstrated: S1 (storage layout) wrote 3 notes via structured `remember` calls (10,235 bytes, all `source=tool`); S2 (sample stratification) opened a fresh chat, first action `ls -la /memory`, batched `cat` of all 3 prior notes, and explicitly carried them into its final answer before adding 3 more notes. C2 read path + write path both proven on one client. Evidence: [`evidence/layer-b/claude-desktop/S1.md`](evidence/layer-b/claude-desktop/S1.md) + [`evidence/layer-b/claude-desktop/S2.md`](evidence/layer-b/claude-desktop/S2.md). One more client run would push to `evidenced`.
- **C3 — Security-first.** Read-only `/docs` by default (EROFS on writes), explicit `/memory` write mount, no shell-exec escape into the host, single-process SQLite (no distributed concurrency attack surface). Relevant given CVE-2025-49596 (MCP Inspector RCE) and the April 2026 zero-click Claude DXT flaw. **Status:** `partially-evidenced`. Evidence to date: clean MCP Inspector transcripts in [`tests/inspector/`](tests/inspector/) showing well-formed schemas and no transport-layer surprises; smoke test confirming EROFS behavior on `/docs` and slug-escape collapse on `remember`; **janitor lifecycle (2026-05-11)** — in-process smoke ([`evidence/layer-b/janitor/smoke.txt`](evidence/layer-b/janitor/smoke.txt), 5/5 scenarios), fixture-CLI ([`evidence/layer-b/janitor/fixture-cli.txt`](evidence/layer-b/janitor/fixture-cli.txt), `0/0/0/VACUUMed` against a seeded `source=tool` fixture), and **real-DB capture** against the populated Claude Desktop chain DB ([`evidence/layer-b/janitor/real-run.txt`](evidence/layer-b/janitor/real-run.txt) — `0 expired, 0 duplicates, 0 flagged, VACUUMed`; post-run snapshot [`evidence/layer-b/janitor/db-snapshots/after-janitor.tsv`](evidence/layer-b/janitor/db-snapshots/after-janitor.tsv) diffs silently against `after-S3.tsv`, proving the janitor's default behavior preserves `source=tool` writes byte-for-byte). Still outstanding: a written threat model, adversarial-input smoke against `remember` slug paths, and cross-client replication.

**Tool-count discipline.** Cursor caps ~40 active tools across all servers; agents degrade past ~20. DocsVFS's surface is intentionally small (see §3) — that's an adoption advantage vs. kitchen-sink filesystem servers, not an oversight.

---

## 3. Tool surface

Target: **4 tools**, with explicit rationale for what we did *not* expose. Each tool tracks a lifecycle state.

| Tool | Purpose | Status |
|---|---|---|
| `docs` | Bash command over the VFS. One entry point for `ls`, `cat`, `grep`, `find`, `tree`, `head`, `tail`, `wc`, pipes, redirects. Returns stdout/stderr/exitCode. | `implemented` |
| `remember` | Structured write to `/memory/<slug>.md` with overwrite/append mode and optional provenance note. Tagged `source: "tool"`. Registered only when `--memory` is set. | `implemented` |
| `density` | Term-frequency ranking across a path. Returns ranked files + ASCII bars + a drill-in suggestion. | `implemented` |
| `stats` | Lightweight introspection — file counts per mount, boot time, index state, last-write timestamps. No bash overhead. | `implemented` |

All four tools implemented in [`src/mcp/server.ts`](src/mcp/server.ts) + [`src/mcp/bin.ts`](src/mcp/bin.ts), matching the schemas in [`MCP_TOOL_SCHEMAS.md`](MCP_TOOL_SCHEMAS.md). Validated by `scripts/mcp-smoke.mjs` (37/37 assertions across both modes) and the MCP Inspector CLI — transcripts in [`tests/inspector/`](tests/inspector/). Advancement to `shipped` requires registry publication (see §4).

**Not exposed as MCP tools (and why):**

- `janitor` — maintenance op with destructive potential (prunes, deletes). Stays CLI-only and agent-unreachable. Humans run it; agents never should.
- `grep` / `ls` / `cat` as separate tools — folded into `docs`. Splitting them inflates tool count against the Cursor 40-tool ceiling without adding capability.
- `write_docs` / `edit_docs` — `/docs` is structurally read-only. Adding a write path would break C1's "just a filesystem the agent knows" and C3's security story.

**Tool schemas live in code, not here.** When each tool reaches `implemented`, link the commit SHA and the JSON schema file from this table. When it reaches `shipped`, link the registry `server.json` entry.

---

## 4. Distribution

Ranked by expected adoption impact. Publish Tier 1 with care; Tier 3 is "submit once and forget."

| Channel | Tier | Status | URL (when live) | Notes |
|---|---|---|---|---|
| Anthropic Claude Connectors directory | 1 | `not-started` | — | Curated, `.mcpb` one-click install path. Highest non-dev surface. Gated by Anthropic review. |
| Smithery | 1 | `not-started` | — | `npx @smithery/cli install docsvfs --client claude` is the canonical README phrase in 2026. |
| GitHub MCP Registry | 2 | `not-started` | — | GitHub pushes this through Copilot / VS Code. Cheap to list, meaningful reach. |
| Official `registry.modelcontextprotocol.io` | 2 | `not-started` | — | Preview as of 2026-04; metadata root for subregistries. Not a traffic source directly but required for others. |
| PulseMCP (editorial) | 2 | `not-started` | — | Hand-reviewed; a "Top Pick" badge outweighs 10 scraped listings. |
| `wong2/awesome-mcp-servers` | 3 | `not-started` | — | PR merge is easy; shows up in "best of" roundups. |
| `appcypher/awesome-mcp-servers` | 3 | `not-started` | — | Same. |
| Glama | 3 | `not-started` | — | Automated scrape. Submit anyway. |
| mcp.so | 3 | `not-started` | — | Automated scrape. Submit anyway. |

**README install quadrant (target shape for launch):**

1. `npx -y docsvfs-mcp /path/to/docs` (stdio, client JSON)
2. `npx @smithery/cli install docsvfs --client <claude|cursor>`
3. Cursor deeplink button (`cursor://anysphere.cursor-deeplink/mcp/install?...`)
4. `docsvfs.mcpb` bundle for one-click Claude Desktop install

**Optional (post-launch):** hosted remote mode à la GitMCP — `https://docsvfs.io/<owner>/<repo>` — biggest discovery multiplier if we can afford the ops. Deferred; tracked in §8.

---

## 5. Testing layers

Three independent layers, each shippable as its own artifact. None is the "one true test" — they answer different questions.

### Layer A — MCP correctness (table-stakes)
**Tool:** [`modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector).
**What it proves:** schema validity, error handling, transport compliance, `tools/list` stability.
**Acceptance:** every tool in §3 passes Inspector with no warnings; a session transcript committed to `tests/inspector/`.
**Status:** `published`. Transcripts committed 2026-04-21 for all 4 tools against the bundled `demo-docs/` corpus. JSON Schema renders cleanly (draft-07), `structuredContent` validates against declared `outputSchema`, stderr is empty. See [`tests/inspector/README.md`](tests/inspector/README.md). Supplemented by [`scripts/mcp-smoke.mjs`](scripts/mcp-smoke.mjs) — 37/37 assertions, runs both `--memory` and read-only modes.

### Layer B — Real-agent qualitative (the story)
**Clients:** Claude Code (CLI), Claude Desktop (UI, validates `.mcpb`), Cursor (IDE, validates the 40-tool-ceiling assumption).
**Corpus:** `~/data-attribution-demo/docs` snapshot @ 8db3886 (same one used in the 2026-04-19 Ollama run — keeping corpus constant isolates the agent-quality variable).
**Goals:** the three from `scripts/demo-multi.mjs` — GPU inventory → SLURM gotchas → runbook synthesis.
**Deliverable:** full MCP traces + a new `DEMO_RUNS.md` entry showing the delta vs. the Ollama floor. The delta itself is the marketing artifact.
**Status:** `designed`.

### Layer C — Public benchmark (the moat)
**Why it matters:** the research surfaced a real gap — no canonical doc-retrieval MCP benchmark exists. MCP-Bench (Accenture, NeurIPS 2025) covers 28 servers but none are docs-focused. Building this is a disproportionate marketing multiplier.
**Shape:** 30 Q&A tasks over a fixed frozen docs corpus, LLM-judged answer accuracy + tokens burned + wall time. Baselines: DocsVFS vs. `server-filesystem` vs. Context7 vs. GitMCP.
**Deliverable:** public harness + corpus + leaderboard page.
**Status:** `designed` — not starting until Layer A and Layer B are both `published`.

---

## 6. Open questions

Questions move to the changelog and disappear from this list once decided.

- **Q1.** Do we keep the existing AI SDK integration (`src/tool.ts`, `src/remember-tool.ts`) shipped alongside the MCP server, or deprecate it? Leaning yes-keep — it's ~200 lines, already tested, serves non-MCP embedders. But it stops being the advertised surface.
- **Q2.** Hosted remote mode yes or no? GitMCP-style public URL is the biggest discovery multiplier but costs ongoing ops.
- **Q3.** What corpus do we freeze for Layer C? `data-attribution-demo` is convenient but private-ish. A public fixed corpus (e.g. a snapshot of a well-known OSS project's docs) would be more credible for a leaderboard.
- **Q4.** Should `density` surface a per-mount scope parameter, or always scan all mounts? CLI behavior is "all mounts"; agents might want narrower.
- **Q5.** Stdio-only for v1, or also offer SSE/streamable-HTTP transport? Stdio is simpler and what Claude Desktop wants; SSE matters only for hosted remote mode (see Q2).

---

## 7. What this document is *not*

- Not a user-facing README (that stays short, demo-driven, four install paths at the top).
- Not a how-to-run-the-server guide (that goes in `docs/mcp-usage.md` once we ship).
- Not the project architecture doc (that's [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md)).
- Not a general project changelog (§8 below covers positioning + MCP surface decisions *only*).

---

## 8. Changelog

Append-only. Every commit that changes this file adds one entry. Format:

```
YYYY-MM-DD — <commit sha or "uncommitted"> — <one-line summary>
  Why: <reason the change was needed>
  Evidence: <link to run, benchmark, PR, or "none yet">
```

---

- **2026-04-19 — 1780f07 — initial draft**
  - **Why:** set the positioning contract before writing the MCP server. The Ollama 3-session run on the same date showed small-local-model tool-call drift collapsing `/memory` persistence; the fix isn't more prompt engineering, it's shipping the product on the wire format its users actually speak.
  - **Evidence:** [`examples/DEMO_RUNS.md` entry 2026-04-19](examples/DEMO_RUNS.md), [auto-memory `ollama_tool_calls.md`](.claude/projects/-Users-rayancastillazouine-Documents-Claude-Projects-DocsVFS/memory/ollama_tool_calls.md). All §3 tools start at `proposed`, all §4 channels at `not-started`, all §5 layers at `designed`.

- **2026-04-21 — eb6001b — lock 4 tool schemas on paper; introduce `specced` lifecycle state**
  - **Why:** step 2 of the post-Ollama sequence — decide the wire surface deliberately before accreting it from code. Prevents late-stage backpedaling on tool names, arg shapes, and security invariants once implementation starts. A locked contract also lets README + Smithery + `server.json` copy be drafted in parallel with the server implementation instead of after it.
  - **Evidence:** [`MCP_TOOL_SCHEMAS.md`](MCP_TOOL_SCHEMAS.md) — 4 tools (`docs`, `remember`, `density`, `stats`), protocol baseline (stdio-only v1, `tools` capability only, MCP spec 2025-06-18+), unified error convention (`isError: true` is structural only — agent-recoverable errors stay `isError: false`), size caps table, per-startup-flag availability matrix, and a non-goals list preventing future surface bloat.
  - **Changes to this file:** §0 tool lifecycle gains `specced` state between `proposed` and `implemented`; §3 table advances all 4 tools from `proposed` to `specced` and links to the schemas doc.

- **2026-04-21 — uncommitted — implement 4 tools; pass Layer A (Inspector + smoke); advance C3 to `partially-evidenced`**
  - **Why:** step 3 of the post-Ollama sequence — make the locked schemas real. The contract in `MCP_TOOL_SCHEMAS.md` is worthless until a server actually speaks it on stdio. Also: Layer A (MCP correctness) is the gate every downstream step depends on. A server that fails Inspector will fail every real MCP client, so this layer publishes first.
  - **What shipped:** [`src/mcp/server.ts`](src/mcp/server.ts) (4 tools, zod-backed input/output schemas, `structuredContent` + JSON-text fallback, size-capped responses, stderr-only logging) + [`src/mcp/bin.ts`](src/mcp/bin.ts) (stdio entry, flag parsing, graceful shutdown). `createDocsVFS` gained an `alwaysMountDocs` option so `/docs` is a stable mount point whether `--memory` is on or off — the agent's mental model shouldn't depend on startup flags. New `docsvfs-mcp` bin in `package.json`.
  - **Evidence:**
    - [`scripts/mcp-smoke.mjs`](scripts/mcp-smoke.mjs) — 37/37 JSON-RPC assertions across both modes (`--memory` and read-only).
    - [`tests/inspector/`](tests/inspector/) — `tools/list` plus four `tools/call` transcripts via `@modelcontextprotocol/inspector --cli`. JSON Schema renders to draft-07 cleanly, no warnings.
    - §5 Layer A advances `designed → published`; C3 in §2 advances `claim → partially-evidenced` (EROFS/slug-escape behavior confirmed; threat model and adversarial Layer-B still outstanding).
    - §3 table: all 4 tools advance `specced → implemented`.
  - **Not yet shipped:** Layer B (real-client runs on Claude Desktop/Code/Cursor) is blocked on human action — server needs wiring into each client's config. All §4 distribution channels still `not-started`.

- **2026-05-09 — uncommitted — Layer B baseline (Ollama llama3.1:8b) published**
  - **Why:** lock the floor before measuring frontier delta. The same 3-session demo against the same DocsVFS server, but driven by `scripts/demo-multi.mjs --model llama3.1:8b`, produces a textbook failure: zero `remember` calls across all three sessions, tool-call drift in 2 of 3, `/memory` empty post-run, janitor vacuous. Same failure mode as the 2026-04-19 motivating incident, reproduced cleanly on the implemented MCP server.
  - **Evidence:** [`evidence/layer-b/baseline-ollama/SUMMARY.md`](evidence/layer-b/baseline-ollama/SUMMARY.md), `run.log`, per-session `.ndjson`, SQLite `.dump`. §5 Layer B advances `designed → running` (one rung published).

- **2026-05-10 — uncommitted — Layer B: Claude Desktop run, S1 + S2 of 3 complete; C1 + C2 advance to `partially-evidenced`**
  - **Why:** the rest of the post-Ollama sequence — replace the lossy OpenAI-compat wire format with a real MCP client (Opus 4.7 in Claude Desktop) and re-run the chain. Validates the structural fix the pivot was predicated on.
  - **Wiring:** docsvfs MCP server wired into `~/Library/Application Support/Claude/claude_desktop_config.json` alongside Cowork preferences. Bare `node` substituted with absolute nvm path (`/Users/.../.nvm/versions/node/v22.12.0/bin/node`) to work around macOS GUI apps not inheriting nvm shims. Pre-run `stats` sanity check: 23ms boot, chunkCount 690, all three mounts (`/docs` ro, `/memory` rw, `/workspace` rw + TTL) healthy.
  - **S1 result (storage layout):** Opus 4.7 emitted 3 structured `remember` tool calls cleanly; `/memory` populated with 10,235 bytes across three notes (R2 / Modal volumes / local caches); final answer cited 6 distinct `/docs` files; zero tool-call drift. C2 write path proven. Transcript: [`evidence/layer-b/claude-desktop/S1.md`](evidence/layer-b/claude-desktop/S1.md).
  - **S2 result (sample stratification):** Fresh chat, no prior context. First action was `ls -la /memory`, then a single batched `cat` of all three S1 notes — recovering 10,235 bytes of provenance-tagged state across an MCP-session boundary. Final answer explicitly carried the S1 notes forward and added 3 more covering working-sample design choices. C2 read path proven, completing the chain on Claude Desktop. **Notably, the first real-world `density` tool usage in any demo** — 4 calls (`stratif`, `576`, `10000`, `blake2b`) as a coarse filter before targeted `cat`/`grep`. Transcript: [`evidence/layer-b/claude-desktop/S2.md`](evidence/layer-b/claude-desktop/S2.md).
  - **Slug-truncation observation:** Two S2 topics exceeded `MAX_SLUG_LEN = 60` ([`src/remember-tool.ts:82`](src/remember-tool.ts)) and were intentionally clipped. Working as designed; no content lost. Worth surfacing in user docs ("topics longer than 60 chars will have their filenames truncated") if a registry listing or tutorial is drafted.
  - **Changes to §2:**
    - C1 advances `claim → partially-evidenced` (full 4-tool surface exercised within Claude Desktop; cross-client replication on Code + Cursor still outstanding before `evidenced`).
    - C2 advances `claim → partially-evidenced` (both write and read paths proven within one client; one more client demo would push to `evidenced`).
    - C3 unchanged (`partially-evidenced` — janitor + threat-model run still outstanding; `/memory` now has 6 rows of real substrate to test against).
  - **Not yet shipped:** S3 on Claude Desktop (synthesis-from-`/memory` runbook), Claude Code run, Cursor run, post-chain janitor run.

- **2026-05-10 — uncommitted — Layer B: Claude Desktop chain complete (S3 of 3). All 4 MCP tools have real-workflow evidence**
  - **Why:** close the within-client chain. With S1 (write) + S2 (read) proven, S3 is the synthesis test — does the model trust `/memory` enough to use it as primary state, or does it ignore it and re-explore `/docs`? Either outcome is publishable; the answer turns out to be neither extreme.
  - **S3 result (onboarding runbook synthesis):** Opus 4.7, fresh chat. Sequence: proactive `stats` call → `ls /memory` → six individual `cat /memory/...` reads (every prior note) → `tree /docs -L 2` → page-by-page `head -100` + `sed -n 'X,Yp'` reads of `ATTRIBUTION_RUNBOOK.md`, `BERGSON_REFERENCE.md`, `TRACSTAR_PIPELINE.md` → targeted `grep -n ... | head -30` + `sed -n` against `WORKING_SAMPLE_DATA_ACCESS.md` → one `remember` call writing a 13.1 KB integrated runbook with every claim attributed to a `/memory/<slug>.md` or `/docs/X.md` source. Zero tool-call drift. Counts: `stats`×1, `docs`×16, `density`×0, `remember`×1. `/memory` reaches 7 notes / ~31 KB. Transcript: [`evidence/layer-b/claude-desktop/S3.md`](evidence/layer-b/claude-desktop/S3.md).
  - **Headline finding — additive memory behavior:** the model read four `/docs` files beyond what `/memory` had, *because the influence-function tooling sub-topic was a gap S1 + S2 didn't cover*. That's the correct hybrid — `/memory` for prior work, `/docs` for territory `/memory` hasn't reached — not a failure of the "use ONLY `/memory`" prompt clause. The mental model going forward is **memory is additive, not exhaustive.** Worth carrying into Smithery / README marketing copy: the wedge is "memory across sessions," not "no more grep over /docs."
  - **First chain use of `stats`, `head -N`, `sed -n 'X,Yp'`.** Combined with S2's `density` calls, **all four MCP tools** (`docs`, `remember`, `density`, `stats`) now have real-workflow evidence. The C1 canonical-Unix vocabulary exercised across the chain: `ls`, `tree`, `cat` (single + batched), `head`, `sed`, `grep` (single + multi-file + piped to `head`). Notable absences (no evidence yet): `find`, `wc`, `cd`, and `/workspace` (the 24h-TTL scratch mount remained empty across all three sessions).
  - **Delta vs Ollama floor (full chain):** `remember` calls 0 → 7. `/memory` bytes 0 → ~31,153. Tool-call drift 2-of-3 sessions → 0-of-3. Synthesis attempts: JSON-as-text drift → 13.1 KB integrated runbook. Full table in [`DEMO_RUNS.md` §Delta](DEMO_RUNS.md#delta-vs-ollama-floor).
  - **Changes to §2:** C1 and C2 evidence strings updated to reflect S3 (no status-marker advance — held at `partially-evidenced` until cross-client replication on Claude Code or Cursor, per the original evidence target). C3 substrate is now real (7 rows, ~31 KB of `source=tool` writes) but the actual janitor run is still outstanding.
  - **Not yet shipped:** Claude Code Layer B run, Cursor Layer B run, post-chain janitor (`--fake-age` + prune/dedup/flag walkthrough), threat-model write-up. All §4 distribution channels still `not-started`. §5 Layer B advances `running → published` for the Claude Desktop sub-layer; Code + Cursor sub-layers stay `running`.

- **2026-05-11 — uncommitted — C3 — janitor lifecycle: smoke + fixture-CLI + real-DB captures committed**
  - **Why:** the C3 substrate became real after the Claude Desktop chain put 7 `source=tool` rows / ~31 KB into `/memory`. Until the janitor was actually run against that substrate, "destructive operations stay human-gated, never reachable from an agent" was an architectural claim, not an evidenced one. The captures below close the gap on what the janitor *does* — and equally important, what it *doesn't* do (it doesn't eat deliberate tool-tagged writes).
  - **What got captured:**
    - **Smoke (in-process):** [`scripts/smoke-janitor.mjs`](scripts/smoke-janitor.mjs) green in a Linux sandbox — 5/5 scenarios (dry-run, default, aggressive, `--older-than-days 7`, `--mounts` filter), every assertion. Capture: [`evidence/layer-b/janitor/smoke.txt`](evidence/layer-b/janitor/smoke.txt).
    - **Fixture-CLI:** `npx docsvfs janitor` against a seeded 3-row `source=tool` fixture DB → `0/0/0/VACUUMed`, all rows preserved. Capture: [`evidence/layer-b/janitor/fixture-cli.txt`](evidence/layer-b/janitor/fixture-cli.txt).
    - **Real-DB:** dry-run + real run against `~/data-attribution-demo/docs/.docsvfs.db` (the populated Claude Desktop chain DB, 7 rows / ~31 KB) → both reported `0 expired / 0 duplicates / 0 flagged`; the real run additionally `VACUUMed`. Captures: [`evidence/layer-b/janitor/real-dry-run.txt`](evidence/layer-b/janitor/real-dry-run.txt), [`evidence/layer-b/janitor/real-run.txt`](evidence/layer-b/janitor/real-run.txt). Post-run DB snapshot ([`evidence/layer-b/janitor/db-snapshots/after-janitor.tsv`](evidence/layer-b/janitor/db-snapshots/after-janitor.tsv)) diffed byte-for-byte against `after-S3.tsv` — **silent diff**.
  - **Why `0/0/0` is the *correct* outcome:** the `remember` tool always tags writes with `provenance.source = "tool"` ([`src/remember-tool.ts:127`](src/remember-tool.ts)). The janitor's stale-flag path matches only `source = "agent"` ([`src/memory/janitor.ts:153`](src/memory/janitor.ts)). The destructive paths still fire correctly on seeded fixtures (smoke covers this), but on a tool-tagged real DB they have nothing to do — which is the security invariant we want. Default behavior preserves `source=tool` writes byte-for-byte; destructive paths fire correctly on seeded fixtures.
  - **Changes to §2:** C3 evidence string enriched with links to the three new captures. **Status held at `partially-evidenced`** — cross-client replication on Claude Code + Cursor plus a written threat model are still required before promoting.
  - **Not yet shipped:** threat-model write-up, Claude Code + Cursor Layer-B chains, adversarial-input smoke against `remember` slug paths. All §4 distribution channels still `not-started`.

- **2026-05-11 — uncommitted — Cursor S1 (storage layout) — first cross-vendor evidence on a non-flagship model**
  - **Why:** C1's strongest claim form is *"Unix primitives the agent already knows, even on weaker models on non-Anthropic-native hosts."* Until today the C1+C2 evidence was Opus-4.7-on-Claude-Desktop only — a fair-weather test. Cursor on its Free-plan default (Sonnet 4.x-class auto-router) is the adversarial cross-vendor test: different MCP host, different transport quirks, different model class. S1 is the first of three sessions in that chain.
  - **What got captured:**
    - **MCP wiring:** global `~/.cursor/mcp.json` with absolute nvm node path and `--memory`; acid-tested by opening a non-DocsVFS folder and confirming docsvfs still loads. Server displays as `user-docsvfs` in Cursor's UI (Cursor prefixes user-installed MCP servers).
    - **Corpus:** copied to `~/data-attribution-demo-cursor/docs` with `.docsvfs.db*` wiped; chain starts from a fresh 0-row DB independent of Claude Desktop.
    - **Pre-flight test:** stats sanity-check returned the expected 32-file / 3-dir / 690-chunk shape. Model honestly characterized the `/docs` `0 B` total as "metadata-only or how sizes are counted" — that's the known TODO at `src/mcp/server.ts:421` (`totalBytes` not yet computed for read-only mount), not a bug. Model handled the ambiguity correctly.
    - **S1 transcript:** [`evidence/layer-b/cursor/S1.md`](evidence/layer-b/cursor/S1.md). Three structured `remember` calls landed (`/memory/dolma3-storage-layer-{r2,modal-volumes,local-caches}.md`, **1,682 + 1,690 + 1,539 = 4,911 B total** per [`db-snapshots/after-S1.tsv`](evidence/layer-b/cursor/db-snapshots/after-S1.tsv)), one initial improperly-nested call rejected and self-corrected on retry. ~10 `docs` calls using canonical Unix (`tree`, `find`, `grep -l`, `grep -n -E`, `sed -n 'X,Yp'`, `2>/dev/null`, `||`). Final answer: same R2/Modal/local-caches three-layer breakdown as Opus 4.7, 5 of 6 distinct `/docs` files cited. Cursor pinned ~48% of Opus's byte volume per note — more concise notes from the weaker model.
  - **The Cursor-specific discoverability finding:** before reaching for docsvfs MCP, the model made ~9 calls to Cursor's *built-in* workspace tools (`Searched files`, `Grepped`) and **explicitly read the MCP tool JSON schemas** (`remember.json`, `docs.json`) to verify the surface. Not a C1 failure — once trusted, every subsequent call routed through MCP and the Unix vocabulary translated 1:1. But it's a real adoption-friction observation: a system-prompt nudge like "for `/docs` and `/memory` paths, use docsvfs MCP" would shave the warmup. Tracked in [`evidence/layer-b/cursor/README.md`](evidence/layer-b/cursor/README.md) and will be re-evaluated after S2 + S3 to see if it persists.
  - **Changes to §2:** none yet — **C1/C2 held at `partially-evidenced`** until S2 (the load-bearing C2 read-path test on Cursor) and S3 complete. S1 evidence is the write-path corroboration; full chain needs all three sessions.
  - **Not yet shipped for this thread:** Cursor S2, Cursor S3, Cursor scorecard cross-client comparison in DEMO_RUNS.md "Delta" section, `screenshots/S1-remember.png` file (nice-to-have, not blocking). Threat model and adversarial-slug smoke (C3 gates) also still outstanding.

- **2026-05-11 — uncommitted — Cursor S2 (sample stratification) — C2 substrate proven, integration depth weaker than Opus**
  - **Why:** S2 is the load-bearing C2 read-path test. A fresh Cursor chat with no S1 context needs to (a) discover `/memory` exists, (b) read what S1 pinned, (c) carry that knowledge into the new task. S1 evidenced the write path; S2 evidences the read path. Without S2 succeeding, Cursor's C2 evidence stops at "we put rows in a DB" and never reaches "the next session uses them."
  - **What got captured:**
    - **MCP-mode finding (Ask vs Agent):** Cursor's free-plan capacity throttling temporarily blocked Agent-mode chats. User tested "Ask" mode as a workaround; **Ask mode does NOT execute MCP tool calls** — empirically confirmed before running S2. The MCP surface is reachable only through Cursor's agentic modes (`Agent`, `Plan`, `Debug`, `Multitask`), not the conversational `Ask` mode. Real adoption-friction observation for rate-limited tiers.
    - **`ls -la /memory` via docsvfs: SUCCESS** — returned all 3 S1 notes with correct byte counts (1539+1690+1682). **Important caveat:** model first tried `ls -la /memory 2>&1 || ls -la memory 2>&1` and got "No such file or directory" twice — Cursor briefly routed `ls /memory` through `run_terminal_cmd` (host shell) before the model narrated *"Using the DocsVFS MCP: `/memory` and `/docs` are virtual mounts"* and switched to MCP. Same discoverability pattern as S1's pre-flight, in compressed form.
    - **Three new `remember` calls landed** (`attribution-{stratified-576-weborganizer-bins, docs-per-bin-500-1k-5k-10k-tiers, deterministic-within-bin-selection-seed-42}.md`, 594+630+763 = 1,987 B). Notable: model first chain-of-thought-planned 5 calls, re-read the prompt's "three design choices" constraint, and self-corrected to 3. Instruction-following did the work.
    - **Self-verification:** Model proactively re-ran `ls -la /memory` after the writes and confirmed all 6 files were present. Unprompted verification step.
    - **S2 transcript:** [`evidence/layer-b/cursor/S2.md`](evidence/layer-b/cursor/S2.md). Final answer correctly distinguishes the stratified samples from the 100K uniform-random preconditioner (a subtle source-doc distinction preserved); cites 3 distinct `/docs` files.
  - **The C2 finding that matters most:** **Cursor model acknowledged the S1 notes by name in its final answer but did NOT `cat`-read their contents.** Opus on Claude Desktop S2 batched-cat'd all 3 S1 notes and explicitly carried R2/Modal/local-caches content forward into the S2 answer ("we already know R2 is the canonical layer..."). Cursor treated `/memory` as a discoverable index, not a corpus to actually consume. **Substrate-level C2 (rows persist, fresh chats can list them) is fully evidenced; integration-depth C2 (model reads + synthesizes prior notes) is NOT yet evidenced on Cursor.** This is honest cross-client data — it bounds the strength of the C2 claim. Whether the gap is model-class (Sonnet < Opus on read-then-synthesize), system-prompt (Cursor doesn't bias toward reading discovered files), or something else, will be testable in S3 where synthesis is the load-bearing requirement.
  - **Discoverability pattern across S1 → S2:** Cursor built-in pre-flight calls dropped from ~9 to ~5 (improving). Schema-file reads (`remember.json`, `docs.json`) persist both sessions. `density` usage: 0 in both (Opus used 4 in S2). A `.cursor/rules` system-prompt addition would likely fix both the host-shell-fallback and the schema-reread patterns consistently.
  - **Changes to §2:** **C1 strengthened** — Unix vocabulary holds at session 2 (same `tree`, `find`, `grep -r -l -E`, `grep -n -E`, `cat`, `sed -n 'X,Yp'`). **C2 held at `partially-evidenced`** — substrate proven, integration depth weaker than Opus. Status will be re-evaluated after Cursor S3 (synthesis test).
  - **Not yet shipped for this thread:** Cursor S3, screenshots/S2-remember.png (nice-to-have). DB snapshot captured 2026-05-11 — byte-perfect 6 rows / 6,898 B match to pre-computed prediction; confirms end-to-end consistency between `remember` response acks and SQLite persistence layer.
