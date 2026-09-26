/**
 * The room — vocabulary. Types only, no runtime, no pi imports.
 *
 * A room = one run. Members are workers of any backend (crew tmux processes, fleet in-process
 * children) plus main. Design: obsidian projects/proj_pi_development/design/room-roles-and-delivery.md
 *
 * Three roles, one record (D38, D44):
 *   decision-maker (the human)  — terminal consent, never bypassed
 *   supervisor     (governor)   — answers on the human's behalf when policy covers it; escalates the rest
 *   workers        (crew/fleet) — decide most things themselves; know the room; talk to each other
 *   roster                      — the one central record; runtime-written; not a message
 */

export type Backend = "crew" | "fleet" | "main";

/** Observed by the runtime — a member never claims its own presence (same rule as fleet's report_progress). */
export type Presence = "starting" | "idle" | "working" | "compacting" | "blocked" | "stalled" | "gone";

/**
 * The card (D42): published on join, retracted on leave; = the roster entry = the peers' routing
 * table = the worker's mandate. `profile` is what it CAN do (reusable); `role` is the one line peers
 * read to decide whether to ask it; `responsibility` is what it OWNS in this run.
 */
export interface Card {
  name: string;
  /** Numeric part of the registry's permanent agent_N ID for Crew workers. */
  id?: number;
  /** Pi session reference; separate from the transport address. */
  sessionId?: string;
  backend: Backend;
  profile?: string;
  role: string;
  responsibility: string;
  notMyJob?: string;
  /** Roles I may ADDRESS (main is always allowed). Absent = anyone. Receiving and `notice` broadcast are never filtered.
   *  Set by the preset (a `review` reviewer: ["historian"]) so independent lenses cannot anchor on each other. */
  talksTo?: string[];
  askUpWhen?: string;
  tools?: string[];
  cwd?: string;
  /** where to reach it — `redis:<name>`; and where a human can watch it, if anywhere */
  address?: string;
  pane?: string;
  /** the main (tmux pane id) that owns this worker — adoption after /reload matches on it */
  mainPane?: string;
  model?: string;
}

/** Runtime-owned fields layered on the card. */
export interface Member extends Card {
  presence: Presence;
  slots: number;
  joinedAt: string;
  lastSeen: string;
}

export interface Roster {
  run: string;
  /** monotonically increasing; every write bumps it so readers can detect staleness */
  revision: number;
  /** highest #N ever assigned in this run — ids never reuse, even after a member leaves */
  highestId?: number;
  updatedAt: string;
  members: Member[];
}

/**
 * Message classes (performatives) — minimal, with one anti-loop class (D43 §3).
 *   request / query   expect a reply (result|refuse / inform)
 *   inform / result / error   closure or fact; `inform` about code/state must cite an artifact or be `propose` (D41)
 *   propose / accept / refuse negotiation, only when it matters
 *   notice            ambient (joined, left, idle, rulings updated) — automatic replies must never be sent (IRC NOTICE)
 */
export type Performative =
  | "request" | "query"
  | "inform" | "result" | "error"
  | "propose" | "accept" | "refuse"
  | "notice";

/** `"*"` = everyone in the room; only `notice` may broadcast unaddressed (D43). */
export type Addressee = string | "*";

export interface Envelope {
  /** room-assigned, monotonic per room */
  seq?: number;
  id: string;
  run: string;
  at: string;
  from: string;
  /** who must act / who is asked */
  to: Addressee[];
  /** informed, never triggered */
  cc?: string[];
  kind: Performative;
  /** correlates result/error/accept/refuse to the request/propose it answers */
  re?: string;
  /** task id when the message is about a ledger task */
  task?: string;
  text: string;
  /** artifact citations (file:line, report path, test output path) — required for `inform` about code/state */
  cites?: string[];
}

/** Room lifecycle events, appended to room.jsonl and broadcast as `notice`. */
export type RoomEventKind = "member_joined" | "member_left" | "presence_changed" | "ruling_added";

export interface Handoff {
  reason: string;
  tools?: number | null;
  files?: Array<{ name: string; bytes: number; lines: number }>;
  progress?: string;
  decisions?: number;
  lastDecision?: string;
  lastMessage?: string;
}

export interface RoomEvent {
  kind: RoomEventKind;
  run: string;
  at: string;
  member: string;
  /** who caused it — the record must say, even when another session did (D31) */
  actor: "main" | "governor" | "worker" | "human" | "other-session" | "shutdown" | "runtime";
  details?: Record<string, unknown>;
}

/** pi's delivery lanes + our two non-injecting outcomes. */
export type Lane =
  | "steer"      // next tool boundary of the current turn; the turn continues
  | "followUp"   // after the current turn ends; starts a new turn
  | "wake"       // recipient idle: start a turn now (== steer/followUp with triggerTurn)
  | "log"        // room.jsonl only; surfaced in the next turn-start digest; never wakes
  | "resolve";   // the answer to my blocking consult/ask: resolves the call, not mail

/** The transport seam RoomClient speaks to: LocalBus (inline), RedisRoomBus (crew). `connected` is the truth `ready()` reports. */
export interface RoomChannel {
  namespace: string;
  snapshot(): { connected: boolean };
  /** synchronous hand-off; throws when it cannot hand the payload to the transport right now */
  publish(payload: unknown, options?: { audience?: string }): void;
}

