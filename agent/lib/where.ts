/**
 * where — the label Yong recognizes for a pi process: its tmux window, `<index> <name>` (e.g. `11 harness`; he works in one
 * tmux session, so it is never shown), never a pid or a session id alone (Yong 2026-09-16: "I got a PID which I don't really know"). Resolved LIVE at display time: window
 * indexes shift when a window closes, so callers store the stable pane id (`%28`) and call `where()` when they show it.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface Spot { pane?: string; pid?: number; cwd?: string }
type Run = (pane: string) => string;                    // `tmux display -p -t <pane> …` → "0:11 harness" or "" when gone

const tmuxDisplay: Run = (pane) => {
  try { return execFileSync("tmux", ["display", "-p", "-t", pane, "#{session_name}:#{window_index} #{window_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
};

/** `<index> <name>` — the tmux session is dropped (Yong works in one session), pid in parentheses when known. */
export function whereLabel(spot: Spot, run: Run = tmuxDisplay): string {
  const pidPart = spot.pid !== undefined ? `pid ${spot.pid}` : "";
  let head = "";
  if (spot.pane) {
    const s = run(spot.pane).trim();
    if (s) head = s.slice(s.indexOf(":") + 1);
  }
  if (!head && spot.cwd) head = basename(spot.cwd);
  if (!head) return pidPart;
  return pidPart ? `${head} (${pidPart})` : head;
}

/** Which pane a pid lives in: the pane whose shell pid is on its parent chain. Bounded walk (a broken `ps` must not spin). */
export function paneForPid(pid: number, panes: { pane: string; pid: number }[], parentOf: (pid: number) => number | undefined): string | undefined {
  const byPid = new Map(panes.map((p) => [p.pid, p.pane]));
  let cur: number | undefined = pid;
  for (let i = 0; i < 64 && cur !== undefined && cur > 1; i++) {
    const hit = byPid.get(cur);
    if (hit) return hit;
    const next = parentOf(cur);
    if (next === cur) return undefined;
    cur = next;
  }
  return undefined;
}

const livePanes = (): { pane: string; pid: number }[] => {
  try {
    return execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(Boolean).map((l) => { const [pane, pid] = l.split(" "); return { pane, pid: Number(pid) }; });
  } catch { return []; }
};
const liveParent = (pid: number): number | undefined => {
  try { const n = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); return Number.isFinite(n) ? n : undefined; }
  catch { return undefined; }
};

/** One call for callers: label a process. Pane given ⇒ used; else looked up from the pid. */
export function where(spot: Spot): string {
  const pane = spot.pane ?? (spot.pid !== undefined ? paneForPid(spot.pid, livePanes(), liveParent) : undefined);
  return whereLabel({ ...spot, pane });
}
