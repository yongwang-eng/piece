/**
 * The session observer's join. A pi SESSION is the owner of everything: it lives in a tmux pane (the lease), its turn
 * state is the pane's dot, and its crews · Devin watches · bg jobs each carry its session id. This module only joins
 * what the producers already wrote — it reads nothing through a live process. Pure: every input is a parameter.
 */
import type { Row } from "../agent-ui/board.ts";
import type { Dot } from "../tmux-dot/state.ts";

export interface LeaseIn { sessionId: string; pid: number; file: string; cwd: string; pane?: string; alive: boolean }
export interface PaneIn { paneId: string; windowId: string; dot?: Dot }
export interface CrewIn { ownerSession: string; slug: string }
export interface DevinIn { ownerSession?: string; slug: string; live: boolean; asking?: boolean }
export interface BgIn { ownerSession?: string; name: string; running: boolean }
export interface Peeked { lastUser: string; lastAt: string }

export interface SessionView {
  sessionId: string; pid: number; pane?: string; cwd: string; file: string; label: string;
  dot?: Dot; lastUser: string; lastAt?: number;
  crews: CrewIn[]; devin: DevinIn[]; bg: BgIn[];
}

export interface Inputs {
  leases: LeaseIn[]; panes: PaneIn[]; crews: CrewIn[]; devin: DevinIn[]; bg: BgIn[];
  label: (spot: { pane?: string; pid: number; cwd: string }) => string;
  peek: (file: string) => Peeked | undefined;
}

export function observe(i: Inputs): SessionView[] {
  const dots = new Map(i.panes.map((p) => [p.paneId, p.dot]));
  return i.leases.filter((l) => l.alive).map((l) => {
    const p = i.peek(l.file);
    return {
      sessionId: l.sessionId, pid: l.pid, pane: l.pane, cwd: l.cwd, file: l.file,
      label: i.label({ pane: l.pane, pid: l.pid, cwd: l.cwd }),
      dot: l.pane ? dots.get(l.pane) : undefined,
      lastUser: p?.lastUser ?? "", lastAt: p?.lastAt ? Date.parse(p.lastAt) : undefined,
      crews: i.crews.filter((c) => c.ownerSession === l.sessionId),
      devin: i.devin.filter((d) => d.ownerSession === l.sessionId && d.live),
      bg: i.bg.filter((b) => b.ownerSession === l.sessionId && b.running),
    };
  });
}

/** Board grammar: glyph from the dot (the pane's truth), detail = owned things + last prompt, age = since last activity. */
export function rowFor(v: SessionView, now: number, me?: string): Row {
  const owned = [
    v.crews.length ? `${v.crews.length} crew${v.crews.length > 1 ? "s" : ""} open` : "",   // open in the ledger — membership is not liveness, so no worker count
    v.devin.length ? `${v.devin.length} devin${v.devin.filter((d) => d.asking).length ? ` (${v.devin.filter((d) => d.asking).length} asking)` : ""}` : "",
    v.bg.length ? `${v.bg.length} bg` : "",
  ].filter(Boolean).join(" · ");
  const prompt = v.lastUser ? `“${v.lastUser.slice(0, 60)}${v.lastUser.length > 60 ? "…" : ""}”` : "";
  const detail = [owned, prompt].filter(Boolean).join(" · ");
  const base = { name: v.label + (me && v.sessionId === me ? " (you)" : ""), pane: v.pane ?? `pid ${v.pid}`, ageMs: now - (v.lastAt ?? now), url: `file://${v.file}` };
  switch (v.dot?.state) {
    case "working": return { ...base, state: "working", detail };
    case "blocked": return { ...base, state: "waiting", waiting: { on: "you", why: v.dot.reason ?? "needs you", sinceMs: now - v.dot.ts }, detail: `${v.dot.reason ?? "needs you"}${detail ? ` · ${detail}` : ""}` };
    case "unread": return { ...base, state: "done", detail: `finished, unseen${detail ? ` · ${detail}` : ""}` };
    default: return { ...base, state: "idle", detail };
  }
}

/** Owed-to-you first, then working, then finished-unseen, then idle — the board's order. */
export const RANK: Record<string, number> = { waiting: 0, working: 1, done: 2, idle: 3 };
export const sortRows = (rows: Row[]) => [...rows].sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || a.ageMs - b.ageMs);
