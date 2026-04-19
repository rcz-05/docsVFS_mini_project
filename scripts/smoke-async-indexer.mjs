/**
 * smoke-async-indexer.mjs — Phase 2.2 coverage.
 *
 * Uses a FakeSink (not a real Chroma) so the test is fully deterministic and
 * runs without any external dependency. A separate section tries to reach
 * Chroma at http://localhost:8000 and exercises end-to-end upsert/delete if
 * it's available — otherwise skips with a note.
 *
 * Seeds:
 *   - writeFile to /memory/*              → enqueued as 'upsert'
 *   - rm          /memory/*               → enqueued as 'delete'
 *   - writeFile then rm before drain     → upsert row finds missing file, treated as delete
 *   - intentional sink failure           → row stays in queue, attempts increments
 */

import { createClient } from "@libsql/client";
import { SCHEMA_SQL } from "../dist/memory/schema.js";
import { AsyncIndexer, IndexerHook } from "../dist/memory/async-indexer.js";
import { WritableFileSystem } from "../dist/memory/writable-fs.js";
import { FreshMap } from "../dist/memory/fresh-map.js";
import { rmSync, existsSync } from "node:fs";

const DB_PATH = "./.tmp-smoke-indexer.db";
const DB_URL  = `file:${DB_PATH}`;
if (existsSync(DB_PATH)) rmSync(DB_PATH);

