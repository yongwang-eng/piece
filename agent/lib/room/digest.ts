/**
 * Turn-start digest — "since your last turn: …" (D43 §4.4). Pure; no pi imports.
 *
 * Nobody surveyed has this (research 2026-09-10): log-only traffic (notices, cc, presence) is
 * surfaced to a member once, at the start of its next turn, as ≤ MAX_LINES bounded lines.
 * Coalesce by key: replaceable status (presence of the same member) collapses to the latest;
 * distinct requests/joins never collapse (attention lane rule 8).
 */

import type { Handoff } from "./types.ts";

export const MAX_LINES = 3;

export interface LogLine {
  seq: number;
  type: "event" | "message";
  kind: string;
  member?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  text?: string;
  details?: Record<string, unknown>;
}

/** Which log lines does member `me` need to hear about? (not its own, not what was already injected to it) */
export function relevantTo(lines: LogLine[], me: string): LogLine[] {
  // A join/leave is recorded twice in the log (the event + the room's notice about it): show it once.
  lines = lines.filter((l) => !(l.type === "message" && l.kind === "notice" && l.from === "room" && /^\S+ (joined|rejoined|left)\b/.test(l.text ?? "")));
  return lines.filter((l) => {
    if (l.type === "event") return l.member !== me;                          // my own join/presence is not news to me
    if (l.from === me) return false;
    if (l.kind === "notice") return (l as any).task !== "progress";           // broadcast — but a milestone lives on the board, not in the digest
    if (l.to?.includes(me)) return false;                                    // addressed to me → it was injected on a lane, not digest
    return !!l.cc?.includes(me);                                             // cc-only → digest
  });
}

/** Coalesce: presence per member → latest only; everything else kept in order. */
export function coalesce(lines: LogLine[]): LogLine[] {
  const latestPresence = new Map<string, LogLine>();
  const rest: LogLine[] = [];
  for (const l of lines) {
    if (l.type === "event" && l.kind === "presence_changed" && l.member) latestPresence.set(l.member, l);
    else rest.push(l);
  }
  return [...rest, ...latestPresence.values()].sort((a, b) => a.seq - b.seq);
}

export function lineText(l: LogLine): string {
  if (l.type === "event") {
    const d = l.details ?? {};
    switch (l.kind) {
      case "member_joined": return `${l.member} joined (${d.role ?? "?"}: ${d.responsibility ?? ""})`.trim();
      case "member_left": return `${l.member} left${d.reason ? ` (${d.reason})` : ""}`;
      case "presence_changed": return `${l.member} ${d.to}`;
      case "ruling_added": return `ruling added: ${d.text ?? ""}`.trim();
      default: return `${l.kind} ${l.member ?? ""}`.trim();
    }
  }
  const who = l.from ?? "?";
  const t = (l.text ?? "").replace(/\s+/g, " ").trim();
  return `${who}: ${t.length > 80 ? t.slice(0, 79) + "…" : t}`;
}

function itemLines(l: LogLine): string[] {
  const p = l.kind === "member_left" ? l.details?.handoff as Handoff | undefined : undefined;
  if (!p) return [`• ${lineText(l)}`];
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  return [
    `${l.member} left — ${clean(p.reason)}${typeof p.tools === "number" ? ` · tools≈${p.tools}` : ""}`,
    p.progress ? `progress: ${clean(p.progress)}` : "no progress line",
    `${p.files?.length ?? 0} files · ${p.decisions ?? 0} decisions · last: ${clean(p.lastMessage ?? "not recorded")}`,
  ];
}

/** The digest block, or "" when nothing is new. Bounded: MAX_LINES body lines + an overflow count. */
export function digest(lines: LogLine[], me: string, width = 100): string {
  const items = coalesce(relevantTo(lines, me));
  if (items.length === 0) return "";
  const departures = items.filter((l) => l.kind === "member_left" && l.details?.handoff).sort((a, b) => b.seq - a.seq);
  if (departures.length > 1) {
    const selected = departures.slice(0, MAX_LINES).map((l) => itemLines(l));
    const remaining = MAX_LINES - selected.length;
    const body = selected.flatMap((lines, i) => lines.slice(0, i === 0 ? 1 + remaining : 1)).map((l) => l.slice(0, width)).join("\n");
    const more = items.length - selected.length;
    return `[room · since your last turn${more ? ` · ${more} items omitted` : ""}]\n${body}`;
  }
  const isPresence = (l: LogLine) => l.kind === "presence_changed" || (l.kind === "notice" && l.from === "room" && / is now (starting|idle|working|compacting|blocked|stalled|gone)$/.test(l.text ?? ""));
  const prioritizeHandoff = items.some((l) => l.kind === "member_left" && l.details?.handoff) && items.some(isPresence);
  const candidates = [...items].reverse();
  if (prioritizeHandoff) candidates.sort((a, b) => Number(isPresence(a)) - Number(isPresence(b)) || b.seq - a.seq);
  const shown: Array<{ seq: number; lines: string[] }> = [];
  let used = 0;
  for (const item of candidates) {
    const lines = itemLines(item);
    if (used + lines.length > MAX_LINES) break;
    shown.push({ seq: item.seq, lines }); used += lines.length;
  }
  const more = items.length - shown.length;
  const body = shown.sort((a, b) => a.seq - b.seq).flatMap((item) => item.lines).map((l) => l.slice(0, width)).join("\n");
  return `[room · since your last turn${more ? ` · ${more} ${prioritizeHandoff ? "items" : "earlier"} omitted` : ""}]\n${body}`;
}
