/**
 * The recorded half of /usage: facts the live branch cannot know.
 *
 * A branch is what the model will SEE next; the ledger is what the session has SPENT.
 * They diverge at the first compaction — pre-compaction calls leave the branch entirely, so a
 * branch-only total silently undercounts (measured: $8.28 shown vs $12.71 real, 2026-09-13).
 * Read-only by construction: /usage never holds a lease and never writes.
 */
import { DatabaseSync } from "node:sqlite";

export type Compaction = { at: number; reason: string; fromExtension: boolean; before: number; summary: number; cost: number };
export type Dropped = { count: number; cost: number; unknownCost: number };
export type LedgerPoint = { at: number; context: number; compaction: boolean };
export type Miss = { at: number; model: string; wrote: number; cost: number };
/** A model change between consecutive calls. The cache is per-model, so a switch normally costs one
 *  full prefix rewrite — but a cheap one is invisible to MISS, which is why these are counted here. */
export type Switch = { at: number; from: string; to: string; wrote: number; read: number; cost: number };
export type Cache = { hitPct: number; calls: number; misses: Miss[]; missCost: number; readCost: number; writeCost: number };
export type Ledger = {
  calls: number;
  cost: number;
  reasoning: number;
  compactions: Compaction[];
  switches: Switch[];
  /** background summaries that were generated but never applied — spent, not saved */
  dropped: Dropped;
  points: LedgerPoint[];
  cache: Cache;
  today: { kind: string; calls: number; cost: number }[];
  /** spend per local day, last 7 days incl. today, oldest first */
  week: { day: string; cost: number }[];
  startedAt: number;
  model: string;
  todayCompactions: { count: number; cost: number; avgBefore: number; avgSummary: number; byTrigger: { trigger: string; count: number; cost: number }[] };
  /** today across every agent: the 4-way cost split, hot vs cold calls, hit ratio */
  todaySplit: { calls: number; cost: number; fresh: number; cacheRead: number; cacheWrite: number; output: number; hitPct: number;
    hotCalls: number; hotCost: number; coldCalls: number; coldCost: number };
};

/** A call that read nothing but sent a real prefix paid full freight for context it had already
 *  bought. Tiny prompts (<1k) are not misses — there was nothing to reuse. */
const MISS = "COALESCE(cache_read_tokens,0) = 0 AND COALESCE(cache_write_tokens,0) + COALESCE(input_tokens,0) > 1024";

