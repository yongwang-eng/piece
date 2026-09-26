/**
 * The ONE painter. Every tick: read all pane states (one tmux call), aggregate per window, paint the windows whose
 * glyph changed, breathe the animated states. Persists stale-working → unread and drops dead agents' options.
 * Singleton by pidfile; every event entry point calls `ensureDaemon()`, so a dead painter is restarted by the next
 * event rather than by someone re-sourcing tmux.conf. Exits when the tmux server is gone.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { aggregate, glyph, type DotState } from "./state.ts";
import { paint, readPanes, writeDot, tmux } from "./tmux.ts";

const STATE_DIR = `${homedir()}/.pi/agent/state`;
export const PIDFILE = `${STATE_DIR}/tmux-dot.pid`;
export const PERIOD_MS = 600;

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function daemonPid(): number | undefined {
  try { const pid = Number(readFileSync(PIDFILE, "utf8").trim()); return pid && alive(pid) ? pid : undefined; } catch { return undefined; }
}

/** Start the painter if none is running. `entry` = the CLI file to spawn (`bin/tmux-dot.ts`). Detached, silent, never awaited. */
export function ensureDaemon(entry: string, node = process.execPath): void {
  if (daemonPid()) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const child = spawn(node, [entry, "daemon"], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch { /* the next event tries again */ }
}

export async function runDaemon(log: (line: string) => void = () => {}): Promise<void> {
  if (daemonPid()) return;                      // lost the race to another starter
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PIDFILE, `${process.pid}\n`);
  const painted = new Map<string, string>();    // window → last glyph written (we are the only writer)
  let frame = 0;
  for (;;) {
    let panes;
    try { panes = await readPanes(); } catch { break; }           // server gone
    if (!panes.length) break;
    if (daemonPid() !== process.pid) break;                        // superseded
    const { windows, rewrite } = aggregate(panes, Date.now());
    for (const [pane, dot] of rewrite) { try { await writeDot(pane, dot); } catch { /* pane vanished */ } }
    let changed = false;
    for (const [w, state] of Object.entries(windows)) {
      const g = glyph(state as DotState | undefined, frame);
      if (painted.get(w) === g) continue;
      try { await paint(w, g); painted.set(w, g); changed = true; } catch { painted.delete(w); }
    }
    for (const w of [...painted.keys()]) if (!(w in windows)) painted.delete(w);
    if (changed) { try { await tmux(["refresh-client", "-S"]); } catch { /* no client */ } }
    frame++;
    await new Promise((r) => setTimeout(r, PERIOD_MS));
  }
  try { if (daemonPid() === process.pid) unlinkSync(PIDFILE); } catch { /* fine */ }
  log("exit");
}
