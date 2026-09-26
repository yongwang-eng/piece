#!/usr/bin/env node
/**
 * tmux-dot <event> [arg] — one entry for every out-of-process caller of the status dot:
 *   Claude Code hooks (settings.json):  working · touch · done · end        (pane = $TMUX_PANE)
 *   tmux hooks (~/.tmux.conf):          read <window_id>
 *   anything else:                      blocked [reason] · unblocked · daemon · status
 * pi calls the same module in-process (extensions/tmux-status). Exits 0 always: a status tool never breaks its caller.
 */
import { fileURLToPath } from "node:url";
import { apply, isSeen, markRead, readPanes } from "../lib/tmux-dot/tmux.ts";
import { ensureDaemon, runDaemon, daemonPid } from "../lib/tmux-dot/daemon.ts";
import { aggregate } from "../lib/tmux-dot/state.ts";

const SELF = fileURLToPath(import.meta.url);

async function main(argv: string[]): Promise<void> {
  const [cmd, arg] = argv;
  const pane = process.env.TMUX_PANE;
  if (!cmd) return;
  if (cmd === "daemon") { await runDaemon(); return; }
  if (cmd === "status") {
    const panes = await readPanes();
    const { windows } = aggregate(panes, Date.now());
    for (const p of panes) if (p.dot) console.log(`${p.paneId} ${p.windowId} ${p.command} ${JSON.stringify(p.dot)}`);
    console.log(`windows: ${JSON.stringify(windows)}\ndaemon: ${daemonPid() ?? "not running"}`);
    return;
  }
  ensureDaemon(SELF);
  if (cmd === "read") { if (arg) await markRead(arg); return; }
  if (!pane) return;
  switch (cmd) {
    case "working": case "touch": case "end": case "unblocked": await apply(pane, { type: cmd }); return;
    case "blocked": await apply(pane, { type: "blocked", reason: arg }); return;
    case "done": await apply(pane, { type: "done", seen: await isSeen(pane) }); return;
  }
}

main(process.argv.slice(2)).catch(() => {}).finally(() => process.exit(0));
