import type { NodeSQLiteDatabase } from '../../npm/crew/node_modules/drizzle-orm/node-sqlite/index.js';
import { and, desc, eq, gte, lte, sql } from '../../npm/crew/node_modules/drizzle-orm/index.js';
import { turns, calls, compactions } from './schema.ts';

export type UsageFrame = {
  phase: 'start' | 'call' | 'end';
  turnKey: string;
  sessionId: string;
  startedAt: number | null;
  at: number;
  provider?: string | null;
  model?: string | null;
  stopReason?: string;
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  durationMs?: number | null;
  thinkingLevel?: string | null;
  estimatedCost?: number | null;
  costInput?: number | null;
  costOutput?: number | null;
  costCacheRead?: number | null;
  costCacheWrite?: number | null;
  toolCount?: number;
};

export type CompactionFrame = {
  sessionId: string;
  at: number;
  reason: string;
  fromExtension: boolean;
  /** false = summarizer ran but the result was discarded; default true */
  applied?: boolean;
  tokensBefore?: number | null;
  summaryTokens?: number | null;
  tokensAfter?: number | null;
  model?: string | null;
  cost?: number | null;
};

function bounded(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error(`invalid usage ${label}`);
  return value;
}
function count(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid usage count');
  return value;
}
function reason(value: unknown): string {
  if (!['stop', 'length', 'toolUse', 'error', 'aborted', 'unknown'].includes(String(value))) throw new Error('invalid usage stop reason');
  return String(value);
}

// The caller owns the transaction and has already checked the actor/Crew ownership binding.
export function persistUsage(db: NodeSQLiteDatabase, actor: number, crew: number | null, f: UsageFrame): void {
  bounded(f.turnKey, 'turn key'); bounded(f.sessionId, 'session ID');
  if (!['start', 'call', 'end'].includes(f.phase)) throw new Error('invalid usage phase');
  const startedAt = count(f.startedAt), at = count(f.at);
  if (at === null || (startedAt !== null && at < startedAt)) throw new Error('invalid usage timing');
  db.insert(turns).values({ turn_key: f.turnKey, agent_id: actor, crew_id: crew, session_id: f.sessionId, started_at: startedAt }).onConflictDoNothing({ target: turns.turn_key }).run();
  const turn = db.select().from(turns).where(eq(turns.turn_key, f.turnKey)).get()!;
  if (turn.agent_id !== actor || turn.crew_id !== crew || turn.session_id !== f.sessionId) throw new Error('usage turn identity conflict');
  if (turn.started_at !== null && startedAt !== null && turn.started_at !== startedAt) throw new Error('usage start time conflict');
  if (turn.started_at === null && startedAt !== null) db.update(turns).set({ started_at: startedAt }).where(eq(turns.id, turn.id)).run();
  if (f.phase === 'call') {
    const money = (v: number | null | undefined, label: string): number | null => {
      if (v === null || v === undefined) return null;
      if (!Number.isFinite(v) || v < 0) throw new Error(`invalid usage ${label}`);
      return v;
    };
    const provider = f.provider == null ? null : bounded(f.provider, 'provider');
    const model = f.model == null ? null : bounded(f.model, 'model');
    db.insert(calls).values({ turn_id: turn.id, provider, model, recorded_at: at, stop_reason: reason(f.stopReason),
      input_tokens: count(f.input), output_tokens: count(f.output), reasoning_tokens: count(f.reasoning),
      cache_read_tokens: count(f.cacheRead), cache_write_tokens: count(f.cacheWrite), total_tokens: count(f.totalTokens),
      context_tokens: count(f.contextTokens), duration_ms: count(f.durationMs),
      thinking_level: f.thinkingLevel == null ? null : bounded(f.thinkingLevel, 'thinking level'),
      estimated_cost: money(f.estimatedCost, 'estimate'), cost_input: money(f.costInput, 'input cost'),
      cost_output: money(f.costOutput, 'output cost'), cost_cache_read: money(f.costCacheRead, 'cache read cost'),
      cost_cache_write: money(f.costCacheWrite, 'cache write cost'),
      cost_source: 'sdk_reported_estimate',
    }).onConflictDoNothing({ target: calls.turn_id }).run();
  }
  if (f.phase === 'end') {
    if (turn.ended_at !== null && turn.ended_at !== at) throw new Error('usage end time conflict');
    db.update(turns).set({ ended_at: at, outcome: reason(f.stopReason), tool_count: count(f.toolCount) }).where(eq(turns.id, turn.id)).run();
  }
}

