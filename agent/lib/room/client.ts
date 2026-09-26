/**
 * RoomClient — what every member (main, crew worker, later fleet child) runs.
 *
 * Transport: a `RoomChannel` (RedisRoomBus for crew, LocalBus for inline workers) that fans a payload to
 * every member of the run OUTSIDE the transcript and never starts a turn. Each recipient then applies the
 * lane router locally (D43) and injects on pi's `steer`/`followUp` lane, or only logs.
 *
 * Writers: MAIN is the single writer of roster.json + room.jsonl for the run (D44). Workers publish and
 * read; they never write the record. Everyone shares the filesystem, so the roster is read from disk.
 *
 * pi imports are confined to this file; everything it calls is pure and tested.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { Card, Envelope, Performative, Presence, RoomChannel, Roster } from "./types.ts";
import { checkTalksTo, laneFor, renderHeader, steerGuidance, validateAddressing } from "./lanes.ts";
import { RoomStore, rosterLines } from "./roster.ts";
import { digest, type LogLine } from "./digest.ts";
import { card, renderBox, outlined, rosterRows, HEAVY, PRESENCE_GLYPH, vlen, type Painter } from "./card.ts";
import { colorFor, hexFg } from "../agent-ui/identity.ts";
import { Text } from "@earendil-works/pi-tui";
import type { Handoff } from "./types.ts";

export interface RoomClientOptions {
  run: string;
  runDir: string;
  /** my card; `name` is my address on the bus — peers DM me by it */
  card: Card;
  /** main is the record writer and channel owner; workers are not */
  isMain: boolean;
  /** Main validates announced identities against its registry before recording room events. */
  validateMember?: (card: Card) => void;
  /** how the worker exposes "I am blocked on consult <id>" (set by its consult tool); optional */
  awaiting?: () => string | undefined;
  /** called for `resolve`-lane envelopes (the answer to my blocking call) */
  onResolve?: (env: Envelope) => void;
  /** main only: take an envelope before lane routing; return true to consume it (consult requests) */
  intercept?: (env: Envelope) => boolean;
  /** Main captures disk-backed handoff facts before the member leaves the roster. */
  handoff?: (name: string, reason: string) => Handoff | undefined;
  /** ANY member: see every inbound envelope before lane routing; never consumes. Workers use it to track peers' verdicts. */
  observe?: (env: Envelope) => void;
  /** A pre-built transport (inline workers on a LocalBus). */
  channel?: RoomChannel;
  /** A bus the client attaches ITSELF to (LocalBus, RedisRoomBus): events route in, `onReady` flushes the outbox. */
  bus?: { attach(name: string, onEvent: (ev: any) => void, onReady?: () => void): RoomChannel };
  /** register the `room_send` / `room_who` tools on this session (workers: yes; main: optional) */
  tools?: boolean;
  /** construct-time registration — required when the client is created after session_start (main's lazy per-run client) */
  registerNow?: boolean;
}

/**
 * The mailbox card renderer. MUST be called from the extension body at load — pi's `registerMessageRenderer` is only
 * honoured while the extension is activating; a call from a RoomClient created later (adopt/spawn) is silently dropped
 * and the plain content string paints instead. `me` = this session's room name (main | worker name).
 */
export const cardWidth = (outputPad = 0) => Math.min((process.stdout.columns ?? 100) - outputPad - 2, 110);
export function painter(theme: any, tone: string, senderHex?: string): Painter {
  return {
    border: (s) => theme.fg("dim", s),
    stamp: (s) => theme.fg(tone, s),
    sender: (s) => senderHex ? hexFg(s, senderHex) : theme.bold(s),
    role: (s) => theme.fg("muted", s),
    kind: (s) => theme.fg(tone, s),
    dim: (s) => theme.fg("dim", s),
  };
}

