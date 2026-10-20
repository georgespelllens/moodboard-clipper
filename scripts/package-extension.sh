#!/usr/bin/env bash
# Builds what people install: dist/extension/ (the extension plus BUILD.json) and
# dist/moodboard-clipper-extension.zip, which holds the contents of that folder at the archive root.
# Double-click on a Mac and Extract All on Windows then give one folder named moodboard-clipper-extension
# with manifest.json directly inside: that folder is what Chrome loads.
# MBC_DIST overrides the output folder (tests use a temporary one).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo/extension"
dist="${MBC_DIST:-$repo/dist}"
unsafe() { case "$1" in "" | / | "$HOME") echo "package-extension: refusing to write into '$1'" >&2; exit 1 ;; esac; }
unsafe "$dist"

version="$(node -p 'require(process.argv[1]).version' "$src/manifest.json")"
commit="$(git -C "$repo" rev-parse --verify -q HEAD 2>/dev/null || echo unknown)"
if [ "$commit" != unknown ] && [ -n "$(git -C "$repo" status --porcelain -- extension)" ]; then commit="$commit+dirty"; fi
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"
unsafe "$dist"
ext="$dist/extension"
zip="$dist/moodboard-clipper-extension.zip"
rm -rf "$ext" "$zip"
mkdir -p "$ext"
cp -R "$src/manifest.json" "$src/_locales" "$src/icons" "$src/src" "$ext/"
find "$ext" -name .DS_Store -delete
# BUILD.json says which build this is. One "key": "value" per line, so it is easy to read by eye and to check in tests.
cat > "$ext/BUILD.json" <<JSON
{
  "schema": "mbc-build/1",
  "name": "Moodboard Clipper",
  "version": "$version",
  "commit": "$commit",
  "built_at": "$built_at"
}
JSON

(cd "$ext" && zip -qrX "$zip" .)
echo "PACKAGED $version $commit $dist"