export function persistCompaction(db: NodeSQLiteDatabase, actor: number, f: CompactionFrame): void {
  bounded(f.sessionId, 'session ID'); bounded(f.reason, 'compaction reason');
  const at = count(f.at);
  if (at === null) throw new Error('invalid compaction time');
  const cost = f.cost ?? null;
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error('invalid compaction cost');
  db.insert(compactions).values({
    agent_id: actor, session_id: f.sessionId, recorded_at: at, reason: f.reason,
    from_extension: f.fromExtension ? 1 : 0,
    applied: f.applied === false ? 0 : 1,
    tokens_before: count(f.tokensBefore), summary_tokens: count(f.summaryTokens),
    tokens_after: count(f.tokensAfter), model: f.model ?? null, cost,
  }).run();
}

/** pi stamps every extension-initiated splice reason='manual'; the service's `applied` event carries
 *  the trigger label, the post-splice ledger and the summarizer's model. Enrich the freshly inserted row
 *  with those — never billing fields, and never `summary_tokens`, which session_compact already set from
 *  the summarizer's real output. */
export type CompactionEnrichment = { sessionId: string; at: number; reason: string; tokensAfter: number | null; model: string | null };

export function enrichCompaction(db: NodeSQLiteDatabase, actor: number, e: CompactionEnrichment, windowMs = 15_000): boolean {
  bounded(e.sessionId, 'session ID'); bounded(e.reason, 'compaction reason');
  const at = count(e.at);
  if (at === null) return false;
  const row = db.select({ id: compactions.id }).from(compactions)
    .where(and(eq(compactions.agent_id, actor), eq(compactions.session_id, e.sessionId), eq(compactions.applied, 1),
      gte(compactions.recorded_at, at - windowMs), lte(compactions.recorded_at, at + windowMs)))
    .orderBy(desc(compactions.recorded_at), desc(compactions.id)).limit(1).get();
  if (!row) return false;
  db.update(compactions).set({ reason: e.reason, tokens_after: count(e.tokensAfter), model: e.model ?? null }).where(eq(compactions.id, row.id)).run();
  return true;
}

export type UsageTotals = {
  calls: number; tokenKnownCalls: number; costKnownCalls: number;
  totalTokens: number | null; estimatedCost: number | null;
};
export type UsageSummary = {
  totals: UsageTotals;
  byModel: Array<UsageTotals & { provider: string | null; model: string | null }>;
  turns: number; unclosedTurns: number;
};
export function summarizeUsage(db: NodeSQLiteDatabase, crew: number | null): UsageSummary {
  const where = crew === null ? undefined : eq(turns.crew_id, crew);
  const columns = { calls: sql<number>`count(*)`, tokenKnownCalls: sql<number>`count(${calls.total_tokens})`,
    costKnownCalls: sql<number>`count(${calls.estimated_cost})`, totalTokens: sql<number | null>`sum(${calls.total_tokens})`,
    estimatedCost: sql<number | null>`sum(${calls.estimated_cost})` };
  const totals = db.select(columns).from(calls).innerJoin(turns, eq(calls.turn_id, turns.id)).where(where).get()!;
  const byModel = db.select({ provider: calls.provider, model: calls.model, ...columns }).from(calls)
    .innerJoin(turns, eq(calls.turn_id, turns.id)).where(where).groupBy(calls.provider, calls.model).all();
  const timing = db.select({ n: sql<number>`count(*)`, unclosed: sql<number>`coalesce(sum(${turns.ended_at} IS NULL), 0)` })
    .from(turns).where(where).get()!;
  return { totals, byModel, turns: timing.n, unclosedTurns: timing.unclosed };
}
