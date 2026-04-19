/**
 * smoke-remember.mjs — Phase 3 Option A `remember` tool coverage.
 *
 * Exercises:
 *   - slugifyTopic edge cases (spaces, case, unicode, symbols)
 *   - createRememberTool: basic overwrite
 *   - append mode concatenates
 *   - overwrite replaces (default)
 *   - provenance is tagged source="tool" and stores the optional note
 *   - return shape: { ok, path, bytes, mode }
 *   - throws when memory is not enabled
 *   - throws when mount isn't registered
 *   - custom mount (/workspace) works
 */

import { createDocsVFS, slugifyTopic, createRememberTool } from "../dist/index.js";
import { rmSync, existsSync } from "node:fs";

const DB = `./.tmp-smoke-remember-${Date.now()}.db`;
const DB_FILE = DB.replace(/^\.\//, "");
const DB_URL = `file:${DB}`;

let fails = 0;
const expect = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} — ${detail}`); fails++; }
};

// ─── slugifyTopic ────────────────────────────────────────────────
console.log("--- slugifyTopic ---");
{
  expect('"Slurm primer" → "slurm-primer"', slugifyTopic("Slurm primer") === "slurm-primer");
  expect('"API Keys" → "api-keys"', slugifyTopic("API Keys") === "api-keys");
  expect('"  Leading/Trailing  " trimmed', slugifyTopic("  Leading/Trailing  ") === "leading-trailing");
  expect('"!!! symbols @#$%" → "symbols"', slugifyTopic("!!! symbols @#$%") === "symbols");
  expect('empty string → "note"', slugifyTopic("") === "note");
  expect('only symbols → "note"', slugifyTopic("!@#$%^&*()") === "note");
  expect('long topic truncated', slugifyTopic("a".repeat(100)).length <= 60);
  expect('mixed unicode collapsed', slugifyTopic("Café Élégant") === "cafe-elegant");
  expect('consecutive spaces collapse', slugifyTopic("foo    bar") === "foo-bar");
  expect('dashes preserved', slugifyTopic("foo-bar-baz") === "foo-bar-baz");
}

// ─── createRememberTool: setup ───────────────────────────────────
console.log("\n--- createRememberTool setup ---");
{
  const vfsNoMem = await createDocsVFS({ rootDir: "./demo-docs", noCache: true });
  let threw = false;
  try { createRememberTool({ vfs: vfsNoMem }); } catch { threw = true; }
  expect("throws when memory disabled", threw);
  await vfsNoMem.close();
}

// ─── createRememberTool: live writes ─────────────────────────────
const vfs = await createDocsVFS({
  rootDir: "./demo-docs",
  noCache: true,
  memory: true,
  memoryDbUrl: DB_URL,
});
console.log(`\n--- createRememberTool live (boot ${vfs.stats.bootTimeMs}ms) ---`);

const remember = createRememberTool({ vfs });

// Tool shape
{
  expect("description is a non-empty string", typeof remember.description === "string" && remember.description.length > 0);
  expect("parameters.required includes topic, content", remember.parameters.required.includes("topic") && remember.parameters.required.includes("content"));
  expect("parameters has topic, content, append, note", ["topic","content","append","note"].every((k) => k in remember.parameters.properties));
  expect("execute is a function", typeof remember.execute === "function");
}

// Basic write
{
  const res = await remember.execute({
    topic: "Slurm primer",
    content: "GPU jobs run via sbatch.\n",
  });
  expect("ok=true", res.ok === true);
  expect('path = "/memory/slurm-primer.md"', res.path === "/memory/slurm-primer.md", res.path);
  expect("bytes > 0", res.bytes > 0);
  expect('mode = "overwrite"', res.mode === "overwrite");

  // Round-trip via bash
  const read = await vfs.exec("cat /memory/slurm-primer.md");
  expect("content readable via bash", read.stdout === "GPU jobs run via sbatch.\n", JSON.stringify(read.stdout));
}

// Overwrite
{
  const res = await remember.execute({
    topic: "Slurm primer",
    content: "Overwritten.\n",
  });
  expect('overwrite mode = "overwrite"', res.mode === "overwrite");
  const read = await vfs.exec("cat /memory/slurm-primer.md");
  expect("overwrite replaced content entirely", read.stdout === "Overwritten.\n", JSON.stringify(read.stdout));
}

// Append
{
  const res = await remember.execute({
    topic: "Slurm primer",
    content: "Plus a second paragraph.\n",
    append: true,
  });
  expect('append mode = "append"', res.mode === "append");
  const read = await vfs.exec("cat /memory/slurm-primer.md");
  expect("append concatenates", read.stdout === "Overwritten.\nPlus a second paragraph.\n", JSON.stringify(read.stdout));
}

// Note in provenance
{
  await remember.execute({
    topic: "Provenance test",
    content: "body\n",
    note: "from user query X",
  });
  const row = await vfs.memory.client.execute({
    sql: `SELECT provenance FROM nodes WHERE mount = ? AND path = ?`,
    args: ["/memory", "/provenance-test.md"],
  });
  const prov = JSON.parse(row.rows[0].provenance);
  expect('source = "tool"', prov.source === "tool", JSON.stringify(prov));
  expect("note preserved", prov.note === "from user query X", JSON.stringify(prov));
  expect("session_id present", typeof prov.session_id === "string" && prov.session_id.length > 0);
}

// Source tag without note
{
  await remember.execute({ topic: "No note here", content: "x\n" });
  const row = await vfs.memory.client.execute({
    sql: `SELECT provenance FROM nodes WHERE mount = ? AND path = ?`,
    args: ["/memory", "/no-note-here.md"],
  });
  const prov = JSON.parse(row.rows[0].provenance);
  expect('source = "tool" without note', prov.source === "tool");
  expect("no note key when not supplied", !("note" in prov), JSON.stringify(prov));
}

// Empty topic → "note"
{
  const res = await remember.execute({ topic: "", content: "fallback body\n" });
  expect('empty topic → /memory/note.md', res.path === "/memory/note.md", res.path);
}

// Custom mount (/workspace)
{
  const wsRemember = createRememberTool({ vfs, mount: "/workspace" });
  const res = await wsRemember.execute({
    topic: "Scratch tally",
    content: "temp\n",
  });
  expect('workspace mount path', res.path === "/workspace/scratch-tally.md", res.path);
  const read = await vfs.exec("cat /workspace/scratch-tally.md");
  expect("workspace note readable", read.stdout === "temp\n");
}

// Unknown mount
{
  let threw = false;
  try { createRememberTool({ vfs, mount: "/nonexistent" }); } catch { threw = true; }
  expect("throws on unknown mount", threw);
}

// Interop: remembered files show up via ls + grep
{
  const ls = await vfs.exec("ls /memory");
  expect("ls lists remembered notes", ls.stdout.includes("slurm-primer.md") && ls.stdout.includes("provenance-test.md"), ls.stdout);

  // Write a known marker, then grep for it
  await remember.execute({ topic: "marker doc", content: "REMEMBER_MARKER_TOKEN line\n" });
  const grep = await vfs.exec('grep -r "REMEMBER_MARKER_TOKEN" /memory');
  expect("grep finds tool-written content", grep.stdout.includes("REMEMBER_MARKER_TOKEN"), grep.stdout);
}

await vfs.close();

// Clean up temp DB files
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const p = DB_FILE + suffix;
  if (existsSync(p)) rmSync(p, { force: true });
}

console.log(`\n${fails === 0 ? "✅ all green" : `❌ ${fails} failing`}\n`);
process.exit(fails === 0 ? 0 : 1);
