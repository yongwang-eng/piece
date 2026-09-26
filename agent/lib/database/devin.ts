import { devinEvents, devinSessions } from './schema.ts';
import type { NodeSQLiteDatabase } from '../../npm/crew/node_modules/drizzle-orm/node-sqlite/index.js';
import { and, eq, isNull, asc, sql } from '../../npm/crew/node_modules/drizzle-orm/index.js';

/** The devin extension's `Session`, as the store sees it: JS shapes in, JSON columns behind. `events` is read-only here. */
export interface DevinRecord {
  id: string; kind: 'build' | 'ask' | 'design'; title: string; slug?: string; url: string; createdAt: number; watch: boolean;
  owner?: { session: string; pane?: string; pid?: number; cwd?: string };
  expect?: unknown; mirror?: string; stage?: unknown; round?: number;
  last?: unknown; question?: string; stoppedAt?: number; lastMsgCount?: number; polledAt?: number; signedOffAt?: number;
  events?: Array<{ at: number; text: string }>;
}
type Row = typeof devinSessions.$inferSelect;

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(s: string | null): T | undefined => { if (s === null) return undefined; try { return JSON.parse(s) as T; } catch { return undefined; } };
const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toRow(s: DevinRecord): typeof devinSessions.$inferInsert {
  if (typeof s.id !== 'string' || !s.id || s.id.length > 128) throw new Error('invalid devin session id');
  return {
    id: s.id, kind: s.kind, title: s.title, slug: s.slug ?? null, url: s.url, created_at: s.createdAt, watch: s.watch ? 1 : 0,
    owner_session: s.owner?.session ?? null, owner_pane: s.owner?.pane ?? null, owner_pid: s.owner?.pid ?? null, owner_cwd: s.owner?.cwd ?? null,
    expect: json(s.expect), mirror: s.mirror ?? null, stage: json(s.stage), round: s.round ?? null, last: json(s.last),
    question: s.question ?? null, stopped_at: s.stoppedAt ?? null, last_msg_count: s.lastMsgCount ?? null, polled_at: s.polledAt ?? null, signed_off_at: s.signedOffAt ?? null,
  };
}
function fromRow(r: Row, events: Array<{ at: number; text: string }>): DevinRecord {
  return {
    id: r.id, kind: r.kind, title: r.title, slug: opt(r.slug), url: r.url, createdAt: r.created_at, watch: r.watch === 1,
    owner: r.owner_session ? { session: r.owner_session, pane: opt(r.owner_pane), pid: opt(r.owner_pid), cwd: opt(r.owner_cwd) } : undefined,
    expect: parse(r.expect), mirror: opt(r.mirror), stage: parse(r.stage), round: opt(r.round), last: parse(r.last),
    question: opt(r.question), stoppedAt: opt(r.stopped_at), lastMsgCount: opt(r.last_msg_count), polledAt: opt(r.polled_at), signedOffAt: opt(r.signed_off_at),
    events,
  };
}

/** Insert or replace every column of ONE row. Owner scoping is the caller's: a process writes only the rows it owns. */
export function upsertDevin(db: NodeSQLiteDatabase, s: DevinRecord): void {
  const row = toRow(s);
  const { id: _id, ...set } = row;
  db.insert(devinSessions).values(row).onConflictDoUpdate({ target: devinSessions.id, set }).run();
}
/** The import path: a row that already exists is left exactly as it is. */
export function insertDevinIfAbsent(db: NodeSQLiteDatabase, s: DevinRecord): boolean {
  return db.insert(devinSessions).values(toRow(s)).onConflictDoNothing({ target: devinSessions.id }).run().changes === 1;
}
export function appendDevinEvent(db: NodeSQLiteDatabase, sessionId: string, at: number, text: string): void {
  if (typeof text !== 'string' || !text || text.length > 4000) throw new Error('invalid devin event');
  db.insert(devinEvents).values({ session_id: sessionId, at, text }).run();
}
/** Stamps once: a second sign-off (or an unknown id) changes nothing and says so. */
export function signOffDevin(db: NodeSQLiteDatabase, id: string, at: number): boolean {
  return db.update(devinSessions).set({ signed_off_at: at }).where(and(eq(devinSessions.id, id), isNull(devinSessions.signed_off_at))).run().changes === 1;
}
export function listDevin(db: NodeSQLiteDatabase): DevinRecord[] {
  const rows = db.select().from(devinSessions).orderBy(asc(devinSessions.created_at)).all();
  const events = db.select().from(devinEvents).orderBy(asc(devinEvents.id)).all();
  const by = new Map<string, Array<{ at: number; text: string }>>();
  for (const e of events) { const l = by.get(e.session_id) ?? []; l.push({ at: e.at, text: e.text }); by.set(e.session_id, l); }
  return rows.map((r) => fromRow(r, by.get(r.id) ?? []));
}
export const devinTableCount = (db: NodeSQLiteDatabase): number => db.select({ n: sql<number>`count(*)` }).from(devinSessions).get()!.n;
