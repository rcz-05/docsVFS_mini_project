#!/usr/bin/env node
/**
 * mcp-smoke.mjs — JSON-RPC smoke test for docsvfs-mcp.
 *
 * Spawns the server over stdio, runs initialize → tools/list → tools/call
 * for each of the 4 tools, asserts that responses match the shapes locked
 * in MCP_TOOL_SCHEMAS.md. Runs twice:
 *   1. with --memory → expects all 4 tools including remember
 *   2. without --memory → expects 3 tools (docs/density/stats), no remember
 *
 * Exits non-zero and prints a diff-style summary if anything fails.
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const BIN = path.join(repoRoot, "dist/mcp/bin.js");
const DEMO_DOCS = path.join(repoRoot, "demo-docs");
const SMOKE_DB = "/tmp/docsvfs-smoke.db";

const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const failures = [];

function fail(msg, detail) {
  failures.push({ msg, detail });
  console.error(colors.red(`  ✗ ${msg}`));
  if (detail) console.error(colors.dim(`    ${detail}`));
}

function pass(msg) {
  console.error(colors.green(`  ✓ ${msg}`));
}

function assert(cond, msg, detail) {
  if (cond) pass(msg);
  else fail(msg, detail);
}

// ─── JSON-RPC client over stdio ──────────────────────────────────────────────

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
  }
  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.error(colors.red(`smoke: bad JSON-RPC frame: ${line}`));
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  }
  async send(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    const pending = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(JSON.stringify(msg) + "\n");
    return pending;
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  close() {
    this.child.stdin.end();
  }
}

// ─── test runs ───────────────────────────────────────────────────────────────

async function runScenario(label, serverArgs, expectRemember) {
  console.error(colors.bold(`\n[${label}]`));
  console.error(colors.dim(`  args: ${serverArgs.join(" ")}`));

  const child = spawn("node", [BIN, ...serverArgs], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrLines = [];
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderrLines.push(chunk);
  });

  const client = new StdioClient(child);

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    // 1. initialize
    const init = await client.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "0.0.1" },
    });
    assert(init?.serverInfo?.name === "docsvfs", "initialize.serverInfo.name=docsvfs", JSON.stringify(init?.serverInfo));
    assert(init?.capabilities?.tools != null, "capabilities.tools declared", JSON.stringify(init?.capabilities));
    client.notify("notifications/initialized", {});

    // 2. tools/list
    const listed = await client.send("tools/list", {});
    const names = (listed?.tools ?? []).map((t) => t.name).sort();
    const expected = expectRemember
      ? ["density", "docs", "remember", "stats"]
      : ["density", "docs", "stats"];
    assert(
      JSON.stringify(names) === JSON.stringify(expected),
      `tools/list returns ${expected.length} tools: ${expected.join(", ")}`,
      `got: ${names.join(", ")}`
    );

    // 3. docs
    const docsRes = await client.send("tools/call", {
      name: "docs",
      arguments: { command: "tree / -L 2" },
    });
    assert(docsRes?.isError === false, "docs tree/ -L 2 → isError=false", JSON.stringify(docsRes).slice(0, 200));
    assert(
      typeof docsRes?.content?.[0]?.text === "string" && docsRes.content[0].text.length > 0,
      "docs response has non-empty text content"
    );

    // 3b. docs with non-zero exit — should still be isError:false
    const missRes = await client.send("tools/call", {
      name: "docs",
      arguments: { command: "cat /does-not-exist" },
    });
    assert(missRes?.isError === false, "docs failed cat → isError stays false (agent-recoverable)");

    // 4. remember (only if memory)
    if (expectRemember) {
      const rememberRes = await client.send("tools/call", {
        name: "remember",
        arguments: {
          topic: "smoke test topic",
          content: "# smoke\nThis note was written by mcp-smoke.mjs",
          note: "smoke-harness",
        },
      });
      assert(rememberRes?.isError === false, "remember → isError=false");
      assert(
        rememberRes?.structuredContent?.ok === true,
        "remember has structuredContent.ok=true",
        JSON.stringify(rememberRes?.structuredContent)
      );
      assert(
        rememberRes?.structuredContent?.path === "/memory/smoke-test-topic.md",
        "remember slug collapses to smoke-test-topic.md"
      );
      assert(rememberRes?.structuredContent?.mode === "overwrite", "remember default mode = overwrite");

      // confirm via docs cat
      const catRes = await client.send("tools/call", {
        name: "docs",
        arguments: { command: "cat /memory/smoke-test-topic.md" },
      });
      assert(
        catRes?.content?.[0]?.text?.includes("smoke"),
        "docs can cat the remembered note back"
      );
    }

    // 5. density — MCP always mounts docs at /docs regardless of --memory
    const densityRes = await client.send("tools/call", {
      name: "density",
      arguments: { path: "/docs", term: "API" },
    });
    assert(densityRes?.isError === false, "density /docs 'API' → isError=false");
    assert(
      densityRes?.structuredContent?.term === "API",
      "density.structuredContent.term preserved"
    );
    assert(
      Array.isArray(densityRes?.structuredContent?.rows),
      "density returns rows[]"
    );

    // 6. stats
    const statsRes = await client.send("tools/call", {
      name: "stats",
      arguments: {},
    });
    assert(statsRes?.isError === false, "stats → isError=false");
    const mounts = statsRes?.structuredContent?.mounts ?? [];
    const expectedMountCount = expectRemember ? 3 : 1;
    assert(
      mounts.length === expectedMountCount,
      `stats returns ${expectedMountCount} mount(s)`,
      `got: ${mounts.map((m) => m.mount).join(",")}`
    );
    const docsMount = mounts.find((m) => m.mount === "/docs");
    assert(docsMount?.writable === false, "/docs mount is read-only");
    assert(typeof docsMount?.fileCount === "number" && docsMount.fileCount > 0, "/docs has files");

    if (expectRemember) {
      const memMount = mounts.find((m) => m.mount === "/memory");
      assert(memMount?.writable === true, "/memory mount is writable");
      assert(memMount?.fileCount >= 1, "/memory reflects the remember() write");
    }

    // 7. stats with filter
    const filteredStats = await client.send("tools/call", {
      name: "stats",
      arguments: { mount: "/docs" },
    });
    assert(filteredStats?.isError === false, "stats mount=/docs → isError=false");
    assert(
      filteredStats?.structuredContent?.mounts?.length === 1,
      "stats with mount filter returns exactly 1 mount"
    );

    // 8. invalid mount filter — without --memory, /memory should error
    if (!expectRemember) {
      const badStats = await client.send("tools/call", {
        name: "stats",
        arguments: { mount: "/memory" },
      });
      assert(badStats?.isError === true, "stats mount=/memory (no memory) → isError=true");
    }
  } finally {
    client.close();
    const { code } = await exited;
    if (process.env.DEBUG_SMOKE) {
      console.error(colors.dim(`\n--- stderr ---`));
      console.error(colors.dim(stderrLines.join("")));
      console.error(colors.dim(`--- exit code: ${code} ---`));
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(BIN)) {
    console.error(colors.red(`smoke: ${BIN} not found — run \`npm run build\` first`));
    process.exit(2);
  }

  // fresh DB per run
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const p = SMOKE_DB + suffix;
    if (existsSync(p)) rmSync(p);
  }

  await runScenario(
    "with --memory",
    [DEMO_DOCS, "--memory", "--memory-db", `file:${SMOKE_DB}`, "--no-cache"],
    true
  );
  await runScenario("read-only (no --memory)", [DEMO_DOCS, "--no-cache"], false);

  console.error("");
  if (failures.length === 0) {
    console.error(colors.green(colors.bold(`✓ smoke passed (${failures.length} failures)`)));
    process.exit(0);
  } else {
    console.error(colors.red(colors.bold(`✗ smoke failed (${failures.length} failures)`)));
    for (const f of failures) console.error(colors.red(`  - ${f.msg}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(colors.red(`smoke: fatal: ${err?.stack ?? err}`));
  process.exit(1);
});