const nz = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Facts for one session, or null when nothing is recorded (a session older than the recorder). */
export function readLedger(dbPath: string, sessionId: string, points = 40): Ledger | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const agent = db.prepare("SELECT id FROM agents WHERE session_id = ?").get(sessionId) as { id?: number } | undefined;
    if (!agent?.id) return null;

    const totals = db.prepare(`
      SELECT COUNT(*) AS calls, SUM(c.estimated_cost) AS cost, SUM(c.reasoning_tokens) AS reasoning
      FROM model_calls c JOIN turns t ON c.turn_id = t.id WHERE t.agent_id = ?`).get(agent.id) as Record<string, unknown>;

    const compactions = (db.prepare(`
      SELECT recorded_at, reason, from_extension, tokens_before, summary_tokens, cost
      FROM compactions WHERE agent_id = ? AND applied = 1 ORDER BY recorded_at`).all(agent.id) as Record<string, unknown>[])
      .map(r => ({ at: nz(r.recorded_at), reason: String(r.reason ?? "?"), fromExtension: nz(r.from_extension) === 1,
        before: nz(r.tokens_before), summary: nz(r.summary_tokens), cost: nz(r.cost) }));
    const d = db.prepare(`
      SELECT COUNT(*) AS count, SUM(COALESCE(cost, 0)) AS cost, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknown_cost
      FROM compactions WHERE agent_id = ? AND applied = 0`).get(agent.id) as Record<string, unknown>;
    const dropped: Dropped = { count: nz(d?.count), cost: nz(d?.cost), unknownCost: nz(d?.unknown_cost) };

    // The sawtooth: context per call, with compactions marked where they cut it.
    const series = (db.prepare(`
      SELECT at, context_tokens, kind FROM timeline
      WHERE agent_id = ? AND (context_tokens IS NOT NULL OR kind = 'compaction')
      ORDER BY at DESC LIMIT ?`).all(agent.id, points) as Record<string, unknown>[])
      .reverse()
      .map(r => ({ at: nz(r.at), context: nz(r.context_tokens), compaction: String(r.kind) === "compaction" }));

    const agg = db.prepare(`
      SELECT SUM(COALESCE(c.cache_read_tokens,0)) AS reads,
             SUM(COALESCE(c.input_tokens,0) + COALESCE(c.cache_read_tokens,0) + COALESCE(c.cache_write_tokens,0)) AS prefix,
             SUM(COALESCE(c.cost_cache_read,0)) AS read_cost, SUM(COALESCE(c.cost_cache_write,0)) AS write_cost,
             SUM(CASE WHEN ${MISS} THEN COALESCE(c.estimated_cost,0) ELSE 0 END) AS miss_cost
      FROM model_calls c JOIN turns t ON c.turn_id = t.id WHERE t.agent_id = ?`).get(agent.id) as Record<string, unknown>;
    const misses = (db.prepare(`
      SELECT c.recorded_at, c.model, COALESCE(c.cache_write_tokens,0) + COALESCE(c.input_tokens,0) AS wrote, c.estimated_cost
      FROM model_calls c JOIN turns t ON c.turn_id = t.id
      WHERE t.agent_id = ? AND ${MISS} ORDER BY c.recorded_at`).all(agent.id) as Record<string, unknown>[])
      .map(r => ({ at: nz(r.recorded_at), model: String(r.model ?? "?"), wrote: nz(r.wrote), cost: nz(r.estimated_cost) }));
    const switches = (db.prepare(`
      WITH s AS (
        SELECT c.recorded_at AS at, c.model,
               LAG(c.model) OVER (ORDER BY c.recorded_at, c.id) AS prev,
               COALESCE(c.cache_write_tokens,0) + COALESCE(c.input_tokens,0) AS wrote,
               COALESCE(c.cache_read_tokens,0) AS cread, COALESCE(c.estimated_cost,0) AS cost
        FROM model_calls c JOIN turns t ON c.turn_id = t.id WHERE t.agent_id = ?)
      SELECT at, prev, model, wrote, cread, cost FROM s
      WHERE prev IS NOT NULL AND prev <> model ORDER BY at`).all(agent.id) as Record<string, unknown>[])
      .map(r => ({ at: nz(r.at), from: String(r.prev ?? "?"), to: String(r.model ?? "?"),
        wrote: nz(r.wrote), read: nz(r.cread), cost: nz(r.cost) }));

    const prefix = nz(agg?.prefix);
    const cache: Cache = {
      hitPct: prefix > 0 ? (nz(agg?.reads) / prefix) * 100 : 0,
      calls: nz(totals?.calls), misses, missCost: nz(agg?.miss_cost),
      readCost: nz(agg?.read_cost), writeCost: nz(agg?.write_cost),
    };

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = (db.prepare(`
      SELECT a.kind AS kind, COUNT(*) AS calls, SUM(c.estimated_cost) AS cost
      FROM model_calls c JOIN turns t ON c.turn_id = t.id JOIN agents a ON a.id = t.agent_id
      WHERE c.recorded_at >= ? GROUP BY a.kind ORDER BY SUM(c.estimated_cost) DESC`).all(midnight.getTime()) as Record<string, unknown>[])
      .map(r => ({ kind: String(r.kind ?? "?"), calls: nz(r.calls), cost: nz(r.cost) }));

    const week = (db.prepare(`
      SELECT date(recorded_at/1000, 'unixepoch', 'localtime') AS day, SUM(estimated_cost) AS cost
      FROM model_calls WHERE recorded_at >= ? GROUP BY day ORDER BY day`).all(midnight.getTime() - 6 * 86_400_000) as Record<string, unknown>[])
      .map(r => ({ day: String(r.day), cost: nz(r.cost) }));
    const first = db.prepare(`SELECT MIN(c.recorded_at) AS at, (SELECT model FROM model_calls c2 JOIN turns t2 ON c2.turn_id = t2.id WHERE t2.agent_id = ? ORDER BY c2.recorded_at DESC LIMIT 1) AS model
      FROM model_calls c JOIN turns t ON c.turn_id = t.id WHERE t.agent_id = ?`).get(agent.id, agent.id) as Record<string, unknown>;

    const tc = db.prepare(`SELECT COUNT(*) AS count, SUM(COALESCE(cost,0)) AS cost, AVG(tokens_before) AS before, AVG(summary_tokens) AS summary
      FROM compactions WHERE applied = 1 AND recorded_at >= ?`).get(midnight.getTime()) as Record<string, unknown>;
    // "idle 274s" / "threshold 200k" collapse to their trigger; dropped summaries are spend without a cut.
    const byTrigger = (db.prepare(`
      SELECT CASE WHEN reason LIKE 'idle%' THEN 'idle' WHEN reason LIKE 'threshold%' THEN 'threshold' WHEN reason LIKE 'dropped%' THEN 'dropped' ELSE COALESCE(reason,'?') END AS trigger,
             COUNT(*) AS count, SUM(COALESCE(cost,0)) AS cost
      FROM compactions WHERE recorded_at >= ? GROUP BY 1 ORDER BY 2 DESC`).all(midnight.getTime()) as Record<string, unknown>[])
      .map(r => ({ trigger: String(r.trigger), count: nz(r.count), cost: nz(r.cost) }));
    const ts = db.prepare(`
      SELECT COUNT(*) AS calls, SUM(COALESCE(estimated_cost,0)) AS cost, SUM(COALESCE(cost_input,0)) AS fresh, SUM(COALESCE(cost_cache_read,0)) AS cread,
             SUM(COALESCE(cost_cache_write,0)) AS cwrite, SUM(COALESCE(cost_output,0)) AS output,
             SUM(COALESCE(cache_read_tokens,0)) AS reads, SUM(COALESCE(input_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)) AS prefix,
             SUM(CASE WHEN ${MISS} THEN 1 ELSE 0 END) AS cold_calls, SUM(CASE WHEN ${MISS} THEN COALESCE(estimated_cost,0) ELSE 0 END) AS cold_cost,
             SUM(CASE WHEN COALESCE(cache_read_tokens,0) > 0 THEN 1 ELSE 0 END) AS hot_calls, SUM(CASE WHEN COALESCE(cache_read_tokens,0) > 0 THEN COALESCE(estimated_cost,0) ELSE 0 END) AS hot_cost
      FROM model_calls WHERE recorded_at >= ?`).get(midnight.getTime()) as Record<string, unknown>;
    const todaySplit = { calls: nz(ts?.calls), cost: nz(ts?.cost), fresh: nz(ts?.fresh), cacheRead: nz(ts?.cread), cacheWrite: nz(ts?.cwrite), output: nz(ts?.output),
      hitPct: nz(ts?.prefix) > 0 ? (nz(ts?.reads) / nz(ts?.prefix)) * 100 : 0,
      hotCalls: nz(ts?.hot_calls), hotCost: nz(ts?.hot_cost), coldCalls: nz(ts?.cold_calls), coldCost: nz(ts?.cold_cost) };

    return { calls: nz(totals?.calls), cost: nz(totals?.cost), reasoning: nz(totals?.reasoning), compactions, switches, dropped, points: series, cache, today,
      week, startedAt: nz(first?.at), model: String(first?.model ?? ""), todayCompactions: { count: nz(tc?.count), cost: nz(tc?.cost), avgBefore: nz(tc?.before), avgSummary: nz(tc?.summary), byTrigger }, todaySplit };
  } catch {
    return null;   // a missing/locked/older DB degrades /usage to branch-only, never breaks it
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
