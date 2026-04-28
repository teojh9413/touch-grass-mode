#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist"
mkdir -p "$OUT_DIR"
cd "$ROOT_DIR"
ZIP_PATH="$OUT_DIR/touch-grass-mode.zip"
rm -f "$ZIP_PATH"
zip -r "$ZIP_PATH" manifest.json README.md SKILL.md VERSION src icons -x "*.DS_Store"
echo "Packaged: $ZIP_PATH"
