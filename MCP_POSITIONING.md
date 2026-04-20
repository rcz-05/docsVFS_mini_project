# MCP Positioning — DocsVFS

> **Status:** initial draft, 2026-04-19. First public MCP release has not shipped.

## 0. Purpose + maintenance contract

This file is the canonical record of **why DocsVFS is positioned as an MCP server**, **what claims we make publicly**, and **what evidence backs each claim**. It is a living document.

Rule: any change to the shipped MCP surface (new tool, renamed tool, changed JSON schema, new install path, new registry listing, new benchmark result) **must update this file in the same commit**. The README, `server.json`, Smithery manifest, and any marketing copy are *derived* from this file — if they conflict, this file wins and the derivatives get rewritten.

Status markers used below — keep them honest; advancing one requires an evidence link:

- Claims: `claim` → `partially-evidenced` → `evidenced`
- Tools: `proposed` → `implemented` → `shipped`
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

- **C1 — Unix primitives the agent already knows.** `ls`, `cd`, `cat`, `grep`, `find`, `tree`, `head`, `tail`, `wc` — zero new vocabulary. Every other doc-MCP invents its own query surface. **Status:** `claim`. Evidence target: Layer B qualitative runs across three clients on the same goal set.
- **C2 — Writable `/memory` + `/workspace` mounts with provenance.** `session_id` + `source` (`agent` / `tool` / `human`) tagged on every write; janitor-safe; TTL on `/workspace`. No other docs MCP persists agent-authored notes across sessions. **Status:** `claim`. Evidence target: a multi-session Claude Code run where S2 provably reads S1's notes and builds on them.
- **C3 — Security-first.** Read-only `/docs` by default (EROFS on writes), explicit `/memory` write mount, no shell-exec escape into the host, single-process SQLite (no distributed concurrency attack surface). Relevant given CVE-2025-49596 (MCP Inspector RCE) and the April 2026 zero-click Claude DXT flaw. **Status:** `claim`. Evidence target: a written threat model + an Inspector clean-pass transcript.

**Tool-count discipline.** Cursor caps ~40 active tools across all servers; agents degrade past ~20. DocsVFS's surface is intentionally small (see §3) — that's an adoption advantage vs. kitchen-sink filesystem servers, not an oversight.

---

## 3. Tool surface

Target: **4 tools**, with explicit rationale for what we did *not* expose. Each tool tracks a lifecycle state.

| Tool | Purpose | Status |
|---|---|---|
| `docs` | Bash command over the VFS. One entry point for `ls`, `cat`, `grep`, `find`, `tree`, `head`, `tail`, `wc`, pipes, redirects. Returns stdout/stderr/exitCode. | `proposed` |
| `remember` | Structured write to `/memory/<slug>.md` with overwrite/append mode and optional provenance note. Tagged `source: "tool"`. | `proposed` |
| `density` | Term-frequency ranking across a path. Returns ranked files + ASCII bars + a drill-in suggestion. | `proposed` |
| `stats` | Lightweight introspection — file counts per mount, boot time, index state, last-write timestamps. No bash overhead. | `proposed` |

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
**Status:** `designed`.

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

- **2026-04-19 — uncommitted — initial draft**
  - **Why:** set the positioning contract before writing the MCP server. The Ollama 3-session run on the same date showed small-local-model tool-call drift collapsing `/memory` persistence; the fix isn't more prompt engineering, it's shipping the product on the wire format its users actually speak.
  - **Evidence:** [`examples/DEMO_RUNS.md` entry 2026-04-19](examples/DEMO_RUNS.md), [auto-memory `ollama_tool_calls.md`](.claude/projects/-Users-rayancastillazouine-Documents-Claude-Projects-DocsVFS/memory/ollama_tool_calls.md). All §3 tools start at `proposed`, all §4 channels at `not-started`, all §5 layers at `designed`.