export function registerRoomCardRenderer(pi: ExtensionAPI, me: string, rosterFor?: (run: string) => Roster | undefined) {
  pi.registerMessageRenderer("room_message", (message: any, options: any, theme: any) => {
    return renderCard(message, options, theme);
  });
  const renderCard = (message: any, options: any, theme: any) => {
    const d = message.details ?? {};
    const env = d.envelope as Envelope | undefined;
    if (!env) return new Text(String(message.content ?? ""), options.outputPad ?? 0, 0);
    const member = d.senderRole !== undefined ? undefined : rosterFor?.(env.run)?.members.find((m) => m.name === env.from);
    const senderRole = d.senderRole ?? member?.role;
    const senderId = d.senderId ?? member?.id;
    const c = card({ env: env as any, senderRole, me, width: 0 });
    // urgency = stamp + kind colour (amber asks · green closes · red errors · muted done); who = sender colour; border = dim always
    const toneColor = c.header.tone === "ask" ? "warning" : c.header.tone === "error" ? "error" : c.header.tone === "closure" ? "success" : "accent";
    const kindColor = (env as any).report === "done" ? "muted" : toneColor;
    const cols = (process.stdout.columns ?? 100) - (options.outputPad ?? 0) - 2;
    const lines = renderBox(c, Math.min(cols, 110), {
      border: (s) => theme.fg("dim", s),
      stamp: (s) => theme.fg(kindColor, s),
      sender: (s) => hexFg(s, colorFor(senderId, env.from)),
      role: (s) => theme.fg("muted", s),
      kind: (s) => theme.fg(kindColor, s),
      dim: (s) => theme.fg("dim", s),
    }, env.from);
    if (options.expanded) lines.push(theme.fg("dim", JSON.stringify({ id: env.id, run: env.run, to: env.to, cc: env.cc, re: env.re, task: env.task, at: env.at, lane: d.lane })));
    return new Text(lines.join("\n"), options.outputPad ?? 0, 0);
  };
}

export class RoomClient {
  private pi: ExtensionAPI;
  private o: RoomClientOptions;
  private channel?: RoomChannel;
  private store: RoomStore;
  private turnRunning = false;
  private joined = false;
  /** did this member send anything addressed to main during the current turn? (the shim uses it to skip a duplicate report) */
  sentToMainThisTurn = false;
  private cursorPath: string;
  private seen = new Set<string>();
  private outbox: Envelope[] = [];
  /** receiver-side dedupe of identical (kind,to,text) within a window — the alpha/beta double-escalation */
  private recent = new Map<string, number>();
  private static DEDUPE_MS = 120_000;

  constructor(pi: ExtensionAPI, o: RoomClientOptions) {
    this.pi = pi; this.o = o;
    this.store = new RoomStore(o.runDir, o.run);
    this.cursorPath = `${o.runDir}/members/${o.card.name}.cursor`;
    this.wire();
    if (o.tools) this.registerTools();
  }

