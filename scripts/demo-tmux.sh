#!/usr/bin/env bash
# demo-tmux.sh — spins up the 3-pane demo layout.
#
# Layout:
#   ┌───────────────────────┬──────────────────────┐
#   │                       │                      │
#   │  pane 0: orchestrator │  pane 1: /memory     │
#   │  (runs demo-multi)    │  watcher             │
#   │                       ├──────────────────────┤
#   │                       │  pane 2: db/prov     │
#   │                       │  watcher             │
#   └───────────────────────┴──────────────────────┘
#
# Attach with:
#   tmux attach -t docsvfs-demo
#
# Kill with:
#   tmux kill-session -t docsvfs-demo
set -euo pipefail

SESSION="docsvfs-demo"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="${HOME}/.docsvfs-demo/db/shared.db"

# Kill any stale session
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create new detached session in the repo root.
tmux new-session -d -s "$SESSION" -n main -c "$REPO"

# Pane 0 (left, full height): orchestrator.
# We don't auto-run it — user presses ENTER in the pane when ready.
tmux send-keys -t "$SESSION:main.0" "echo '[pane 0] orchestrator — run:'; echo '  node scripts/demo-multi.mjs --fresh'; echo" C-m

# Split horizontally → pane 1 (right half, top).
tmux split-window -h -t "$SESSION:main" -c "$REPO"

# Split pane 1 vertically → pane 2 (right half, bottom).
tmux split-window -v -t "$SESSION:main.1" -c "$REPO"

# Resize so left pane is ~55%.
tmux resize-pane -t "$SESSION:main.0" -R 10 2>/dev/null || true

# Start /memory watcher in pane 1.
tmux send-keys -t "$SESSION:main.1" "node scripts/demo-watch-memory.mjs --db '$DB'" C-m

# Start db watcher in pane 2.
tmux send-keys -t "$SESSION:main.2" "node scripts/demo-watch-db.mjs --db '$DB'" C-m

# Focus the orchestrator pane.
tmux select-pane -t "$SESSION:main.0"

echo
echo "tmux session '$SESSION' is ready."
echo "  attach:   tmux attach -t $SESSION"
echo "  detach:   Ctrl-b then d"
echo "  kill:     tmux kill-session -t $SESSION"
echo
echo "In the left pane (orchestrator), run:"
echo "  node scripts/demo-multi.mjs --fresh"
echo
