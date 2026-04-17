/**
 * smoke-memory.mjs — quick end-to-end check for the writable layer.
 *
 * - Boots DocsVFS with memory enabled against demo-docs
 * - Writes, appends, reads, lists, and deletes under /memory/ and /workspace/
 * - Confirms /docs/ is still read-only (EROFS)
 */

import { createDocsVFS } from "../dist/index.js";
import { rmSync, existsSync } from "node:fs";

const DB = "./demo-docs/.docsvfs.db";
if (existsSync(DB)) rmSync(DB);

const vfs = await createDocsVFS({
  rootDir: "./demo-docs",
  memory: true,
  noCache: true,
});

const expect = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label} — ${detail}`); process.exitCode = 1; }
};

console.log(`Boot: ${vfs.stats.bootTimeMs}ms, mounts=${vfs.stats.memoryMounts?.join(",")}\n`);

console.log("Mounts visible at /");
const rootLs = await vfs.exec("ls /");
console.log(rootLs.stdout);
expect("ls / lists docs/memory/workspace", /docs/.test(rootLs.stdout) && /memory/.test(rootLs.stdout) && /workspace/.test(rootLs.stdout), rootLs.stdout);

console.log("\nWrite + read under /memory");
const w1 = await vfs.exec('echo "hello world" > /memory/note.md');
expect("write to /memory succeeds", w1.exitCode === 0, w1.stderr);

const r1 = await vfs.exec("cat /memory/note.md");
expect("read-your-writes returns content", r1.stdout.includes("hello world"), r1.stdout);

console.log("\nAppend");
await vfs.exec('echo "line 2" >> /memory/note.md');
const r2 = await vfs.exec("cat /memory/note.md");
expect("append persists both lines", r2.stdout.includes("hello world") && r2.stdout.includes("line 2"), r2.stdout);

console.log("\nmkdir + nested write");
const m1 = await vfs.exec("mkdir /memory/notes");
expect("mkdir ok", m1.exitCode === 0, m1.stderr);
const w2 = await vfs.exec('echo "nested" > /memory/notes/a.md');
expect("nested write ok", w2.exitCode === 0, w2.stderr);
const ls1 = await vfs.exec("ls /memory/notes");
expect("nested file appears in ls", ls1.stdout.includes("a.md"), ls1.stdout);

console.log("\nWorkspace mount (TTL 24h)");
const w3 = await vfs.exec('echo "scratch" > /workspace/tmp.md');
expect("write to /workspace ok", w3.exitCode === 0, w3.stderr);

console.log("\n/docs still read-only");
const wErr = await vfs.exec('echo "hack" > /docs/test.txt');
expect("EROFS on /docs write", /EROFS|read-only|write/i.test(wErr.stderr) || wErr.exitCode !== 0, wErr.stderr || "no error");

console.log("\nDelete");
const rm = await vfs.exec("rm /memory/note.md");
expect("rm ok", rm.exitCode === 0, rm.stderr);
const r3 = await vfs.exec("cat /memory/note.md");
expect("deleted file not readable", r3.exitCode !== 0, r3.stdout);

console.log("\nPersistence across instances");
await vfs.close();
const vfs2 = await createDocsVFS({ rootDir: "./demo-docs", memory: true, noCache: true });
const r4 = await vfs2.exec("cat /memory/notes/a.md");
expect("nested file survives reboot", r4.stdout.includes("nested"), r4.stdout);
await vfs2.close();

console.log(process.exitCode ? "\nFAILED" : "\nOK");
