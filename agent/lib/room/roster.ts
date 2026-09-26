/**
 * Roster + room log — the one centralized record (D44). Pure file I/O; no pi imports.
 *
 * Single writer per run (the owning main). Every change bumps `revision`, writes the roster
 * atomically (sibling + rename — never truncate-in-place), appends a RoomEvent to room.jsonl and
 * returns the `notice` envelope to broadcast, so callers cannot forget to tell the room.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Card, Envelope, Member, Presence, RoomEvent, Roster } from "./types.ts";
import type { Handoff } from "./types.ts";

export const ROOM_LOG = "room.jsonl";
export const ROSTER_FILE = "roster.json";
/** A member unseen for this long is `gone` (SWIM-style suspicion; presence is observed, never claimed). */
export const GONE_AFTER_MS = 90_000;

export class RoomStore {
  readonly runDir: string;
  readonly run: string;
  constructor(runDir: string, run: string) { this.runDir = runDir; this.run = run; }

  private get rosterPath() { return `${this.runDir}/${ROSTER_FILE}`; }
  private get logPath() { return `${this.runDir}/${ROOM_LOG}`; }

  read(): Roster {
    if (!existsSync(this.rosterPath)) return { run: this.run, revision: 0, updatedAt: new Date(0).toISOString(), members: [] };
    try { return JSON.parse(readFileSync(this.rosterPath, "utf8")) as Roster; }
    catch { return { run: this.run, revision: 0, updatedAt: new Date(0).toISOString(), members: [] }; }
  }

  private write(r: Roster): void {
    mkdirSync(this.runDir, { recursive: true });
    const tmp = `${this.rosterPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
    renameSync(tmp, this.rosterPath);
  }

  /** Append one line to room.jsonl; assigns `seq` for envelopes. Returns the seq used. */
  append(entry: { type: "event"; event: RoomEvent } | { type: "message"; envelope: Envelope }): number {
    mkdirSync(this.runDir, { recursive: true });
    const seq = this.nextSeq();
    const line = entry.type === "message"
      ? { ...entry.envelope, seq, type: "message", seq_: undefined }
      : { ...entry.event, seq, type: "event" };
    delete (line as any).seq_;
    if (entry.type === "message") entry.envelope.seq = seq;
    appendFileSync(this.logPath, JSON.stringify(line) + "\n");
    return seq;
  }

  private seqCache?: number;
  private nextSeq(): number {
    if (this.seqCache === undefined) {
      this.seqCache = 0;
      if (existsSync(this.logPath)) {
        for (const l of readFileSync(this.logPath, "utf8").split("\n")) {
          if (!l) continue;
          try { const s = JSON.parse(l).seq; if (typeof s === "number" && s > this.seqCache) this.seqCache = s; } catch { /* skip bad line */ }
        }
      }
    }
    return ++this.seqCache;
  }

  /** Read log entries with seq > cursor (for digests and replay). */
  since(cursor: number): Array<Record<string, unknown>> {
    if (!existsSync(this.logPath)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const l of readFileSync(this.logPath, "utf8").split("\n")) {
      if (!l) continue;
      try { const o = JSON.parse(l); if (typeof o.seq === "number" && o.seq > cursor) out.push(o); } catch { /* skip */ }
    }
    return out;
  }

  // ── membership ────────────────────────────────────────────────────────────

  join(card: Card, actor: RoomEvent["actor"], now = new Date()): { roster: Roster; notice: Envelope } {
    const r = this.read();
    const at = now.toISOString();
    const existing = r.members.find((m) => m.name === card.name);
    // Re-join merges: a later, sparser card (the worker's own announcement) never blanks fields main already recorded.
    const sparse = Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
    const member: Member = existing
      ? { ...existing, ...sparse, lastSeen: at } as Member
      : { ...card, presence: "starting", slots: 1, joinedAt: at, lastSeen: at };
    r.members = [...r.members.filter((m) => m.name !== card.name), member];
    if (card.id && card.id > (r.highestId ?? 0)) r.highestId = card.id;
    r.revision++; r.updatedAt = at;
    this.write(r);
    this.append({ type: "event", event: { kind: "member_joined", run: this.run, at, member: card.name, actor, details: { agentId: card.id, role: card.role, responsibility: card.responsibility, backend: card.backend } } });
    return { roster: r, notice: this.notice(card.name, `${card.name} joined as ${card.role} — ${card.responsibility}`, at, existing ? "rejoined" : "joined") };
  }

  leave(name: string, actor: RoomEvent["actor"], reason: string, now = new Date(), handoff?: Handoff): { roster: Roster; notice: Envelope | undefined } {
    const r = this.read();
    const member = r.members.find((m) => m.name === name);
    if (!member) return { roster: r, notice: undefined };
    const at = now.toISOString();
    r.members = r.members.filter((m) => m.name !== name);
    r.revision++; r.updatedAt = at;
    this.write(r);
    this.append({ type: "event", event: { kind: "member_left", run: this.run, at, member: name, actor, details: { agentId: member.id, reason, ...(handoff ? { handoff } : {}) } } });
    return { roster: r, notice: this.notice(name, `${name} left (${reason})`, at, "left") };
  }

  /** Runtime-observed presence. Returns a notice only on CHANGE (never chatter). */
  setPresence(name: string, presence: Presence, now = new Date()): { roster: Roster; notice: Envelope | undefined } {
    const r = this.read();
    const m = r.members.find((x) => x.name === name);
    const at = now.toISOString();
    if (!m) return { roster: r, notice: undefined };
    m.lastSeen = at;
    if (m.presence === presence) { this.write({ ...r, updatedAt: at }); return { roster: r, notice: undefined }; }
    const from = m.presence;
    m.presence = presence;
    r.revision++; r.updatedAt = at;
    this.write(r);
    this.append({ type: "event", event: { kind: "presence_changed", run: this.run, at, member: name, actor: "runtime", details: { agentId: m.id, from, to: presence } } });
    return { roster: r, notice: this.notice(name, `${name} is now ${presence}`, at, "presence") };
  }

  /** Mark members unseen for GONE_AFTER_MS as gone. Returns notices for each transition. */
  sweep(now = new Date()): Envelope[] {
    const r = this.read();
    const out: Envelope[] = [];
    for (const m of r.members) {
      if (m.presence !== "gone" && now.getTime() - Date.parse(m.lastSeen) > GONE_AFTER_MS) {
        const n = this.setPresence(m.name, "gone", now).notice;
        if (n) out.push(n);
      }
    }
    return out;
  }

  private notice(about: string, text: string, at: string, tag: string): Envelope {
    return { id: `evt-${tag}-${randomUUID().slice(0, 8)}`, run: this.run, at, from: "room", to: ["*"], kind: "notice", text, task: undefined, cites: undefined, re: about };
  }
}

/** Who owns X? — the query every member can answer from the roster instead of asking main. */
export function whoOwns(roster: Roster, needle: string): Member[] {
  const n = needle.toLowerCase();
  return roster.members.filter((m) => `${m.role} ${m.responsibility}`.toLowerCase().includes(n));
}

/** Roster as the peers' routing table: one line per member, for the brief. */
export function rosterLines(roster: Roster, exclude?: string): string[] {
  return roster.members.filter((m) => m.name !== exclude).map((m) =>
    `- ${m.name}${m.id ? ` (#${m.id})` : ""} · ${m.role} · ${m.presence} · owns: ${m.responsibility}${m.notMyJob ? ` · not: ${m.notMyJob}` : ""}${m.talksTo ? ` · talks to: main, ${m.talksTo.join(", ")}` : ""}`);
}
