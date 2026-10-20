#!/bin/bash
# Copies the pictures that README and the site show into site/assets/media/: Pages publishes site/ alone.
# Sources: dist/captures/ (popup, demo GIF), scripts/steps/ (the three install step pictures), brand/ and extension/icons/.
# The pictures inside the animated scenes live in site/assets/scenes/ itself (art by SPELLLENS, see NOTICE.txt there): this script leaves them alone.
# Usage: scripts/collect-media.sh   MBC_PARTIAL=1 skips a missing source with a warning instead of failing.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/site/assets/media"
mkdir -p "$out"
missing=0

put() { # put <source, relative to the repo> <name in site/assets/media>
  if [ -f "$root/$1" ]; then cp "$root/$1" "$out/$2"; return; fi
  if [ "${MBC_PARTIAL:-}" != 1 ]; then echo "collect-media: missing $1" >&2; exit 1; fi
  echo "SKIP $1" >&2
  missing=$((missing + 1))
}

for l in en ru; do
  for t in light dark; do put "dist/captures/popup/popup-$l-$t.png" "popup-$l-$t.png"; done
  for n in 1 2 3; do put "scripts/steps/$l/step-$n.png" "step-$l-$n.png"; done
  put "dist/captures/demo/demo-$l.gif" "demo-$l.gif"
done
put brand/cover.jpg cover.jpg
put brand/wordmark.svg wordmark.svg
put brand/wordmark-white.svg wordmark-white.svg
put extension/icons/128.png icon-128.png
put extension/icons/32.png favicon-32.png
scenes=$(find "$root/site/assets/scenes" -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
echo "MEDIA $((17 - missing)) of 17 in site/assets/media, $scenes in site/assets/scenes"
