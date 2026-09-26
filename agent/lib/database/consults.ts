import { consults } from './schema.ts';
import type { NodeSQLiteDatabase } from '../../npm/crew/node_modules/drizzle-orm/node-sqlite/index.js';
import { and, eq, desc, type SQL } from '../../npm/crew/node_modules/drizzle-orm/index.js';
import type { CrewId } from './store.ts';

export type ConsultTurn = { who: 'human' | 'worker'; text: string; at: string };
export type ConsultIntent = { why: string; exact: string; effect: string; reversible: 'yes' | 'partial' | 'no' | string; ifDenied: string };
export type ConsultAsk = {
  id: string; worker: string; kind: string; class: string; humanRequired: boolean; question: string;
  evidence?: string[]; action?: { verb: string; target: string; detail?: string }; intent?: ConsultIntent; packet?: Record<string, unknown>;
  followUpOf?: string; reply?: string;
  askedAt: number;
};
export type ConsultSettle = { by: string; choice: string | null; answer: string; at: number; launch?: string; agent?: string };
export type ConsultState = 'open' | 'answered' | 'withdrawn';
export type ConsultRecord = {
  id: string; run: CrewId; worker: string; kind: string; class: string; humanRequired: boolean; question: string;
  action: { verb: string; target: string; detail?: string } | null; evidence: string[]; intent: ConsultIntent | null; packet: Record<string, unknown> | null; followUpOf: string | null; reply: string | null; thread: ConsultTurn[];
  state: ConsultState; askedAt: number; answeredAt: number | null; answeredBy: string | null; choice: string | null; answer: string | null;
  launch: string | null; agent: string | null; latencyMs: number | null;
};
export type ConsultFilter = { run?: CrewId; id?: string; state?: ConsultState; kind?: string; worker?: string; answeredBy?: string; limit?: number };

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(s: string | null): T | null => { if (s === null) return null; try { return JSON.parse(s) as T; } catch { return null; } };
const bounded = (s: string, what: string, max = 4000) => { if (typeof s !== 'string' || !s.length || s.length > max) throw new Error(`invalid ${what}`); };

export function insertConsult(db: NodeSQLiteDatabase, crew: number, a: ConsultAsk): void {
  bounded(a.id, 'consult id', 200); bounded(a.worker, 'worker', 200); bounded(a.kind, 'kind', 40); bounded(a.class, 'class', 40); bounded(a.question, 'question', 20_000);
  if (!Number.isSafeInteger(a.askedAt) || a.askedAt < 0) throw new Error('invalid consult time');
  db.insert(consults).values({
    crew_id: crew, id: a.id, worker: a.worker, kind: a.kind, class: a.class, human_required: a.humanRequired ? 1 : 0, question: a.question,
    action_verb: a.action?.verb ?? null, action_target: a.action?.target ?? null, action_detail: a.action?.detail ?? null,
    evidence: json(a.evidence?.length ? a.evidence : undefined), intent: json(a.intent), packet: json(a.packet),
    follow_up_of: a.followUpOf ?? null, reply: a.reply ?? null,
    state: 'open', asked_at: a.askedAt,
  }).run();
}

/** Closes an OPEN consult; the `WHERE state='open'` makes concurrent writers safe — exactly one gets true. */
/** Attach the governor's packet once it exists; only an open row changes (the record of a settled consult is final). */
export function setConsultPacket(db: NodeSQLiteDatabase, crew: number, id: string, packet: Record<string, unknown>): boolean {
  const r = db.update(consults).set({ packet: JSON.stringify(packet) }).where(and(eq(consults.crew_id, crew), eq(consults.id, id), eq(consults.state, 'open'))).run();
  return r.changes === 1;
}

