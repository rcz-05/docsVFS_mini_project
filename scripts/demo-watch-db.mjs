#!/usr/bin/env node
/**
 * demo-watch-db.mjs — tmux pane 3: watch provenance + index_queue live.
 *
 * SQL-level view of the writable layer:
 *   - nodes:        path, session_id, source, bytes, age
 *   - index_queue:  pending embedding tasks with attempts
 *   - summary:      counts by mount × source
 *
 * Usage:
 *   node scripts/demo-watch-db.mjs --db ~/.docsvfs-demo/db/shared.db
 */
import { createClient } from "@libsql/client";
import * as path from "node:path";
import * as os from "node:os";

const REFRESH_MS = 1000;

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const DB = expandHome(arg("db", "~/.docsvfs-demo/db/shared.db"));

const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function fmtAge(tsMs) {
  const ms = Date.now() - Number(tsMs);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function decodeLen(content) {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (Array.isArray(content)) return content.length;
  if (content && typeof content.length === "number") return content.length;
  return 0;
}

async function tick(client) {
  let nodes, queue, tablesExist = true;
  try {
    const res = await client.execute({
      sql: `SELECT mount, path, content, provenance, updated_at, ttl_expires_at AS expires_at FROM nodes
            WHERE path != '/' AND kind = 'file'
            ORDER BY mount, path`,
      args: [],
    });
    nodes = res.rows;
    try {
      const q = await client.execute({
        sql: `SELECT mount, path, attempts, last_error, created_at FROM index_queue ORDER BY created_at DESC LIMIT 10`,
        args: [],
      });
      queue = q.rows;
    } catch {
      queue = null;
    }
  } catch (err) {
    tablesExist = false;
  }

  clear();
  console.log(cyan(`[watch-db]`) + " " + dim(new Date().toLocaleTimeString()));
  console.log(dim(`db: ${DB}`));
  console.log();
  if (!tablesExist) {
    console.log(dim(`(db not initialized yet — waiting for first session…)`));
    return;
  }

  console.log(bold(`nodes (${nodes.length} files)`));
  if (nodes.length === 0) {
    console.log(dim(`  (empty)`));
  } else {
    console.log(dim(`  mount      path                           bytes   src     session      age      ttl`));
    for (const r of nodes) {
      const mount = String(r.mount).padEnd(10);
      const p = String(r.path).padEnd(30).slice(0, 30);
      const bytes = String(decodeLen(r.content)).padStart(6);
      const prov = (() => { try { return JSON.parse(String(r.provenance ?? "{}")); } catch { return {}; } })();
      const src = String(prov.source ?? "?").padEnd(7);
      const colourSrc = src.trim() === "tool" ? green(src) : src.trim() === "agent" ? yellow(src) : src;
      const sess = String(prov.session_id ?? "").padEnd(12).slice(0, 12);
      const age = fmtAge(r.updated_at).padStart(7);
      const ttl = r.expires_at ? fmtAge(r.expires_at).padStart(6) : dim("  —  ");
      console.log(`  ${mount} ${p} ${bytes}  ${colourSrc} ${sess} ${age}   ${ttl}`);
    }
  }
  console.log();

  if (queue) {
    console.log(bold(`index_queue (${queue.length} recent)`));
    if (queue.length === 0) {
      console.log(dim(`  (empty — all indexed or chroma off)`));
    } else {
      for (const r of queue) {
        const att = Number(r.attempts);
        const attStr = att >= 5 ? red(`${att}x`) : att > 0 ? yellow(`${att}x`) : `${att}x`;
        const err = r.last_error ? red(` err=${String(r.last_error).slice(0, 40)}`) : "";
        console.log(`  ${r.mount}${r.path}  ${attStr}${err}`);
      }
    }
    console.log();
  }

  const bySource = new Map();
  for (const r of nodes) {
    const prov = (() => { try { return JSON.parse(String(r.provenance ?? "{}")); } catch { return {}; } })();
    const k = `${r.mount}/${prov.source ?? "?"}`;
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  console.log(bold(`summary`));
  if (bySource.size === 0) console.log(dim(`  (nothing yet)`));
  for (const [k, v] of [...bySource.entries()].sort()) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
}

const client = createClient({ url: `file:${DB}` });
await tick(client);
setInterval(() => { tick(client).catch(() => {}); }, REFRESH_MS);
