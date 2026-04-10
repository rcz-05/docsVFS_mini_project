/**
 * Programmatic usage of DocsVFS — what we actually tested.
 *
 * This example mirrors the real benchmark we ran against 28 documentation
 * files from the data-attribution project. Run with:
 *   npx tsx examples/programmatic-usage.ts
 */
import { createDocsVFS } from "docsvfs";

const vfs = await createDocsVFS({ rootDir: "./demo-docs" });

console.log(`Booted in ${vfs.stats.bootTimeMs}ms`);
console.log(`${vfs.stats.fileCount} files, ${vfs.stats.dirCount} dirs, ${vfs.stats.chunkCount} chunks\n`);

// 1. See the full structure instantly
const tree = await vfs.exec("tree / -L 2");
console.log(tree.stdout);

// 2. Search across all docs — returns exact lines, not chunks
const grep = await vfs.exec('grep -r "webhook" .');
console.log(grep.stdout);

// 3. Read a specific document
const cat = await vfs.exec("cat /guides/webhooks.md | head -10");
console.log(cat.stdout);

// 4. Compose with pipes — count, sort, filter
const count = await vfs.exec('find / -name "*.md" | wc -l');
console.log(`Total docs: ${count.stdout.trim()}`);

// 5. Write protection — structurally impossible
const write = await vfs.exec('echo "hack" > /test.txt');
console.log(`Write attempt: ${write.stderr}`); // EROFS: read-only file system
