#!/bin/bash
# scrub-check.sh — the leak gate. A LIST, not a judgment. Two lists: `scripts/scrub-generic.txt` (shipped: home paths,
# key shapes, tokens) and a PRIVATE one at $PIECE_DENY (default ~/.config/piece/scrub-deny.txt) naming the things that must
# never appear here — employer, colleagues, internal hosts. The private list is never committed: it would be the leak.
# Exit 1 on any hit. Add a row when a new marker is found; never loosen a row to make a run pass.
set -uo pipefail
cd "$(dirname "$0")/.."
PRIV=${PIECE_DENY:-$HOME/.config/piece/scrub-deny.txt}
[ -r "$PRIV" ] || { echo "✕ scrub-check: private deny list missing at $PRIV — refusing to call anything clean"; exit 2; }
DENY=$(cat scripts/scrub-generic.txt "$PRIV" | grep -v '^#' | grep -v '^$' | paste -sd'|' -)
files=$(git ls-files -co --exclude-standard | grep -v '^scripts/scrub-generic.txt$')
hits=$(echo "$files" | xargs grep -nIiE "$DENY" 2>/dev/null || true)
if [ -n "$hits" ]; then echo "$hits" | cut -c1-170; echo; echo "✕ scrub-check: $(echo "$hits" | wc -l | tr -d ' ') hit(s) in $(echo "$hits" | cut -d: -f1 | sort -u | wc -l | tr -d ' ') file(s)"; exit 1; fi
echo "✓ scrub-check: clean ($(echo "$files" | wc -l | tr -d ' ') files)"
