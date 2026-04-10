#!/bin/bash
# DocsVFS Demo Script
# Run this during screen recording: ./demo.sh
# It types and executes each command with pauses so you can narrate.

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DEMO_DIR"

# Colors
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

clear

echo ""
echo -e "${CYAN}DocsVFS Demo${NC} — Virtual Filesystem for Documentation"
echo -e "─────────────────────────────────────────────────────"
echo ""
echo -e "Press ${YELLOW}Enter${NC} to run each command."
echo ""

# Helper: show command, wait for Enter, then run it
run_cmd() {
  local cmd="$1"
  echo -e "\n${CYAN}docsvfs${NC}:${YELLOW}/${NC}\$ ${cmd}"
  read -r -s  # wait for Enter
  echo "$cmd" | node dist/cli/main.js ./demo-docs --no-repl 2>&1
}

# Start the REPL manually with expect-style interaction
# Actually, let's use the programmatic API for cleaner output

echo -e "\n${CYAN}Starting DocsVFS...${NC}"
echo ""

node --no-deprecation -e "
const { createDocsVFS } = await import('./dist/create.js');
const readline = await import('node:readline');

const vfs = await createDocsVFS({ rootDir: './demo-docs', noCache: true });

console.log('\x1b[36m📁 docsvfs\x1b[0m — Virtual filesystem for documentation');
console.log('   Found: \x1b[32m' + vfs.stats.fileCount + '\x1b[0m files in \x1b[32m' + vfs.stats.dirCount + '\x1b[0m directories');
console.log('   Indexed: \x1b[32m' + vfs.stats.chunkCount + '\x1b[0m chunks');
console.log('   Boot time: \x1b[32m' + vfs.stats.bootTimeMs + 'ms\x1b[0m');
console.log('   Mode: \x1b[31mread-only\x1b[0m (EROFS on writes)\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

const commands = [
  { cmd: 'tree / -L 2', label: 'Show full doc structure' },
  { cmd: 'grep -r \"webhook\" .', label: 'Search across all files' },
  { cmd: 'cat /guides/webhooks.md | head -10', label: 'Read a specific document' },
  { cmd: 'grep -r \"HMAC\" .', label: 'Drill into signature verification' },
  { cmd: 'echo \"hack\" > /test.txt', label: 'Try to write (blocked by EROFS)' },
];

let i = 0;

function runNext() {
  if (i >= commands.length) {
    console.log('\n\x1b[36mDemo complete.\x1b[0m');
    rl.close();
    process.exit(0);
    return;
  }

  const { cmd, label } = commands[i];
  console.log('\x1b[2m// ' + label + '\x1b[0m');
  rl.question('\x1b[36mdocsvfs\x1b[0m:\x1b[33m/\x1b[0m\$ ' + cmd + '  \x1b[2m(press Enter)\x1b[0m', async () => {
    process.stdout.write('\x1b[A\x1b[2K');  // clear the prompt line
    process.stdout.write('\x1b[36mdocsvfs\x1b[0m:\x1b[33m/\x1b[0m\$ ' + cmd + '\n');

    const result = await vfs.exec(cmd);
    if (result.stdout) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith('\n')) process.stdout.write('\n');
    }
    if (result.stderr) {
      process.stdout.write('\x1b[31m' + result.stderr + '\x1b[0m');
      if (!result.stderr.endsWith('\n')) process.stdout.write('\n');
    }
    console.log('');
    i++;
    runNext();
  });
}

runNext();
"