let fails = 0;
const expect = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} — ${detail}`); fails++; }
};

// ─── Fake sink: records everything, optionally fails on demand ────
class FakeSink {
  constructor() {
    this.upserts = [];
    this.deletes = [];
    this.failNext = 0;
  }
  async upsertChunks(mount, path, content, source) {
    if (this.failNext > 0) { this.failNext--; throw new Error("simulated sink failure"); }
    this.upserts.push({ mount, path, content, source });
  }
  async deleteChunks(mount, path) {
    if (this.failNext > 0) { this.failNext--; throw new Error("simulated sink failure"); }
    this.deletes.push({ mount, path });
  }
}

async function initDb(client) {
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
}

// ─── Test 1: writes enqueue, drain pushes to sink ───────────────
{
  console.log("--- enqueue + drain ---");
  const client = createClient({ url: DB_URL });
  await initDb(client);
  const sink = new FakeSink();
  const indexer = new AsyncIndexer({ client, sink, pollMs: 1000, batchSize: 8 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();
  await wfs.mkdir("/notes");

  await wfs.writeFile("/notes/a.md", "content for A");
  await wfs.writeFile("/notes/b.md", "content for B");

  const q1 = await indexer.queueSize();
  expect("2 writes → 2 queue rows", q1 === 2, `got ${q1}`);

  const drained = await indexer.drainAll();
  expect("drainAll processed 2", drained === 2);
  expect("sink received 2 upserts", sink.upserts.length === 2, JSON.stringify(sink.upserts));
  expect("sink content matches", sink.upserts.some((u) => u.content === "content for A")
    && sink.upserts.some((u) => u.content === "content for B"));
  expect("upsert path is mount-relative", sink.upserts.every((u) => u.path.startsWith("/notes/")));
  expect("upsert mount=/memory", sink.upserts.every((u) => u.mount === "/memory"));
  expect("upsert source=agent", sink.upserts.every((u) => u.source === "agent"));
  expect("queue empty after drain", (await indexer.queueSize()) === 0);

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 2: rm → delete op ─────────────────────────────────────
{
  console.log("--- rm enqueues delete ---");
  const client = createClient({ url: DB_URL });
  await initDb(client);
  const sink = new FakeSink();
  const indexer = new AsyncIndexer({ client, sink, pollMs: 1000, batchSize: 8 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();

  await wfs.writeFile("/a.md", "hello");
  await indexer.drainAll();
  await wfs.rm("/a.md");

  expect("delete enqueued", (await indexer.queueSize()) === 1);
  await indexer.drainAll();
  expect("sink received 1 delete", sink.deletes.length === 1 && sink.deletes[0].path === "/a.md");

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 3: upsert for file that was removed before drain ──────
{
  console.log("--- upsert of missing row becomes delete ---");
  const client = createClient({ url: DB_URL });
  await initDb(client);
  const sink = new FakeSink();
  const indexer = new AsyncIndexer({ client, sink, pollMs: 1000, batchSize: 8 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();

  await wfs.writeFile("/vanish.md", "will be gone");
  // Manually strip the row, simulating a race where file deleted before indexer ran
  await client.execute({ sql: `DELETE FROM nodes WHERE mount=? AND path=?`, args: ["/memory", "/vanish.md"] });

  await indexer.drainAll();
  expect("upsert of missing file → delete dispatched", sink.deletes.some((d) => d.path === "/vanish.md"));
  expect("no upsert fired for missing file", sink.upserts.length === 0);

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 4: sink failure → attempts incremented, row stays ────
{
  console.log("--- failing sink retains row, increments attempts ---");
  const client = createClient({ url: DB_URL });
  await initDb(client);
  const sink = new FakeSink();
  sink.failNext = 2; // first two upserts fail, then succeed
  const indexer = new AsyncIndexer({ client, sink, pollMs: 1000, batchSize: 4 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();

  await wfs.writeFile("/retry.md", "hello");
  await indexer.drain();  // attempt #1 → fails

  const afterFirst = await client.execute(`SELECT attempts, last_error FROM index_queue WHERE path='/retry.md'`);
  expect("row stays after failure", afterFirst.rows.length === 1);
  expect("attempts bumped to 1", Number(afterFirst.rows[0].attempts) === 1);
  expect("last_error recorded", String(afterFirst.rows[0].last_error).includes("simulated"));

  await indexer.drain();  // attempt #2 → fails
  const afterSecond = await client.execute(`SELECT attempts FROM index_queue WHERE path='/retry.md'`);
  expect("attempts = 2", Number(afterSecond.rows[0].attempts) === 2);

  await indexer.drain();  // attempt #3 → success
  expect("row cleared after success", (await indexer.queueSize()) === 0);
  expect("sink eventually received 1 upsert", sink.upserts.length === 1);

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 5: janitor reports stuck rows (>=5 attempts) ────────
{
  console.log("--- janitor surfaces dead-letter rows ---");
  const { runJanitor } = await import("../dist/memory/janitor.js");
  const client = createClient({ url: DB_URL });
  await initDb(client);

  // Seed a stuck row directly
  await client.execute({
    sql: `INSERT INTO index_queue (mount, path, op, enqueued_at, attempts, last_error)
          VALUES (?, ?, 'upsert', ?, ?, ?)`,
    args: ["/memory", "/persistently-broken.md", Date.now(), 7, "upstream 500"],
  });
  const report = await runJanitor(client, { dryRun: true });
  expect("janitor reports stuck row", report.queueStuck.length === 1);
  expect("stuck attempt count correct", report.queueStuck[0].attempts === 7);
  expect("stuck last_error surfaced", report.queueStuck[0].lastError === "upstream 500");

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 6: start/stop lifecycle ───────────────────────────────
{
  console.log("--- start/stop lifecycle ---");
  const client = createClient({ url: DB_URL });
  await initDb(client);
  const sink = new FakeSink();
  const indexer = new AsyncIndexer({ client, sink, pollMs: 50, batchSize: 4 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();

  indexer.start();
  await wfs.writeFile("/bg.md", "background indexed");
  // Wait a couple poll cycles
  await new Promise((r) => setTimeout(r, 150));
  await indexer.stop();

  expect("background timer drained the queue", (await indexer.queueSize()) === 0);
  expect("sink saw the upsert from the background tick", sink.upserts.some((u) => u.path === "/bg.md"));

  client.close();
  rmSync(DB_PATH);
  console.log();
}

// ─── Test 7 (optional): real Chroma e2e ────────────────────────
console.log("--- real chroma e2e (skip if unavailable) ---");
try {
  const { ChromaSearchIndex } = await import("../dist/chroma/chroma-backend.js");
  const chroma = new ChromaSearchIndex("docsvfs_indexer_smoke_" + Date.now(), "http://localhost:8000");
  await chroma.init();

  const client = createClient({ url: DB_URL });
  await initDb(client);
  const indexer = new AsyncIndexer({ client, sink: chroma, pollMs: 1000, batchSize: 4 });
  const hook = new IndexerHook(client);
  const wfs = new WritableFileSystem({
    client, mount: "/memory", sessionId: "s1", fresh: new FreshMap(), indexer: hook,
  });
  await wfs.init();

  await wfs.writeFile("/chroma-test.md", "the word slurmish appears here and nowhere else");
  await indexer.drainAll();

  const hits = await chroma.coarseFilter("slurmish");
  expect("chroma indexed the writable content", hits.some((h) => h.includes("/chroma-test.md")), JSON.stringify(hits));

  // delete flow
  await wfs.rm("/chroma-test.md");
  await indexer.drainAll();
  const hitsAfter = await chroma.coarseFilter("slurmish");
  expect("chroma removed the chunks after rm",
    !hitsAfter.some((h) => h.includes("/chroma-test.md")),
    JSON.stringify(hitsAfter));

  client.close();
  rmSync(DB_PATH);
} catch (err) {
  console.log(`  (skipped — chroma not reachable: ${String(err.message || err).slice(0, 80)})`);
}

console.log(fails ? `\nFAILED (${fails})` : "\nOK");
if (fails) process.exitCode = 1;
