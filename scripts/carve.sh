#!/bin/bash
# carve.sh [ref] — re-snapshot this repo from a COMMIT of the private ~/.pi (default HEAD; never the working tree, so the
# same ref always yields the same tree). Every tracked file except the company-coupled DROP set is copied through the
# PRIVATE transform ($PIECE_TRANSFORM, default ~/.config/piece/transform.pl — it names what it replaces, so it is never
# committed), then scrub-check runs. Files this repo OWNS (README, scripts/, AGENTS.md, settings.json, config templates,
# themes, profile docs) are the generalized versions and are never overwritten.
# Fail-closed on the unknown: a file that is NEW upstream since the last carve is listed for review — extend OWN/DROP or accept.
set -euo pipefail
SRC=${PIECE_SRC:-$HOME/.pi}; DST=$(cd "$(dirname "$0")/.." && pwd)
REF=$(git -C "$SRC" rev-parse --verify "${1:-HEAD}^{commit}")
OWN='^(README\.md|LICENSE|DEVELOPMENT\.md|packages/pi-recall/README\.md|scripts/.*|agent/AGENTS\.md|agent/settings\.json|agent/config/.*|agent/themes/.*|agent/profiles/.*\.md|\.gitignore)$'
DROP='^(agent/npm/\.gitignore$|agent/extensions/(inbox|pilab-hotlist)/|agent/skills/|agent/PI_DEVELOPMENT\.md|packages/pi-recall/evals/|agent/profiles/.*\.md$|packages/pi-recall/src/meetings\.rules\.json$)'
TRANSFORM=${PIECE_TRANSFORM:-$HOME/.config/piece/transform.pl}
STAMP="$DST/scripts/CARVED_FROM"
[ -r "$TRANSFORM" ] || { echo "✕ carve: private transform missing at $TRANSFORM"; exit 2; }

# clear everything this repo does not own, so a file dropped upstream does not linger here
while IFS= read -r f; do [[ $f =~ $OWN ]] || rm -f "$DST/$f"; done < <(git -C "$DST" ls-files -co --exclude-standard)
find "$DST" -type d -empty -not -path '*/.git*' -delete

n=0
while read -r mode _ _ f; do
  [[ $f =~ $OWN ]] && continue
  [[ $f =~ $DROP ]] && continue
  mkdir -p "$DST/$(dirname "$f")"
  git -C "$SRC" show "$REF:$f" | PIECE_FILE="$f" perl -p "$TRANSFORM" > "$DST/$f"
  [ "$mode" = 100755 ] && chmod 755 "$DST/$f" || chmod 644 "$DST/$f"
  n=$((n+1))
done < <(git -C "$SRC" ls-files -s)
echo "carved $n files from $SRC@${REF:0:9} → $DST"

# new upstream files since the last carve: included, but say so — the reviewer decides if they belong in OWN or DROP
if [ -r "$STAMP" ] && prev=$(git -C "$SRC" rev-parse --verify -q "$(head -1 "$STAMP")^{commit}"); then
  new=$(git -C "$SRC" diff --name-only --diff-filter=A "$prev" "$REF" | grep -Ev "$OWN|$DROP" || true)
  [ -n "$new" ] && { echo "⚠ new upstream files since ${prev:0:9} (included — review, or add to OWN/DROP):"; echo "$new" | sed 's/^/    /'; }
fi
# owned config templates: a config file upstream with no template here is a setup that silently will not load
# accepted without a template (private list — the names themselves can be company-specific): ~/.config/piece/no-template.txt
ACCEPT=$(dirname "$TRANSFORM")/no-template.txt; [ -r "$ACCEPT" ] || ACCEPT=/dev/null
missing=$(comm -23 <(git -C "$SRC" ls-files 'agent/config/*.json' | xargs -n1 basename | sort) <(cat <(ls "$DST/agent/config"/*.json | xargs -n1 basename) "$ACCEPT" | sort -u))
[ -n "$missing" ] && { echo "⚠ upstream config without a template here:"; echo "$missing" | sed 's/^/    agent\/config\//'; }

printf '%s\n%s\n' "$REF" "$(date -u +%Y-%m-%dT%H:%MZ)" > "$STAMP"
"$DST/scripts/scrub-check.sh"
