#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/exports}"
BRANCH="${2:-work}"

mkdir -p "$OUT_DIR/patches"

cd "$ROOT_DIR"

if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "error: branch '$BRANCH' not found" >&2
  exit 1
fi

BUNDLE_PATH="$OUT_DIR/sdfadb-${BRANCH}.bundle"

# Bundle: complete branch history snapshot
git bundle create "$BUNDLE_PATH" "$BRANCH"

# Patches: per-commit history for mail/apply workflow
rm -f "$OUT_DIR/patches"/*.patch

git format-patch --root "$BRANCH" -o "$OUT_DIR/patches" >/dev/null

echo "Export complete"
echo "- Bundle : $BUNDLE_PATH"
echo "- Patches: $OUT_DIR/patches"
