#!/usr/bin/env bash
# Renders the icon master brand/icon.svg (brand/icon-small.svg for 16 and 32 px, if it exists) into extension/icons/.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tool="$tmp/rasterize"
swiftc -O "$repo/brand/tools/rasterize.swift" -o "$tool"
master="$repo/brand/icon.svg"
small="$repo/brand/icon-small.svg"
[ -f "$small" ] || small="$master"
pick() { if [ "$1" -le 32 ]; then printf '%s' "$small"; else printf '%s' "$master"; fi; }

mkdir -p "$repo/extension/icons"
for size in 16 32 48 128; do "$tool" "$(pick "$size")" "$size" "$repo/extension/icons/$size.png"; done

echo "ICONS $(cd "$repo/extension/icons" && ls | tr '\n' ' ')"
