#!/usr/bin/env bash
# Build the OTTL WASM engine and copy the Go runtime shim into media/.
# Requires: Go with WASM support (go1.21+ recommended; go1.26+ tested).
# Usage: npm run build:wasm
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM_DIR="$REPO_ROOT/wasm"
MEDIA_DIR="$REPO_ROOT/media"

mkdir -p "$MEDIA_DIR"
cd "$WASM_DIR"

echo "→ Downloading Go module dependencies..."
if [ ! -f go.sum ]; then
  go mod tidy   # first-time setup: generate go.sum
else
  go mod download
fi

echo "→ Building ottl.wasm (GOOS=js GOARCH=wasm)..."
GOOS=js GOARCH=wasm go build -o "$MEDIA_DIR/ottl.wasm" .

echo "→ Copying wasm_exec.js..."
GOROOT="$(go env GOROOT)"
WASM_EXEC=""
for candidate in \
    "$GOROOT/lib/wasm/wasm_exec.js" \
    "$GOROOT/misc/wasm/wasm_exec.js"; do
  if [ -f "$candidate" ]; then
    WASM_EXEC="$candidate"
    break
  fi
done
if [ -z "$WASM_EXEC" ]; then
  echo "ERROR: wasm_exec.js not found under GOROOT=$GOROOT" >&2
  exit 1
fi
cp "$WASM_EXEC" "$MEDIA_DIR/wasm_exec.js"

WASM_SIZE=$(du -sh "$MEDIA_DIR/ottl.wasm" | cut -f1)
echo ""
echo "✓ Build complete"
echo "  ottl.wasm  : $WASM_SIZE  ($MEDIA_DIR/ottl.wasm)"
echo "  wasm_exec.js copied from Go $( go version | awk '{print $3}')"
echo ""
echo "Tip: the .wasm is large (~30–60 MB uncompressed). The Marketplace package"
echo "     compresses it automatically. Check .vsix size with: vsce package --dry-run"
