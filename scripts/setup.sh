#!/bin/bash
# setup.sh — from a fresh clone at ~/.pi to a working pi: dependencies, redis (the crew transport), state dirs, then the
# suite. Idempotent; re-run after pulling. Heavy optional parts are flags: --with-recall (semantic recall, ~600 MB of
# models), --with-browser (Playwright Chrome), --with-console (the crew web console).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); AGENT="$ROOT/agent"
WITH_RECALL=0; WITH_BROWSER=0; WITH_CONSOLE=0
for a in "$@"; do case $a in --with-recall) WITH_RECALL=1;; --with-browser) WITH_BROWSER=1;; --with-console) WITH_CONSOLE=1;; *) echo "unknown flag $a"; exit 2;; esac; done
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✕ $1 is required: $2"; exit 1; }; }

say "prerequisites"
need node "install Node ≥ 22 (https://nodejs.org or mise/nvm)"
need pi   "npm install -g @earendil-works/pi-coding-agent"
need tmux "brew install tmux — crew workers and the status line live in tmux panes"
node -e 'const [M]=process.versions.node.split("."); if (+M<22) { console.error("✕ node ≥ 22 required, have", process.versions.node); process.exit(1) }'
[ "$ROOT" = "$HOME/.pi" ] || echo "⚠ this clone is at $ROOT — pi reads ~/.pi/agent; clone (or symlink) it there before running pi"

say "state directories"
mkdir -p "$AGENT/state/pubsub" "$AGENT/workers/runs" "$AGENT/state/browser_profiles"

say "npm dependencies (pi-mcp-adapter, themes, crew store)"
(cd "$AGENT/npm" && npm ci --silent)
(cd "$AGENT/npm/crew" && npm ci --silent)
(cd "$ROOT/packages/pi-pubsub" && npm ci --silent)
if [ $WITH_RECALL = 1 ]; then
  say "pi-recall (semantic recall over past sessions)"
  (cd "$ROOT/packages/pi-recall" && npm ci --silent)
  pi install "$ROOT/packages/pi-recall" >/dev/null && echo "  added to settings.packages"
  # the indexer runs every 5 min under launchd (macOS); the plist is rendered here, never hand-written
  if [ "$(uname)" = Darwin ]; then
    PL="$HOME/Library/LaunchAgents/piece.recall-index.plist"; mkdir -p "$(dirname "$PL")" "$AGENT/state/recall"
    cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>piece.recall-index</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>$ROOT/packages/pi-recall/bin/recall-index.ts</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$AGENT/state/recall/launchd.log</string>
  <key>StandardErrorPath</key><string>$AGENT/state/recall/launchd.log</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/piece.recall-index" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "$PL" && echo "  launchd: piece.recall-index every 300 s → state/recall/launchd.log"
  else echo "  schedule yourself: node $ROOT/packages/pi-recall/bin/recall-index.ts every 5 min (cron)"; fi
fi
[ $WITH_BROWSER = 1 ] && (say "browser"; cd "$AGENT/npm/browser" && npm ci --silent && npx playwright install chromium)
[ $WITH_CONSOLE = 1 ] && (say "crew console"; cd "$ROOT/apps/crew-console" && npm ci --silent && (cd web && npm ci --silent && npm run build))

say "redis (crew transport, loopback only)"
need redis-server "brew install redis"
ACL="$HOME/.config/claude/pi-pubsub.acl"; ENVF="$HOME/.config/claude/pi-pubsub.env"
mkdir -p "$(dirname "$ACL")"
if [ ! -f "$ACL" ]; then
  PW=$(openssl rand -hex 24)
  printf 'user default on >%s ~* &* +@all\n' "$PW" > "$ACL"; printf 'export REDISCLI_AUTH=%s\n' "$PW" > "$ENVF"; chmod 600 "$ACL" "$ENVF"
  echo "  generated $ACL and $ENVF (password in memory only, never printed)"
fi
sed "s#__STATE__#$AGENT/state/pubsub#g; s#__ACL__#$ACL#" "$AGENT/config/redis.conf.template" > "$AGENT/config/redis.conf"
if ! ( . "$ENVF"; redis-cli -h 127.0.0.1 -p 16379 PING 2>/dev/null | grep -q PONG ); then
  redis-server "$AGENT/config/redis.conf" && sleep 0.5
fi
( . "$ENVF"; redis-cli -h 127.0.0.1 -p 16379 PING | grep -q PONG ) && echo "  redis 127.0.0.1:16379 PONG"

say "sqlite schema (created empty from the DDL, nothing copied)"
node "$ROOT/scripts/schema-check.mjs" "$AGENT"

say "suite"
"$ROOT/scripts/test.sh"

say "done — start pi in tmux. First run: pi asks for a provider login; set your own models in agent/settings.json."
grep -q '@claude_dot' "$HOME/.tmux.conf" 2>/dev/null || { say "tmux status-line glyph (optional) — add to ~/.tmux.conf, then tmux source-file ~/.tmux.conf"; printf "  setw -g window-status-format '#I:#W#{@claude_dot}'\n  setw -g window-status-current-format '#[bold] #I:#W#{@claude_dot} '\n"; }
echo; echo "next: scripts/doctor.sh — verifies the install and, after your first pi turn, that usage/telemetry are recording."