  /** Hex is valid in any transport's name charset by construction; the hash covers run AND runDir so a reset DB (new
   *  runs namespace) cannot rejoin an old room. Always 45 chars. RedisRoomBus derives its topic from the same inputs. */
  get namespace() { return `room/${createHash("sha256").update(`${this.o.run}\0${resolve(this.o.runDir)}`).digest("hex").slice(0, 40)}`; }
  get name() { return this.o.card.name; }
  roster(): Roster { return this.store.read(); }
  /** recent room log lines (for governor context) */
  tail(n = 30): string[] {
    const all = this.store.since(0);
    return all.slice(-n).map((l: any) => l.type === "message" ? `#${l.seq} ${l.kind} ${l.from}→${(l.to ?? []).join(",")}: ${String(l.text ?? "").replace(/\s+/g, " ").slice(0, 160)}` : `#${l.seq} ${l.kind} ${l.member ?? ""} ${JSON.stringify(l.details ?? {}).slice(0, 80)}`);
  }
  /** joined AND the transport can deliver right now — a channel that reports `connected: false` is not ready (F12/F13). */
  ready(): boolean { return !!this.channel && this.joined && this.channel.snapshot?.()?.connected !== false; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private registered = false;
  private register() {
    if (this.registered) return;
    this.registered = true;
    if (this.o.channel) { this.channel = this.o.channel; this.join(); this.flush(); return; }   // inline: transport injected
    if (this.o.bus) { this.channel = this.o.bus.attach(this.name, (ev) => this.onEvent(ev), () => this.flush()); this.join(); this.flush(); return; }
    throw new Error("room: a RoomClient needs a `channel` or a `bus` — there is no default transport");
  }

  private wire() {
    const pi = this.pi;
    pi.on("session_start", (_event, ctx) => {
      this.o.card.sessionId = ctx.sessionManager.getSessionId();
      this.register();
    });
    if (this.o.registerNow) this.register();
    pi.on("agent_start", () => { this.turnRunning = true; this.sentToMainThisTurn = false; });
    pi.on("agent_end", () => { this.turnRunning = false; });
    // The digest: log-only traffic since my last turn, ≤3 lines, prepended to my next prompt (D43 §4.4).
    pi.on("before_agent_start", () => {
      const d = this.digestSinceCursor();
      if (!d) return;
      return { message: { customType: "room_digest", content: d, display: true, details: { room: this.o.run } } };
    });
    pi.on("session_shutdown", () => { if (this.o.isMain) this.leaveAll("shutdown"); });
  }

  private join() {
    if (this.joined) return;
    this.joined = true;
    if (this.o.isMain) {
      const { notice } = this.store.join(this.o.card, "main");
      this.broadcastRaw(notice);
    } else {
      // Workers announce; main (the writer) records the join. Their card is in the announcement.
      this.publishRaw({ id: `join-${randomUUID().slice(0, 8)}`, run: this.o.run, at: new Date().toISOString(), from: this.name, to: ["main"], kind: "notice", text: "join", cites: undefined, re: undefined, task: undefined, card: this.o.card } as any);
    }
  }

  /** main only: record a member joining (from its announcement or from a spawn), broadcast the notice. */
  memberJoined(card: Card, actor: "main" | "worker" = "main") {
    if (!this.o.isMain) return;
    this.o.validateMember?.(card);
    const { notice } = this.store.join(card, actor);
    this.broadcastRaw(notice);
  }

  /** main only */
  memberLeft(name: string, reason: string, actor: "main" | "human" | "other-session" | "shutdown" = "main") {
    if (!this.o.isMain) return;
    const handoff = this.o.handoff?.(name, reason);
    const { notice } = this.store.leave(name, actor, reason, new Date(), handoff);
    if (notice) this.broadcastRaw(notice);
  }

  /** main only: runtime-observed presence → roster (notice only on change) */
  presence(name: string, p: Presence) {
    if (!this.o.isMain) return;
    const { notice } = this.store.setPresence(name, p);
    if (notice) this.broadcastRaw(notice);
  }

  private leaveAll(reason: string) {
    for (const m of this.store.read().members) if (m.backend === "main") this.store.leave(m.name, "shutdown", reason);
  }

  // ── sending ────────────────────────────────────────────────────────────────

  /** Send a message into the room. Returns the envelope, or throws on an addressing violation. */
  send(p: { to: string[]; kind: Performative; text: string; cc?: string[]; re?: string; task?: string; cites?: string[]; report?: "done" | "aborted"; tools?: number; elapsedText?: string }): Envelope {
    const env: Envelope = { id: `${this.name}-${randomUUID().slice(0, 8)}`, run: this.o.run, at: new Date().toISOString(), from: this.name, ...p };
    const bad = validateAddressing(env);
    if (bad) throw new Error(`room: ${bad}`);
    const roster = this.store.read();
    const gated = checkTalksTo(this.o.card, env.to, (n) => roster.members.find((m) => m.name === n)?.role, new Set(roster.members.map((m) => (m.role ?? "").toLowerCase().replace(/-/g, "_"))));
    if (gated) throw new Error(`room: ${gated}`);
    if (env.to.includes("main") && env.kind !== "notice") this.sentToMainThisTurn = true;
    if (this.o.isMain) this.store.append({ type: "message", envelope: env });
    this.publishRaw(env);
    return env;
  }

  private broadcastRaw(env: Envelope) { if (this.o.isMain) this.store.append({ type: "message", envelope: env }); this.publishRaw(env); }

  /** Queue until the channel is up — a notice must never fail a spawn (seen: room_join_failed on beta, 2026-09-10). */
  private publishRaw(env: Envelope) {
    if (!this.channel) { this.outbox.push(env); return; }
    try { this.channel.publish(env, { audience: "capable" }); } catch { this.outbox.push(env); }
  }
  private flush() {
    if (!this.channel) return;
    const q = this.outbox; this.outbox = [];
    for (const e of q) { try { this.channel.publish(e, { audience: "capable" }); } catch { this.outbox.push(e); } }
  }

  // ── receiving ──────────────────────────────────────────────────────────────

  private onEvent(ev: any) {
    if (ev?.type !== "message") return;
    const env = ev.payload as Envelope & { card?: Card };
    if (!env || typeof env !== "object" || !env.kind || !env.from || env.run !== this.o.run) return;
    if (this.seen.has(env.id)) return; this.seen.add(env.id);
    if (this.seen.size > 2000) this.seen.clear();

    // A worker's join announcement: main records it and broadcasts the real notice.
    if (this.o.isMain && env.kind === "notice" && env.text === "join" && env.card) { this.memberJoined({ ...env.card, address: `redis:${env.card.name}` }, "worker"); return; }
    if (env.from === this.name) return;                          // my own echo (a bus may include the sender)
    // Telemetry (task:vitals, task:state) is consumed by main and never logged — the digest must not show "{contextPct:1,…}" as room traffic.
    if (env.kind === "notice" && (env.task === "vitals" || env.task === "state")) { this.o.intercept?.(env); return; }
    if (this.o.isMain && env.from !== "room") this.store.append({ type: "message", envelope: env });   // main is the log writer
    if (env.kind !== "notice") {                                  // identical asks from two peers within 2 min → deliver once, note the second
      const key = `${env.kind}|${[...env.to].sort().join(",")}|${env.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
      const now = Date.now();
      for (const [k, t] of this.recent) if (now - t > RoomClient.DEDUPE_MS) this.recent.delete(k);
      if (this.recent.has(key)) { return; }
      this.recent.set(key, now);
    }

    this.o.observe?.(env);
    if (this.o.intercept?.(env)) return;
    const lane = laneFor(env, { me: this.name, presence: this.myPresence(), awaiting: this.o.awaiting?.() });
    switch (lane) {
      case "log": return;                                        // surfaces in the next digest
      case "resolve": this.sentToMainThisTurn = false; this.o.onResolve?.(env); return;   // the consult was a question; the answered worker still owes its report this turn
      case "steer": return this.inject(env, { deliverAs: "steer" }, steerGuidance(env));
      case "followUp": return this.inject(env, { deliverAs: "followUp" });
      case "wake": return this.inject(env, { deliverAs: "followUp", triggerTurn: true });
    }
  }

  private myPresence(): Presence {
    if (this.o.awaiting?.()) return "blocked";
    return this.turnRunning ? "working" : "idle";
  }

  private inject(env: Envelope, opts: { deliverAs: "steer" | "followUp"; triggerTurn?: boolean }, guidance?: string) {
    const member = this.store.read().members.find((m) => m.name === env.from);
    const cites = env.cites?.length ? `\ncites: ${env.cites.join(" · ")}` : "";
    // content = what the MODEL reads (compact header + text); details = what the RENDERER paints (the card)
    this.pi.sendMessage({
      customType: "room_message",
      content: `${renderHeader(env, member?.role)}\n${env.text}${cites}${guidance ? `\n${guidance}` : ""}`,
      display: true,
      details: { room: this.o.run, envelope: env, lane: opts.deliverAs, senderRole: member?.role, senderId: member?.id },
    }, opts as any);
  }

  // ── tools (the worker's voice in the room) ────────────────────────────────

  private registerTools() {
    const pi = this.pi;
    const self = this;
    pi.registerTool({
      name: "room_send",
      label: "Room send",
      description:
        "Send a typed message to peers in your room. kind: `request` (do/decide something for me — expects result/refuse) · `query` (tell me what you know — expects inform) · " +
        "`inform` (a fact/finding; about code or state it MUST cite an artifact in `cites`, else send `propose`) · `result`/`error` (closing a request; set `re`) · " +
        "`propose`/`accept`/`refuse` · `notice` (ambient; never answered; the only kind that may go to '*'). " +
        "Address by name (see room_who); `to:['main']` reaches the coordinator. The recipient's runtime decides whether it is interrupted, informed at a boundary, or just logged — you cannot force urgency. " +
        "Ask a sibling who owns the topic BEFORE asking main.",
      parameters: Type.Object({
        to: Type.Array(Type.String(), { description: "member names, or ['*'] for a notice broadcast" }),
        kind: Type.Union(["request", "query", "inform", "result", "error", "propose", "accept", "refuse", "notice"].map((k) => Type.Literal(k)) as any),
        text: Type.String(),
        cc: Type.Optional(Type.Array(Type.String(), { description: "informed, never triggered" })),
        re: Type.Optional(Type.String({ description: "id of the request/query this answers" })),
        cites: Type.Optional(Type.Array(Type.String(), { description: "file:line, test output path, report path — required for inform about code/state" })),
        task: Type.Optional(Type.String()),
      }),
      async execute(_id, p: any) {
        try {
          const env = self.send(p);
          return { content: [{ type: "text", text: `sent ${env.kind} #${env.seq ?? env.id.slice(0, 6)} → ${env.to.join(",")}${env.kind === "request" || env.kind === "query" ? " — the reply arrives as [room · result|inform · re " + env.id + "]" : ""}` }], details: { envelope: env } };
        } catch (e) {
          return { content: [{ type: "text", text: `not sent: ${(e as Error).message}` }], details: {}, isError: true } as any;
        }
      },
    });
    pi.registerTool({
      name: "room_who",
      label: "Room who",
      description: "Who is in the room: name, role, presence, what they own. Read this before asking anyone; ask the owner of the topic, not main.",
      parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "filter by role/responsibility substring" })) }),
      async execute(_id, p: any) {
        const r = self.store.read();
        // NAME must be searchable. It was not, so `room_who({topic:"researcher-3"})` returned "nobody else is in the
        // room" while researcher-3 was alive and addressable — twice on an earlier run, and both times the caller
        // concluded the peer did not exist and asked main to relay instead. A roster you cannot search by name is a
        // phone book without names.
        const match = (m: { name: string; role?: string; responsibility?: string }) =>
          `${m.name} ${m.role ?? ""} ${m.responsibility ?? ""}`.toLowerCase().includes(String(p.topic).toLowerCase());
        const rows = (p.topic ? r.members.filter(match) : r.members)
          .filter((m) => m.name !== self.name)
          .map((m) => `${m.name}${m.id ? ` (#${m.id})` : ""} · ${m.role} · ${m.presence} · owns: ${m.responsibility}${m.notMyJob ? ` · not: ${m.notMyJob}` : ""}${m.talksTo ? ` · talks to: main, ${m.talksTo.join(", ")}` : ""}`);
        const members = (p.topic ? r.members.filter(match) : r.members).filter((m) => m.name !== self.name);
        return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "nobody else is in the room" }], details: { members: members.map((m) => ({ name: m.name, id: m.id, role: m.role, presence: m.presence, responsibility: m.responsibility })), topic: p.topic } };
      },
      renderCall(args: any, theme: any) { return new Text(`${theme.fg("accent", "⌂")} ${theme.bold("who")}${args.topic ? theme.fg("dim", ` · ${args.topic}`) : ""}`, 0, 0); },
      renderResult(result: any, options: any, theme: any) {
        const d = result.details ?? {}; const members = d.members ?? [];
        const W = cardWidth(options.outputPad ?? 0);
        const capPlain = `⌂ room · ${members.length} member${members.length === 1 ? "" : "s"}${d.topic ? ` · "${d.topic}"` : ""}`;
        const cap = `${theme.fg("accent", "⌂")} ${theme.bold("room")} ${theme.fg("dim", `· ${members.length} member${members.length === 1 ? "" : "s"}${d.topic ? ` · "${d.topic}"` : ""}`)}`;
        const rows = members.length ? rosterRows(members, W).map((r) => {
          const glyphTone = r.presence === "blocked" || r.presence === "stalled" ? "error" : r.presence === "working" ? "success" : "dim";
          const [glyph, ...rest] = r.plain.split(" "); const restStr = rest.join(" ");
          const nameTok = `${r.id ? `#${r.id} ` : ""}${r.name}`;
          const painted = `${theme.fg(glyphTone, glyph)} ${hexFg(nameTok, colorFor(r.id, r.name))}${theme.fg("muted", restStr.slice(nameTok.length).replace(/ — .*$/, ""))}${theme.fg("dim", restStr.includes(" — ") ? restStr.slice(restStr.indexOf(" — ")) : "")}`;
          return { text: painted, plain: r.plain };
        }) : [{ text: theme.fg("dim", "nobody else is in the room") }];
        return new Text(outlined(cap, vlen(capPlain), rows, W, painter(theme, "accent")).join("\n"), options.outputPad ?? 0, 0);
      },
    });
  }

  // ── digest ─────────────────────────────────────────────────────────────────

  private digestSinceCursor(): string {
    let cursor = 0;
    try { if (existsSync(this.cursorPath)) cursor = Number(readFileSync(this.cursorPath, "utf8")) || 0; } catch { /* start from 0 */ }
    let lines = this.store.since(cursor) as unknown as LogLine[];
    if (lines.length === 0) return "";
    // Main has the board: presence chatter in its digest is noise (seen 2026-09-10). Workers still get it.
    if (this.o.isMain) lines = lines.filter((l) => !(l.type === "event" && l.kind === "presence_changed") && !(l.kind === "notice" && /is now (idle|working|stalled|blocked|gone)$/.test(l.text ?? "")));
    const last = Math.max(...lines.map((l) => l.seq));
    try { mkdirSync(`${this.o.runDir}/members`, { recursive: true }); writeFileSync(this.cursorPath, String(last)); } catch { /* best effort */ }
    return digest(lines, this.name);
  }

  /** Release the bus transport (Redis connection) at shutdown; no-op for an injected channel. */
  async detachBus() { const b = this.o.bus as { detach?: () => Promise<void> } | undefined; this.channel = undefined; await b?.detach?.(); }

  /** The roster as routing-table lines for a brief (excludes me). */
  rosterForBrief(): string[] { return rosterLines(this.store.read(), this.name); }
}

