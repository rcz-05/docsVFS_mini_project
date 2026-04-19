/**
 * smoke-janitor.mjs — End-to-end check for Phase 2.1 janitor.
 *
 * Seeds a throwaway DB directly via libSQL (so we can set arbitrary
 * timestamps + provenance), then exercises:
 *   - --dry-run (reports but changes nothing)
 *   - default (prune + dedup + flag + VACUUM)
 *   - --aggressive (also deletes flagged stale agent-only writes)
 *
 * Fixtures:
 *   /workspace: 2 expired rows (ttl < now), 1 live row
 *   /memory:    2 pairs of exact duplicates (same content, different paths)
 *               1 stale agent-only note (>24h, source=agent, created=updated)
 *               1 fresh agent-only note (<24h)
 *               1 old human-sourced note (should NOT be flagged)
 */

import { createClient } from "@libsql/client";
import { SCHEMA_SQL } from "../dist/memory/schema.js";
import { runJanitor, formatJanitorReport } from "../dist/memory/janitor.js";
import { rmSync, existsSync } from "node:fs";

const DB_PATH = "./.tmp-smoke-janitor.db";
const DB_URL  = `file:${DB_PATH}`;
if (existsSync(DB_PATH)) rmSync(DB_PATH);

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let fails = 0;
const expect = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} — ${detail}`); fails++; }
};

async function seed(client) {
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  // Seed directory rows so the file-rows don't orphan (cosmetic, janitor ignores dirs).
  const dirRow = (mount, path, parent, name) => ({
    sql: `INSERT INTO nodes (mount, path, parent, name, kind, content, size, mode,
                             provenance, created_at, updated_at, ttl_expires_at)
          VALUES (?, ?, ?, ?, 'dir', NULL, 0, 493, NULL, ?, ?, NULL)`,
    args: [mount, path, parent, name, now, now],
  });
  await client.execute(dirRow("/memory", "/", "", ""));
  await client.execute(dirRow("/workspace", "/", "", ""));

  const fileRow = ({ mount, path, content, created, updated, ttl, provenance }) => ({
    sql: `INSERT INTO nodes (mount, path, parent, name, kind, content, size, mode,
                             provenance, created_at, updated_at, ttl_expires_at)
          VALUES (?, ?, ?, ?, 'file', ?, ?, 420, ?, ?, ?, ?)`,
    args: [
      mount, path, "/", path.slice(1),
      new Uint8Array(Buffer.from(content)),
      content.length,
      provenance ? JSON.stringify(provenance) : null,
      created, updated, ttl,
    ],
  });

  // /workspace: 2 expired, 1 live
  await client.execute(fileRow({
    mount: "/workspace", path: "/expired-a.md", content: "gone",
    created: now - 2 * DAY, updated: now - 2 * DAY,
    ttl: now - HOUR,
    provenance: { session_id: "s1", source: "agent" },
  }));
  await client.execute(fileRow({
    mount: "/workspace", path: "/expired-b.md", content: "also gone",
    created: now - 3 * DAY, updated: now - 3 * DAY,
    ttl: now - 5 * HOUR,
    provenance: { session_id: "s1", source: "agent" },
  }));
  await client.execute(fileRow({
    mount: "/workspace", path: "/alive.md", content: "still here",
    created: now - HOUR, updated: now - HOUR,
    ttl: now + DAY,
    provenance: { session_id: "s1", source: "agent" },
  }));

  // /memory: 2 duplicate pairs (same content)
  const dupA = "exactly the same content A";
  await client.execute(fileRow({
    mount: "/memory", path: "/dup-a-keep.md", content: dupA,
    created: now - 10 * HOUR, updated: now - 10 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));
  await client.execute(fileRow({
    mount: "/memory", path: "/dup-a-later.md", content: dupA,
    created: now - 5 * HOUR, updated: now - 5 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));

  const dupB = "exactly the same content B";
  await client.execute(fileRow({
    mount: "/memory", path: "/dup-b-keep.md", content: dupB,
    created: now - 20 * HOUR, updated: now - 20 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "human" },
  }));
  await client.execute(fileRow({
    mount: "/memory", path: "/dup-b-1.md", content: dupB,
    created: now - 15 * HOUR, updated: now - 15 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));
  await client.execute(fileRow({
    mount: "/memory", path: "/dup-b-2.md", content: dupB,
    created: now - 10 * HOUR, updated: now - 10 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));

  // /memory: stale agent-only (>24h, created === updated, source=agent)
  await client.execute(fileRow({
    mount: "/memory", path: "/stale-note.md", content: "i hallucinated a crossref",
    created: now - 2 * DAY, updated: now - 2 * DAY, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));

  // /memory: fresh agent-only (<24h — should NOT be flagged)
  await client.execute(fileRow({
    mount: "/memory", path: "/fresh-note.md", content: "new idea",
    created: now - 2 * HOUR, updated: now - 2 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));

  // /memory: old human-sourced (>24h — should NOT be flagged because source=human)
  await client.execute(fileRow({
    mount: "/memory", path: "/human-note.md", content: "i verified this myself",
    created: now - 3 * DAY, updated: now - 3 * DAY, ttl: null,
    provenance: { session_id: "s1", source: "human" },
  }));

  // /memory: old agent note that has been touched since (created < updated — NOT stale)
  await client.execute(fileRow({
    mount: "/memory", path: "/revisited.md", content: "revisited and confirmed",
    created: now - 3 * DAY, updated: now - 3 * HOUR, ttl: null,
    provenance: { session_id: "s1", source: "agent" },
  }));
}

async function rowCount(client, where = "1=1", args = []) {
  const r = await client.execute({
    sql: `SELECT COUNT(*) as n FROM nodes WHERE kind='file' AND ${where}`,
    args,
  });
  return Number(r.rows[0].n);
}

// ─── Test 1: --dry-run ─────────────────────────────────────────
{
  console.log("--- dry-run ---");
  const client = createClient({ url: DB_URL });
  await seed(client);
  const before = await rowCount(client);
  const report = await runJanitor(client, { dryRun: true, now });
  const after  = await rowCount(client);

  console.log(formatJanitorReport(report));
  expect("dry-run reports 2 expired", report.prunedExpired.length === 2, JSON.stringify(report.prunedExpired));
  expect("dry-run reports 2 dedup groups", report.deduped.length === 2, JSON.stringify(report.deduped));
  const totalDropped = report.deduped.reduce((n, d) => n + d.removedPaths.length, 0);
  expect("dry-run reports 3 files to merge (1+2)", totalDropped === 3, `got ${totalDropped}`);
  expect("dry-run reports 1 stale flagged", report.flaggedStale.length === 1, JSON.stringify(report.flaggedStale));
  expect("dry-run flagged not deleted", report.flaggedStale.every((f) => !f.deleted));
  expect("dry-run did not change the DB", before === after, `before=${before} after=${after}`);
  expect("dry-run did NOT vacuum", report.vacuumed === false);
  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 2: default (compact) ─────────────────────────────────
{
  console.log("--- default run ---");
  const client = createClient({ url: DB_URL });
  await seed(client);
  const before = await rowCount(client);
  const report = await runJanitor(client, { now });
  const after  = await rowCount(client);

  console.log(formatJanitorReport(report));
  expect("expired rows deleted (-2)", await rowCount(client, "mount='/workspace' AND path LIKE '/expired-%'") === 0);
  expect("alive workspace row kept", await rowCount(client, "mount='/workspace' AND path='/alive.md'") === 1);
  expect("dedup dropped 3 rows", before - after === 2 + 3, `delta=${before - after}`);
  expect("dup-a oldest kept", await rowCount(client, "mount='/memory' AND path='/dup-a-keep.md'") === 1);
  expect("dup-a later removed", await rowCount(client, "mount='/memory' AND path='/dup-a-later.md'") === 0);
  expect("dup-b oldest kept", await rowCount(client, "mount='/memory' AND path='/dup-b-keep.md'") === 1);
  expect("dup-b dupes removed",
    await rowCount(client, "mount='/memory' AND path IN ('/dup-b-1.md','/dup-b-2.md')") === 0);
  expect("stale agent flagged (not deleted)", report.flaggedStale.length === 1 && report.flaggedStale[0].deleted === false);
  expect("stale-note still present", await rowCount(client, "mount='/memory' AND path='/stale-note.md'") === 1);
  expect("human note not flagged",
    !report.flaggedStale.some((f) => f.path === "/human-note.md"));
  expect("revisited not flagged",
    !report.flaggedStale.some((f) => f.path === "/revisited.md"));
  expect("fresh note not flagged",
    !report.flaggedStale.some((f) => f.path === "/fresh-note.md"));
  expect("VACUUM ran", report.vacuumed === true);
  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 3: --aggressive ──────────────────────────────────────
{
  console.log("--- aggressive ---");
  const client = createClient({ url: DB_URL });
  await seed(client);
  const report = await runJanitor(client, { aggressive: true, now });

  console.log(formatJanitorReport(report));
  expect("stale flagged AND deleted", report.flaggedStale.length === 1 && report.flaggedStale[0].deleted === true);
  expect("stale-note removed from DB",
    await rowCount(client, "mount='/memory' AND path='/stale-note.md'") === 0);
  expect("human note preserved",
    await rowCount(client, "mount='/memory' AND path='/human-note.md'") === 1);
  expect("revisited preserved (updated_at > created_at)",
    await rowCount(client, "mount='/memory' AND path='/revisited.md'") === 1);
  expect("fresh agent note preserved",
    await rowCount(client, "mount='/memory' AND path='/fresh-note.md'") === 1);
  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 4: older-than-days override ──────────────────────────
{
  console.log("--- older-than-days 7 (nothing stale) ---");
  const client = createClient({ url: DB_URL });
  await seed(client);
  const report = await runJanitor(client, { olderThanMs: 7 * DAY, now });

  expect("no stale flagged with 7-day threshold", report.flaggedStale.length === 0);
  expect("expired still pruned (TTL is separate)", report.prunedExpired.length === 2);
  expect("dedup still runs", report.deduped.length === 2);
  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 5: mounts filter ─────────────────────────────────────
{
  console.log("--- mounts=['/workspace'] filter ---");
  const client = createClient({ url: DB_URL });
  await seed(client);
  const report = await runJanitor(client, { mounts: ["/workspace"], now });

  expect("only /workspace expired pruned", report.prunedExpired.length === 2 && report.prunedExpired.every((e) => e.mount === "/workspace"));
  expect("no /memory dedup when filtered to /workspace", report.deduped.length === 0);
  expect("no /memory stale when filtered to /workspace", report.flaggedStale.length === 0);
  expect("/memory dup files still present",
    await rowCount(client, "mount='/memory'") >= 8);
  client.close();
  rmSync(DB_PATH);
  console.log();
}

console.log(fails ? `\nFAILED (${fails})` : "\nOK");
if (fails) process.exitCode = 1;
