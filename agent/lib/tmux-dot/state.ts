/**
 * tmux-dot — the per-window agent status dot, as one state machine.
 *
 *   ● green (breathing)  working   a turn is in flight
 *   ◆ red   (solid)      blocked   an agent needs a human — outranks everything
 *   ● peach              unread    a turn finished and you have not looked yet
 *   (nothing)            idle      seen, or no agent here
 *
 * Looking is acknowledging (Yong 2026-09-19): navigating to the window clears peach AND red, and neither is raised for a
 * window you are already looking at — the glyph is for windows you are not in.
 *
 * State lives IN TMUX as a per-pane option (`@dot`), so it dies with the pane and needs no file or lock. Events come
 * from pi (extensions/tmux-status), Claude Code hooks and tmux hooks through `bin/tmux-dot`; crew reports blocked/unblocked.
 * ONE painter (the daemon) turns pane states into window glyphs. Everything here is pure so the rules are testable.
 */

import { DOT_COLORS } from "../agent-ui/identity.ts";

export type DotState = "working" | "blocked" | "unread" | "idle";
export interface Dot {
  state: DotState;
  /** last activity (working) or the moment the state was entered */
  ts: number;
  /** the state `blocked` interrupted — restored by `unblocked` */
  prev?: Exclude<DotState, "blocked">;
  /** when the last turn settled; a tool_end landing after it must not resurrect the dot */
  stopTs?: number;
  reason?: string;
}

export type DotEvent =
  | { type: "working" }
  | { type: "touch" }
  | { type: "done"; seen: boolean }
  | { type: "end" }
  | { type: "blocked"; reason?: string; seen?: boolean }
  | { type: "unblocked" }
  | { type: "read" };

/** A working pane quiet this long is stuck or dead (a real turn fires tool ends far more often). */
export const STALE_MS = 15 * 60_000;
/** A tool_end can land after agent_settled; within this window it is the finished turn's tail, not a new turn. */
export const TOMBSTONE_MS = 15_000;
export const OPTION = "@dot";          // per-pane state
export const GLYPH_OPTION = "@claude_dot";   // per-window glyph, read by window-status-format in ~/.tmux.conf

const STATES = new Set<DotState>(["working", "blocked", "unread", "idle"]);

export function next(prev: Dot | undefined, ev: DotEvent, now: number): Dot | undefined {
  switch (ev.type) {
    case "working":
      return { state: "working", ts: now };
    case "touch":
      if (prev && prev.state !== "working" && now - (prev.stopTs ?? 0) <= TOMBSTONE_MS) return prev;
      if (prev?.state === "blocked") return { ...prev, ts: now };
      return { state: "working", ts: now };
    case "done":
      return { state: ev.seen ? "idle" : "unread", ts: now, stopTs: now };
    case "end":
      return undefined;
    case "blocked":
      if (ev.seen) return prev;
      return { state: "blocked", ts: now, prev: prev?.state === "blocked" ? prev.prev : (prev?.state ?? "idle"), reason: ev.reason, stopTs: prev?.stopTs };
    case "unblocked":
      if (prev?.state !== "blocked") return prev;
      return { state: prev.prev ?? "idle", ts: now, stopTs: prev.stopTs };
    case "read":
      if (prev?.state === "unread") return { ...prev, state: "idle" };
      if (prev?.state === "blocked") return { state: prev.prev === "unread" ? "idle" : (prev.prev ?? "idle"), ts: now, stopTs: prev.stopTs };
      return prev;
  }
}

export function encodeDot(d: Dot): string { return JSON.stringify(d); }
export function parseDot(raw: string | undefined): Dot | undefined {
  if (!raw) return undefined;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || !STATES.has(d.state) || typeof d.ts !== "number") return undefined;
    return d as Dot;
  } catch { return undefined; }
}

export interface PaneView { paneId: string; windowId: string; dot: Dot | undefined; command: string }
export interface Aggregate {
  windows: Record<string, DotState | undefined>;
  /** pane states the painter must write back: stale working → unread, persisted so `read` can clear it */
  rewrite: Array<[paneId: string, dot: Dot | undefined]>;
}

const RANK: Record<DotState, number> = { blocked: 3, working: 2, unread: 1, idle: 0 };

export function aggregate(panes: PaneView[], now: number): Aggregate {
  const windows: Record<string, DotState | undefined> = {};
  const rewrite: Aggregate["rewrite"] = [];
  for (const p of panes) {
    if (!(p.windowId in windows)) windows[p.windowId] = undefined;
    let d = p.dot;
    // No liveness guess from pane_current_command: it reads `zsh` for a shell-wrapped pi and erased a live session's state.
    if (d?.state === "working" && now - d.ts > STALE_MS) { d = { ...d, state: "unread", stopTs: now }; rewrite.push([p.paneId, d]); }
    if (!d || d.state === "idle") continue;
    const cur = windows[p.windowId];
    if (!cur || RANK[d.state] > RANK[cur]) windows[p.windowId] = d.state;
  }
  return { windows, rewrite };
}

// Leading space keeps the dot off the tab name. Frame 0/1 alternate for the animated states; colours live in identity.ts.
const GLYPHS: Record<DotState, [string, string]> = {
  working: [` #[fg=${DOT_COLORS.working[0]}]●`, ` #[fg=${DOT_COLORS.working[1]}]●`],
  blocked: [` #[fg=${DOT_COLORS.blocked[0]},bold]◆`, ` #[fg=${DOT_COLORS.blocked[0]},bold]◆`],
  unread: [` #[fg=${DOT_COLORS.unread[0]}]●`, ` #[fg=${DOT_COLORS.unread[1]}]●`],
  idle: ["", ""],
};
export function glyph(state: DotState | undefined, frame: number): string {
  return state ? GLYPHS[state][frame % 2] : "";
}
