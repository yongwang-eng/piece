/**
 * Crew presence → row state (stall detection, D54). The row grammar itself lives in lib/agent-ui/board.ts and is re-exported here.
 *
 * Intercom publishes each session's status as `idle` | `thinking` | `tool:<name>`. A worker that
 * sits in `thinking` beyond its first-token latency threshold may still be ingesting a large
 * context. Surface the silence without interrupting the request (D54).
 *
 */
import { type Row, type RowState } from "../../../lib/agent-ui/board.ts";
import { elapsed } from "../../../lib/agent-ui/time.ts";
export * from "../../../lib/agent-ui/board.ts";

export const STALL_MS = 120_000;   // fallback/floor only (D54); workers report their lifetime's first-token median.

export function stallThreshold(firstTokenMedianMs?: number): number {
  return Math.max(STALL_MS, Number.isFinite(firstTokenMedianMs) && firstTokenMedianMs! > 0 ? 4 * firstTokenMedianMs! : 0);
}

export interface Presence { status: string; since: number; }          // since = when this status was first observed
/** Fold a fresh status observation into the previous one; `since` only moves when the status changes. */
export function observe(prev: Presence | undefined, status: string | undefined, now: number): Presence | undefined {
  if (status === undefined) return undefined;              // not in the room (yet / any more)
  if (!prev || prev.status !== status) return { status, since: now };
  return prev;
}

export function stateOf(p: Presence | undefined, spawnedAt: number, now: number, firstTokenMedianMs?: number): RowState {
  if (!p) return now - spawnedAt < 45_000 ? "starting" : "gone";
  if (p.status === "idle" || p.status === "reattached") return "idle";
  if (p.status === "compacting") return "compacting";
  if (p.status.startsWith("tool:")) return "tool";
  if (p.status === "thinking") return now - p.since >= stallThreshold(firstTokenMedianMs) ? "stalled" : "working";
  return "working";
}

export function isStalled(p: Presence | undefined, now: number, firstTokenMedianMs?: number): boolean {
  return !!p && p.status === "thinking" && now - p.since >= stallThreshold(firstTokenMedianMs);
}

export function rowOf(w: { id?: number; name: string; pane: string; profile?: string; spawnedAt: string }, p: Presence | undefined, now: number, firstTokenMedianMs?: number): Row {
  const spawned = Date.parse(w.spawnedAt) || now;
  const state = stateOf(p, spawned, now, firstTokenMedianMs);
  const detail =
    state === "starting" ? "starting…" :
    state === "gone" ? "not in the room" :
    state === "stalled" ? `no token for ${elapsed(now - p!.since)} — provider stall?` :
    state === "tool" ? p!.status.slice(5) :
    state === "compacting" ? "compacting" :
    state === "idle" ? (p!.status === "reattached" ? "alive · no status since main reattached" : "idle") : "thinking";
  return { id: w.id, name: w.name, pane: w.pane, profile: w.profile, state, detail, ageMs: now - spawned };
}
