#!/bin/bash
# test.sh — the whole suite, one line. Every extension and library ships its regression tests beside it. Exit 1 on any failure.
cd "$(dirname "$0")/../agent" || exit 2
out=$(node --test --test-timeout=15000 \
  lib/where.test.mjs lib/room/*.test.mjs extensions/crew/**/*.test.mjs lib/database/*.test.mjs extensions/guard/*.test.mjs \
  extensions/main-guard/*.test.mjs extensions/telemetry/*.test.mjs extensions/mains/*.test.mjs extensions/session-lease/*.test.mjs \
  extensions/secret-lease/*.test.mjs extensions/bg/*.test.mjs extensions/usage/**/*.test.mjs extensions/borrow/*.test.mjs \
  extensions/tmux-status/*.test.mjs lib/tmux-dot/*.test.mjs lib/telemetry/*.test.mjs lib/agent-ui/*.test.mjs lib/halo/*.test.mjs \
  lib/browser/*.test.mjs lib/sessions/*.test.mjs lib/k6/*.test.mjs profiles/*/*.test.mjs extensions/compaction-ui/*.test.mjs \
  extensions/compact-footer/*.test.mjs extensions/thought-ticker/*.test.mjs extensions/console-guard/*.test.mjs "$@" 2>&1)
echo "$out" | grep -E "^ℹ (tests|pass|fail|skipped)|^not ok|^✖"
echo "$out" | grep -qE "^ℹ fail 0$"
