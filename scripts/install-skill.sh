#!/usr/bin/env bash
# Install the redline-review skill into the user's global Claude skills directory
# so it's reachable from any project, not just this repo.
#
# Re-run after pulling skill changes — this is a copy, not a symlink, because
# the repo lives in paths that move (worktrees, renamed projects). A stale
# symlink that vanishes is worse than a copy that needs an explicit refresh.
#
# Also resolves the redline binary and bakes its absolute path into the
# installed SKILL.md, so the skill never depends on $PATH at invocation time.
# (PATH is inconsistent across shell environments, especially in non-interactive
# subprocesses — an outside-redline session hit this and tried to "fix" a
# perfectly healthy symlink, which is exactly the failure mode this avoids.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/skills/redline-review"
DEST="${CLAUDE_HOME:-$HOME/.claude}/skills/redline-review"
PLACEHOLDER="__REDLINE_BIN__"

if [ ! -d "$SRC" ]; then
  echo "error: skill source not found at $SRC" >&2
  exit 1
fi

# Resolve the redline binary. Prefer $PATH; fall back to ~/.bun/bin/redline;
# if neither, run `bun link` from this repo to create it.
REDLINE_BIN=""
if command -v redline >/dev/null 2>&1; then
  REDLINE_BIN="$(command -v redline)"
elif [ -x "$HOME/.bun/bin/redline" ]; then
  REDLINE_BIN="$HOME/.bun/bin/redline"
else
  if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun is not on PATH; install bun first (https://bun.sh)" >&2
    exit 1
  fi
  echo "redline binary not found — running 'bun link' from $REPO_ROOT..."
  (cd "$REPO_ROOT" && bun link >/dev/null)
  if [ -x "$HOME/.bun/bin/redline" ]; then
    REDLINE_BIN="$HOME/.bun/bin/redline"
  else
    echo "error: 'bun link' did not produce a redline binary at ~/.bun/bin/redline" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# Substitute the binary path into the installed SKILL.md.
SKILL_FILE="$DEST/SKILL.md"
if ! grep -q "$PLACEHOLDER" "$SKILL_FILE"; then
  echo "error: placeholder '$PLACEHOLDER' not found in $SKILL_FILE — source skill is out of sync" >&2
  exit 1
fi
# BSD/GNU sed compatibility: -i takes an arg on macOS, no arg on Linux.
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|$PLACEHOLDER|$REDLINE_BIN|g" "$SKILL_FILE"
else
  sed -i "s|$PLACEHOLDER|$REDLINE_BIN|g" "$SKILL_FILE"
fi

echo "Installed redline-review → $DEST"
echo "  redline binary: $REDLINE_BIN"
echo "Re-run this script after pulling skill changes."
