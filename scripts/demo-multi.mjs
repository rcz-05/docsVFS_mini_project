#!/usr/bin/env node
/**
 * demo-multi.mjs — orchestrator for the 3-session DocsVFS demo.
 *
 * Sequence:
 *   S1: GPU inventory — pin what GPU types exist + their quirks.
 *   (fake-age previous rows by 48h so janitor has something to flag)
 *   S2: SLURM how-to — should discover S1's notes via `ls /memory`.
 *   S3: Runbook synthesis — stitches S1+S2 into a plan.
 *   janitor --aggressive — prune expired + flag + delete stale.
 *
 * All three sessions share ~/.docsvfs-demo/db/shared.db.
 * Each session is an isolated child process running scripts/demo-agent.mjs.
 *
 * Usage:
 *   node scripts/demo-multi.mjs              # interactive, pauses between sessions
 *   node scripts/demo-multi.mjs --no-pause   # run straight through
 */
import { spawn } from "node:child_process";
import { createClient } from "@libsql/client";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import readline from "node:readline";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const HOME = os.homedir();
const STATE_ROOT = path.join(HOME, ".docsvfs-demo");
const DB_DIR = path.join(STATE_ROOT, "db");
const LOG_DIR = path.join(STATE_ROOT, "logs");
const SHARED_DB = path.join(DB_DIR, "shared.db");
const DOCS = arg("docs", path.join(HOME, "data-attribution-demo", "docs"));
const MODEL = arg("model", "llama3.1:8b");
const STEPS = arg("steps", "12");
const PAUSE = !flag("no-pause");

mkdirSync(DB_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// Clean shared DB + its wal/shm/journal so multi-run state is fresh
if (flag("fresh")) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const p = SHARED_DB + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  console.log(`[orch] cleaned shared DB: ${SHARED_DB}`);
}

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const SESSIONS = [
  {
    id: "S1",
    goal:
      "You are on the GT-PACE platform for the first time. Explore /docs to figure out which specific GPU models are available across the clusters (H100, A100, L40S, RTX, etc.) and which nodes/partitions they live on. For each GPU model you confirm from a specific file, call the `remember` tool so a future session can pick up where you left off. Cite filenames in your final answer.",
  },
  {
    id: "S2",
    goal:
      "A teammate is about to submit their first SLURM job on PACE. First run `ls /memory` to pick up anything the prior session wrote. Then explore /docs to find the SLURM submission workflow (sbatch, partitions, QoS) and the 3 most important gotchas. Use `remember` to pin each gotcha as its own note with a `note` field explaining why it matters. Cite filenames.",
  },
  {
    id: "S3",
    goal:
      "Act as the last session before a real run. Read `ls /memory` and `cat` the relevant prior notes. Using ONLY the facts already in /memory + specific lines you verify against /docs, produce a short runbook under topic 'pace-gpu-runbook' that tells a user: (1) which GPU to request for a 24-core job needing 40GB VRAM, (2) the sbatch flags, (3) the QoS caveat. Cite the source notes and docs.",
  },
];

function childAgent({ id, goal }) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `${id}.ndjson`);
    const args = [
      "scripts/demo-agent.mjs",
      "--session", id,
      "--docs", DOCS,
      "--db", SHARED_DB,
      "--log", logPath,
      "--steps", String(STEPS),
      "--model", MODEL,
      "--goal", goal,
    ];
    const child = spawn("node", args, { stdio: "inherit" });
    child.on("exit", (code) => resolve({ id, code, logPath }));
  });
}

async function fakeAge(dbPath, hours) {
  const client = createClient({ url: `file:${dbPath}` });
  const deltaMs = hours * 3_600_000;
  try {
    await client.execute({
      sql: `UPDATE nodes SET updated_at = updated_at - ?, created_at = created_at - ? WHERE mount != '/'`,
      args: [deltaMs, deltaMs],
    });
    const { rows } = await client.execute({ sql: `SELECT mount, path, updated_at FROM nodes WHERE path != '/' AND kind = 'file'` });
    console.log(dim(`  aged ${rows.length} row(s) back by ${hours}h`));
    for (const r of rows) console.log(dim(`    ${r.mount}${r.path}  → updated_at=${new Date(Number(r.updated_at)).toISOString()}`));
  } catch (err) {
    console.log(dim(`  (fake-age skipped: ${err.message})`));
  }
}

async function waitForEnter(msg) {
  if (!PAUSE) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((res) => rl.question(yellow(msg) + " ", () => { rl.close(); res(); }));
}

async function runJanitor() {
  return new Promise((resolve) => {
    const args = ["dist/cli/main.js", "janitor", DOCS, "--memory-db", `file:${SHARED_DB}`, "--aggressive"];
    console.log(dim(`  $ node ${args.join(" ")}`));
    const child = spawn("node", args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code));
  });
}

// ─── Run ─────────────────────────────────────────────────────────
console.log(cyan("\n═══ DocsVFS 3-session demo ═══"));
console.log(dim(`shared db: ${SHARED_DB}`));
console.log(dim(`docs:      ${DOCS}`));
console.log(dim(`model:     ${MODEL}`));
console.log(dim(`logs:      ${LOG_DIR}/S{1,2,3}.ndjson`));
console.log();

for (const [i, s] of SESSIONS.entries()) {
  await waitForEnter(`▶ press ENTER to start ${s.id}`);
  console.log(cyan(`\n━━━ ${s.id} ━━━`));
  const res = await childAgent(s);
  console.log(cyan(`━━━ ${s.id} exit=${res.code} log=${res.logPath} ━━━\n`));

  if (i === 0) {
    console.log(cyan(`→ aging S1's /memory rows by 48h (simulate time passing for janitor)`));
    await fakeAge(SHARED_DB, 48);
    console.log();
  }
}

await waitForEnter("▶ press ENTER to run janitor --aggressive");
console.log(cyan(`\n━━━ janitor --aggressive ━━━`));
await runJanitor();
console.log(cyan(`━━━ janitor done ━━━\n`));

console.log(bold(`✓ demo complete — see ${LOG_DIR}/ and watcher panes for state`));
