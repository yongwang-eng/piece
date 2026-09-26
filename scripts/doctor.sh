#!/bin/bash
# doctor.sh — verify an installed piece the same way every run: prerequisites, state, redis, the tmux hook, and whether the
# trackings are actually recording. ✓ ok · ⚠ optional/off (says what turns it on) · ✕ broken (exit 1). Safe to run any time.
ROOT=$(cd "$(dirname "$0")/.." && pwd); AGENT="$ROOT/agent"; fail=0
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
bad()  { printf '  ✕ %s\n' "$*"; fail=1; }
say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
q()    { node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$AGENT/state/agent.sqlite',{readOnly:true});console.log(d.prepare(process.argv[1]).get().n)" "$1" 2>/dev/null; }

say "install location"
[ "$ROOT" = "$HOME/.pi" ] && ok "repo is ~/.pi" || bad "repo is at $ROOT — pi only loads ~/.pi (clone it there, or symlink)"

say "prerequisites"
for c in pi tmux redis-server redis-cli node; do command -v $c >/dev/null && ok "$c $(command -v $c)" || bad "$c missing"; done
node -e 'require("node:sqlite")' 2>/dev/null && ok "node $(node -v) has node:sqlite" || bad "node ≥ 22.5 needed for node:sqlite (have $(node -v 2>/dev/null))"
[ -f "$HOME/.pi/agent/auth.json" ] || [ -f "$HOME/.pi/agent/models-store.json" ] && ok "a provider is logged in" || warn "no provider yet — run pi, then /login"

say "state (agent/state is runtime only, never committed)"
for d in state state/live state/pubsub state/session-leases; do [ -d "$AGENT/$d" ] && ok "$d/" || bad "$d/ missing — run scripts/setup.sh"; done
if [ -f "$AGENT/state/agent.sqlite" ]; then
  n=$(q "select count(*) as n from sqlite_master where type='table'")
  [ "${n:-0}" -ge 11 ] && ok "agent.sqlite · $n tables" || bad "agent.sqlite has ${n:-0} tables (expected ≥ 11) — node scripts/schema-check.mjs agent"
else bad "agent.sqlite missing — run scripts/setup.sh"; fi

say "redis (crew transport, loopback)"
ENVF="$HOME/.config/claude/pi-pubsub.env"; port=$(node -e "console.log(require('$AGENT/config/pubsub.json').port ?? 16379)" 2>/dev/null || echo 16379)
if [ -r "$ENVF" ]; then
  ( . "$ENVF"; redis-cli -h 127.0.0.1 -p "$port" PING 2>/dev/null | grep -q PONG ) && ok "127.0.0.1:$port PONG (ACL from $ENVF)" || bad "redis not answering on $port — scripts/setup.sh starts it"
else bad "$ENVF missing — scripts/setup.sh generates the ACL + env"; fi
redis-cli -h 127.0.0.1 -p "$port" CONFIG GET bind 2>/dev/null | grep -q "0.0.0.0" && bad "redis bound to 0.0.0.0 — must be 127.0.0.1 only"

say "tmux status-line hook (per-window glyph: working · needs you · finished unread)"
if grep -q '@claude_dot' "$HOME/.tmux.conf" 2>/dev/null; then ok "~/.tmux.conf reads #{@claude_dot}"; else
  warn "~/.tmux.conf does not show the glyph. Add:"
  printf "      setw -g window-status-format '#I:#W#{@claude_dot}'\n      setw -g window-status-current-format '#[bold] #I:#W#{@claude_dot} '\n"; fi

say "config (every file is an allowlist — empty means the feature refuses, by design)"
c() { node -e "const j=require('$AGENT/config/$1');console.log($2)" 2>/dev/null; }
[ "$(c repos.json '(j.repos??[]).length')" -gt 0 ] 2>/dev/null && ok "repos.json: $(c repos.json '(j.repos??[]).length') repos" || warn "repos.json empty — crew_merge/autonomous merges refuse until a repo is listed with its class"
[ "$(c secrets.json 'Object.keys(j).filter(k=>!k.startsWith("_")&&k!=="//"&&k!=="example").length')" -gt 0 ] 2>/dev/null && ok "secrets.json has entries" || warn "secrets.json empty — secret_unlock has nothing to lease (1Password refs go here, never values)"
[ "$(c mcp_tools.json 'Object.keys(j.servers??{}).length')" -gt 0 ] 2>/dev/null && ok "mcp_tools.json lists servers" || warn "mcp_tools.json servers {} — crew_spawn needs:[\"x:read\"] refuses until read tools are listed"
[ "$(c devin.json 'j.authorEmail')" = "you@example.com" ] && warn "devin.json still has the placeholder author — Devin PR arrival checks will refuse every PR" || ok "devin.json author set"
[ "$(c browser_profiles.json '(j.profiles??[]).some(p=>p.pool)')" = true ] && ok "browser_profiles.json has a scratch pool" || bad "browser_profiles.json needs one profile with pool:true"

say "trackings (proof they record, not just that they load)"
if [ -f "$AGENT/state/agent.sqlite" ]; then
  mc=$(q "select count(*) as n from model_calls"); tn=$(q "select count(*) as n from turns"); cr=$(q "select count(*) as n from crews")
  if [ "${mc:-0}" -gt 0 ]; then ok "usage ledger (sqlite): $mc model calls · $tn turns"; else warn "no model calls yet — run one pi turn, then re-run doctor; a count that stays 0 means the usage extension did not load (check pi's [Extension issues] banner)"; fi
  [ "${cr:-0}" -gt 0 ] && ok "crew: $cr runs recorded" || warn "no crew run yet — /crew_cli spawn probe --role \"probe\" -- Reply ALIVE  (then /crew_cli kill all)"
fi
[ -n "${MAC_HUB_ACTIVITY_URL:-}" ] && ok "telemetry: tool-call mirror → $MAC_HUB_ACTIVITY_URL" || warn "telemetry: tool-call mirror is OFF (optional external sink; set MAC_HUB_ACTIVITY_URL to an endpoint accepting its JSON — the sqlite ledger above does not depend on it)"
[ -r "$HOME/.config/halo_pill/sources.json" ] && ok "halo notes: sources.json present" || warn "halo notes: OFF (optional desktop-pill sink, ~/.config/halo_pill/sources.json) — nothing else depends on it"
[ -f "$AGENT/state/recall/recall.sqlite" ] && ok "recall index present" || warn "recall not indexed — scripts/setup.sh --with-recall installs the indexer job"
launchctl list 2>/dev/null | grep -q piece.recall-index && ok "recall indexer launchd job loaded" || true

say "suite"
"$ROOT/scripts/test.sh" | grep -E "^ℹ (pass|fail)" | sed 's/^/  /'

echo; [ $fail = 0 ] && echo "doctor: healthy (⚠ lines are features that are off until configured)" || { echo "doctor: ✕ found — fix the lines above"; exit 1; }
