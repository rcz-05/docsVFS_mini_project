#!/usr/bin/env node
/**
 * demo-watch-memory.mjs — tmux pane 2: watch /memory live.
 *
 * Re-reads the writable layer directly from the shared SQLite DB every
 * REFRESH_MS and prints:
 *   - ls /memory
 *   - first 20 lines of each file, prefixed with the path
 *
 * This does NOT boot a DocsVFS. It reads directly via SQL so multiple
 * sessions hitting the DB stay visible even if writers churn.
 *
 * Usage:
 *   node scripts/demo-watch-memory.mjs --db ~/.docsvfs-demo/db/shared.db
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
const MOUNT = arg("mount", "/memory");
const MAX_LINES = parseInt(arg("lines", "20"), 10);

const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function decodeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (content instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(content));
  if (ArrayBuffer.isView(content)) return new TextDecoder().decode(content);
  if (Array.isArray(content)) return new TextDecoder().decode(new Uint8Array(content));
  if (content && typeof content === "object" && typeof content.length === "number") {
    return new TextDecoder().decode(new Uint8Array(content));
  }
  return String(content);
}

async function tick(client) {
  let rows;
  try {
    const res = await client.execute({
      sql: `SELECT path, content, provenance, updated_at FROM nodes
            WHERE mount = ? AND path != '/' AND kind = 'file'
            ORDER BY path`,
      args: [MOUNT],
    });
    rows = res.rows;
  } catch (err) {
    clear();
    console.log(cyan(`[watch-memory ${MOUNT}]`) + " " + dim(new Date().toLocaleTimeString()));
    console.log(dim(`db: ${DB}`));
    console.log(`\n${dim(`(db error: ${err.message} — retrying)`)}\n`);
    return;
  }
  clear();
  console.log(cyan(`[watch-memory ${MOUNT}]`) + " " + dim(new Date().toLocaleTimeString()));
  console.log(dim(`db: ${DB}`));
  console.log();
  if (rows.length === 0) {
    console.log(dim(`${MOUNT} is empty`));
    return;
  }
  console.log(bold(`ls ${MOUNT}  (${rows.length} files)`));
  for (const r of rows) {
    const p = String(r.path);
    const bytes = decodeContent(r.content).length;
    const prov = (() => { try { return JSON.parse(String(r.provenance ?? "{}")); } catch { return {}; } })();
    const src = prov.source ?? "?";
    const sess = prov.session_id ?? "";
    console.log(`  ${p}  ${dim(`(${bytes}B, ${src}${sess ? `, ${sess}` : ""})`)}`);
  }
  console.log();
  for (const r of rows) {
    const p = String(r.path);
    const body = decodeContent(r.content);
    const lines = body.split("\n").slice(0, MAX_LINES);
    console.log(green(`── ${MOUNT}${p} ──`));
    for (const line of lines) console.log(`  ${line}`);
    if (body.split("\n").length > MAX_LINES) console.log(dim(`  … (truncated)`));
    console.log();
  }
}

const client = createClient({ url: `file:${DB}` });
await tick(client);
setInterval(() => { tick(client).catch(() => {}); }, REFRESH_MS);