/** One more turn under the same act; only an open row changes. Read-modify-write inside one transaction. */
export function appendConsultTurn(db: NodeSQLiteDatabase, crew: number, id: string, turn: ConsultTurn): boolean {
  return db.transaction((tx) => {
    const row = tx.select({ thread: consults.thread, state: consults.state }).from(consults).where(and(eq(consults.crew_id, crew), eq(consults.id, id))).get();
    if (!row || row.state !== 'open') return false;
    const thread = [...(parse<ConsultTurn[]>(row.thread) ?? []), turn];
    return tx.update(consults).set({ thread: JSON.stringify(thread) }).where(and(eq(consults.crew_id, crew), eq(consults.id, id), eq(consults.state, 'open'))).run().changes === 1;
  });
}

export function settleConsult(db: NodeSQLiteDatabase, crew: number, id: string, s: ConsultSettle, state: 'answered' | 'withdrawn' = 'answered'): boolean {
  bounded(s.by, 'answered_by', 200); bounded(s.answer, 'answer', 20_000);
  if (!Number.isSafeInteger(s.at) || s.at < 0) throw new Error('invalid answer time');
  const r = db.update(consults)
    .set({ state, answered_at: s.at, answered_by: s.by, choice: s.choice ?? null, answer: s.answer, launch: s.launch ?? null, agent: s.agent ?? null })
    .where(and(eq(consults.crew_id, crew), eq(consults.id, id), eq(consults.state, 'open'))).run();
  return r.changes === 1;
}

/** Yong reverses a two-key settlement (D73). Only an ANSWERED row settled by `two-key` and not yet vetoed changes; the
 *  answer keeps its text with the veto appended, so the record shows both what was decided and that it was reversed. */
export function vetoConsult(db: NodeSQLiteDatabase, crew: number, id: string, at: number): boolean {
  return db.transaction((tx) => {
    const row = tx.select({ state: consults.state, by: consults.answered_by, choice: consults.choice, answer: consults.answer }).from(consults).where(and(eq(consults.crew_id, crew), eq(consults.id, id))).get();
    if (!row || row.state !== 'answered' || row.by !== 'two-key' || row.choice === 'vetoed') return false;
    return tx.update(consults).set({ choice: 'vetoed', answer: `${row.answer ?? ''}\n\n[VETO by Yong ${new Date(at).toISOString()}]` })
      .where(and(eq(consults.crew_id, crew), eq(consults.id, id), eq(consults.state, 'answered'), eq(consults.answered_by, 'two-key'))).run().changes === 1;
  });
}

export function selectConsults(db: NodeSQLiteDatabase, f: ConsultFilter): ConsultRecord[] {
  const where: SQL[] = [];
  if (f.run !== undefined) where.push(eq(consults.crew_id, Number(String(f.run).replace(/^crew_/, ''))));
  if (f.id) where.push(eq(consults.id, f.id));
  if (f.state) where.push(eq(consults.state, f.state));
  if (f.kind) where.push(eq(consults.kind, f.kind));
  if (f.worker) where.push(eq(consults.worker, f.worker));
  if (f.answeredBy) where.push(eq(consults.answered_by, f.answeredBy));
  const q = db.select().from(consults).where(where.length ? and(...where) : undefined).orderBy(desc(consults.asked_at)).limit(f.limit ?? 500);
  return q.all().map(r => ({
    id: r.id, run: `crew_${r.crew_id}` as CrewId, worker: r.worker, kind: r.kind, class: r.class, humanRequired: r.human_required === 1, question: r.question,
    action: r.action_verb ? { verb: r.action_verb, target: r.action_target ?? '', ...(r.action_detail ? { detail: r.action_detail } : {}) } : null,
    evidence: parse<string[]>(r.evidence) ?? [], intent: parse<ConsultIntent>(r.intent), packet: parse<Record<string, unknown>>(r.packet), followUpOf: r.follow_up_of, reply: r.reply, thread: parse<ConsultTurn[]>(r.thread) ?? [],
    state: r.state as ConsultState, askedAt: r.asked_at, answeredAt: r.answered_at, answeredBy: r.answered_by, choice: r.choice, answer: r.answer,
    launch: r.launch, agent: r.agent, latencyMs: r.answered_at === null ? null : r.answered_at - r.asked_at,
  }));
}
