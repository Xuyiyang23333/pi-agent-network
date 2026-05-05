#!/usr/bin/env bash
# Sync agent-network extension to pi's auto-discovery directory.
# Run after editing agent-network.ts, before /reload.

set -euo pipefail

SRC="$HOME/.pi/agent-network/agent-network.ts"
DEST="$HOME/.pi/agent/extensions/agent-network.ts"

if [ ! -f "$SRC" ]; then
  echo "error: source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
echo "synced: $SRC → $DEST"
