#!/usr/bin/env bash
# Install the redline-review skill into the user's global Claude skills directory
# so it's reachable from any project, not just this repo.
#
# Re-run after pulling skill changes — this is a copy, not a symlink, because
# the repo lives in paths that move (worktrees, renamed projects). A stale
# symlink that vanishes is worse than a copy that needs an explicit refresh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/skills/redline-review"
DEST="${CLAUDE_HOME:-$HOME/.claude}/skills/redline-review"

if [ ! -d "$SRC" ]; then
  echo "error: skill source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "Installed redline-review → $DEST"
echo "Re-run this script after pulling skill changes."
