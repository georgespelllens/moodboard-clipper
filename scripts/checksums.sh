#!/bin/bash
# Writes dist/SHA256SUMS.txt for the one release file: moodboard-clipper-extension.zip.
# Run after scripts/package-extension.sh.
set -euo pipefail
dist="$(cd "$(dirname "$0")/.." && pwd)/dist"
cd "$dist"
[ -f moodboard-clipper-extension.zip ] || { echo "checksums: no dist/moodboard-clipper-extension.zip, run scripts/package-extension.sh first" >&2; exit 1; }
shasum -a 256 moodboard-clipper-extension.zip > SHA256SUMS.txt
shasum -a 256 -c SHA256SUMS.txt > /dev/null
echo "SUMS $dist/SHA256SUMS.txt $(wc -l < SHA256SUMS.txt | tr -d ' ') file"
