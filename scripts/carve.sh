#!/bin/bash
# carve.sh — re-snapshot this repo from a working ~/.pi: copy every git-tracked file EXCEPT the company-coupled set,
# through the PRIVATE transform ($PIECE_TRANSFORM, default ~/.config/piece/transform.pl — it names what it replaces, so it
# is never committed), then run scrub-check. Additive-only: files this repo owns (README, scripts/, AGENTS.md, settings.json, config templates)
# are never overwritten by the source — they are the generalized versions.
set -euo pipefail
SRC=${1:-$HOME/.pi}; DST=$(cd "$(dirname "$0")/.." && pwd)
OWN='^(README\.md|LICENSE|scripts/.*|agent/AGENTS\.md|agent/settings\.json|agent/config/.*|agent/themes/.*|agent/profiles/.*\.md|\.gitignore)$'
DROP='^(agent/npm/\.gitignore$|agent/extensions/(inbox|pilab-hotlist)/|agent/skills/|agent/PI_DEVELOPMENT\.md|packages/pi-recall/evals/|agent/profiles/.*\.md$|packages/pi-recall/src/meetings\.rules\.json$)'
TRANSFORM=${PIECE_TRANSFORM:-$HOME/.config/piece/transform.pl}
[ -r "$TRANSFORM" ] || { echo "✕ carve: private transform missing at $TRANSFORM"; exit 2; }
# clear everything this repo does not own, so a file dropped upstream does not linger here
while IFS= read -r f; do [[ $f =~ $OWN ]] || rm -f "$DST/$f"; done < <(git -C "$DST" ls-files -co --exclude-standard)
find "$DST" -type d -empty -not -path '*/.git*' -delete
n=0
while IFS= read -r f; do
  [[ $f =~ $OWN ]] && continue
  [[ $f =~ $DROP ]] && continue
  mkdir -p "$DST/$(dirname "$f")"; perl -p "$TRANSFORM" "$SRC/$f" > "$DST/$f"; chmod --reference="$SRC/$f" "$DST/$f" 2>/dev/null || chmod "$(stat -f %Lp "$SRC/$f")" "$DST/$f"; n=$((n+1))
done < <(git -C "$SRC" ls-files)
echo "carved $n files from $SRC → $DST"
"$DST/scripts/scrub-check.sh"
