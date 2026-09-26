import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_VERSION, MEMBERSHIP_TRIGGER, TIMELINE_VIEW, agents, crews, members, meta } from './schema.ts';
import { SCHEMA_SQL } from './schema-ddl.ts';
import { drizzle, type NodeSQLiteDatabase } from '../../npm/crew/node_modules/drizzle-orm/node-sqlite/index.js';
import { eq, and, isNull, sql, DrizzleQueryError } from '../../npm/crew/node_modules/drizzle-orm/index.js';
import { persistUsage, persistCompaction, enrichCompaction, summarizeUsage, type UsageFrame, type CompactionFrame, type CompactionEnrichment, type UsageSummary } from './usage.ts';
import { insertConsult, setConsultPacket, appendConsultTurn, settleConsult, selectConsults, type ConsultTurn, type ConsultAsk, type ConsultSettle, type ConsultRecord, type ConsultFilter, vetoConsult } from './consults.ts';
import { appendDevinEvent, insertDevinIfAbsent, listDevin, signOffDevin, upsertDevin, type DevinRecord } from './devin.ts';

export function agentDbPath(agentRoot: string): string {
  return join(agentRoot, 'state', 'agent.sqlite');
}

export type AgentId = `agent_${number}`;
export type CrewId = `crew_${number}`;
export type Owner = Readonly<{ agentId: AgentId; instanceId: string; generation: number }>;
export type Agent = Readonly<{
  id: AgentId; kind: 'main' | 'worker' | 'governor'; name: string; profile: string | null;
  sessionId: string | null;
  predecessorId: AgentId | null; createdAt: number;
}>;
export type Crew = Readonly<{ id: CrewId; slug: string; goal: string; ownerId: AgentId; createdAt: number; closedAt: number | null; outcome: string | null }>;
type AgentRow = typeof agents.$inferSelect;
type CrewRow = typeof crews.$inferSelect;

// Lock waits run on the calling thread. Contention must fail rather than silently fork registry state.
const BUSY_TIMEOUT_MS = 100;
function text(value: string, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid ${name}`);
  return value;
}
function key(value: string, prefix: 'agent' | 'crew'): number {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[1-9][0-9]*$`).test(value)) throw new Error(`invalid ${prefix} ID`);
  const n = Number(value.slice(prefix.length + 1));
  if (!Number.isSafeInteger(n)) throw new Error(`invalid ${prefix} ID`);
  return n;
}
const agentId = (id: number): AgentId => `agent_${id}`;
const crewId = (id: number): CrewId => `crew_${id}`;
const agent = (r: AgentRow): Agent => ({
  id: agentId(r.id), kind: r.kind, name: r.name, profile: r.profile, sessionId: r.session_id,
  predecessorId: r.predecessor_id === null ? null : agentId(r.predecessor_id), createdAt: r.created_at,
});
const crew = (r: CrewRow): Crew => ({ id: crewId(r.id), slug: r.slug, goal: r.goal, ownerId: agentId(r.owner_id), createdAt: r.created_at, closedAt: r.closed_at ?? null, outcome: r.outcome ?? null });

class CrewStore {
  #db: DatabaseSync;
  #closed = false;
  #q: NodeSQLiteDatabase;
  readonly namespace: string;
  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#q = drizzle({ client: db });
    this.namespace = this.#q.select().from(meta).get()!.namespace;
  }

  ensureMain(sessionId: string): Agent {
    text(sessionId, 'session ID');
    return this.#tx(() => {
      this.#q.insert(agents).values({ kind: 'main', name: 'main', session_id: sessionId, created_at: Date.now() }).onConflictDoNothing({ target: agents.session_id }).run();
      const row = this.#q.select().from(agents).where(eq(agents.session_id, sessionId)).get()!;
      if (row.kind !== 'main') throw new Error('session belongs to a worker, not main');
      return agent(row);
    });
  }

  claimMain(id: AgentId, instanceId: string): Owner {
    text(instanceId, 'instance ID');
    return this.#tx(() => {
      const r = this.#agent(id);
      if (r.kind !== 'main') throw new Error('owner must be main');
      if (r.owner_instance !== null && r.owner_instance !== instanceId) throw new Error('main already owned by another instance');
      if (r.owner_instance === null) {
        this.#q.update(agents).set({ owner_instance: instanceId, generation: sql`${agents.generation} + 1` }).where(eq(agents.id, r.id)).run();
        r.generation += 1;
      }
      return { agentId: id, instanceId, generation: r.generation };
    });
  }

  /** A main row belongs to ONE session file, and one process runs a session file — so a lease held by another instance
   *  id for OUR session is always stale (an earlier extension instance that crashed, or pre-dated the shared slot).
   *  Take it over; the generation bump invalidates the stale Owner handle. */
  reclaimMain(id: AgentId, instanceId: string): Owner {
    text(instanceId, 'instance ID');
    return this.#tx(() => {
      const r = this.#agent(id);
      if (r.kind !== 'main') throw new Error('owner must be main');
      this.#q.update(agents).set({ owner_instance: instanceId, generation: sql`${agents.generation} + 1` }).where(eq(agents.id, r.id)).run();
      return { agentId: id, instanceId, generation: r.generation + 1 };
    });
  }

  releaseMain(h: Owner): void {
    this.#tx(() => {
      const r = this.#owner(h);
      this.#q.update(agents).set({ owner_instance: null }).where(eq(agents.id, r.id)).run();
    });
  }

  createCrew(h: Owner, spec: { slug: string; goal: string }): Crew {
    text(spec.slug, 'slug'); text(spec.goal, 'goal', 512);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(spec.slug)) throw new Error('invalid slug');
    return this.#tx(() => {
      const main = this.#owner(h);
      return this.#insertCrew(main.id, spec.slug, spec.goal);
    });
  }

  resolveCrew(h: Owner, ref: string): Crew {
    text(ref, 'crew reference');
    return this.#tx(() => {
      const main = this.#owner(h);
      return this.#findCrew(main, ref) ?? this.#insertCrew(main.id, ref, ref);
    });
  }

  findCrew(h: Owner, ref: string): Crew | undefined {
    text(ref, 'crew reference');
    return this.#findCrew(this.#owner(h), ref);
  }

  /** Every crew in the database, any owner — the console's list (read-only). */
  listCrews(): Crew[] { return this.#q.select().from(crews).orderBy(crews.id).all().map(crew); }
  /** Main declares the end: idempotent, first close wins (a later call keeps the original outcome). */
  closeCrew(id: CrewId, outcome: string, at = Date.now()): Crew {
    this.#q.update(crews).set({ closed_at: at, outcome }).where(and(eq(crews.id, key(id, 'crew')), isNull(crews.closed_at))).run();
    const row = this.#q.select().from(crews).where(eq(crews.id, key(id, 'crew'))).get(); if (!row) throw new Error(`unknown crew ${id}`);
    return crew(row);
  }

  ownedCrews(h: Owner): Crew[] {
    const main = this.#owner(h);
    return this.#q.select().from(crews).where(eq(crews.owner_id, main.id)).orderBy(crews.id).all().map(crew);
  }
  /** Owned and not closed — the runs whose room a main should still attach to. */
  openCrews(h: Owner): Crew[] { return this.ownedCrews(h).filter(c => c.closedAt === null); }

  addMainMember(h: Owner, id: CrewId, mainId: AgentId): void {
    this.#tx(() => {
      const c = this.#ownedCrew(h, id), main = this.#agent(mainId);
      if (main.kind !== 'main') throw new Error('member must be main');
      this.#q.insert(members).values({ crew_id: c.id, agent_id: main.id }).onConflictDoNothing().run();
    });
  }

  registerWorker(h: Owner, id: CrewId, spec: {
    name: string; profile: string; kind?: 'worker' | 'governor'; predecessorId?: AgentId;
  }): Agent {
    text(spec.name, 'name'); text(spec.profile, 'profile');
    const kind = spec.kind ?? 'worker';
    if (kind !== 'worker' && kind !== 'governor') throw new Error('invalid worker kind');
    return this.#tx(() => {
      const c = this.#ownedCrew(h, id);
      let previous: AgentRow | undefined;
      if (spec.predecessorId !== undefined) {
        previous = this.#worker(id, spec.predecessorId);
      }
      const inserted = this.#q.insert(agents).values({ kind, name: spec.name, profile: spec.profile, predecessor_id: previous?.id ?? null, created_at: Date.now() }).returning({ id: agents.id }).get();
      const newId = inserted.id;
      this.#q.insert(members).values({ crew_id: c.id, agent_id: newId }).run();
      return this.getAgent(agentId(newId));
    });
  }

  bindWorkerSession(h: Owner, id: CrewId, workerId: AgentId, sessionId: string): Agent {
    text(sessionId, 'execution session ID');
    return this.#tx(() => {
      this.#ownedCrew(h, id);
      const w = this.#worker(id, workerId);
      if (w.session_id !== null && w.session_id !== sessionId) throw new Error('worker execution cannot be rebound');
      this.#q.update(agents).set({ session_id: sessionId }).where(eq(agents.id, w.id)).run();
      return this.getAgent(workerId);
    });
  }

  recordUsage(h: Owner, actorId: AgentId, crewId: CrewId | null, frame: UsageFrame): void {
    this.#tx(() => {
      const main = this.#owner(h), actor = this.#agent(actorId);
      if (actor.kind === 'main') {
        if (actor.id !== main.id) throw new Error('usage belongs to another owner');
        if (crewId !== null) throw new Error('main usage must remain shared, not charged to one crew');
      } else {
        if (crewId === null) throw new Error('worker usage requires a crew');
        this.#ownedCrew(h, crewId); this.#worker(crewId, actorId);
      }
      persistUsage(this.#q, actor.id, crewId === null ? null : key(crewId, 'crew'), frame);
    });
  }
  /** Worker/governor self-reporting: no Owner claim — the agent attributes its own frames; crew derives from membership. */
  recordWorkerUsage(actorId: AgentId, frame: UsageFrame): void {
    this.#tx(() => {
      const actor = this.#agent(actorId);
      if (actor.kind === 'main') throw new Error('main usage requires an owner claim');
      const membership = this.#q.select().from(members).where(eq(members.agent_id, actor.id)).get();
      persistUsage(this.#q, actor.id, membership?.crew_id ?? null, frame);
    });
  }
  recordWorkerCompaction(actorId: AgentId, frame: CompactionFrame): void {
    this.#tx(() => {
      const actor = this.#agent(actorId);
      if (actor.kind === 'main') throw new Error('main compactions require an owner claim');
      persistCompaction(this.#q, actor.id, frame);
    });
  }
  recordCompaction(h: Owner, frame: CompactionFrame): void {
    this.#tx(() => {
      const main = this.#owner(h);
      persistCompaction(this.#q, main.id, frame);
    });
  }
  enrichCompaction(h: Owner, e: CompactionEnrichment): boolean {
    return this.#tx(() => enrichCompaction(this.#q, this.#owner(h).id, e));
  }
  enrichWorkerCompaction(actorId: AgentId, e: CompactionEnrichment): boolean {
    return this.#tx(() => enrichCompaction(this.#q, this.#agent(actorId).id, e));
  }
  usageSummary(crewId?: CrewId): UsageSummary {
    return summarizeUsage(this.#q, crewId === undefined ? null : this.#crew(crewId).id);
  }

  getAgent(id: AgentId): Agent { return agent(this.#agent(id)); }
  getCrew(id: CrewId): Crew { return crew(this.#crew(id)); }
  /** Main records every consult the moment it is classified — human, governor or pre-authorized alike. */
  openConsult(id: CrewId, ask: ConsultAsk): void { this.#crew(id); insertConsult(this.#q, key(id, 'crew'), ask); }
  /** true = this call closed it; false = someone else already had (the row is unchanged). */
  setConsultPacket(crewId: CrewId, id: string, packet: Record<string, unknown>): boolean { return setConsultPacket(this.#q, this.#crew(crewId).id, id, packet); }
  appendConsultTurn(crewId: CrewId, id: string, turn: ConsultTurn): boolean { return appendConsultTurn(this.#q, this.#crew(crewId).id, id, turn); }
  answerConsult(id: CrewId, consultId: string, s: ConsultSettle): boolean { return settleConsult(this.#q, key(id, 'crew'), consultId, s); }
  vetoConsult(id: CrewId, consultId: string, at = Date.now()): boolean { return vetoConsult(this.#q, key(id, 'crew'), consultId, at); }
  withdrawConsult(id: CrewId, consultId: string, reason: string, at = Date.now()): boolean {
    return settleConsult(this.#q, key(id, 'crew'), consultId, { by: `withdrawn:${reason}`, choice: null, answer: reason, at }, 'withdrawn');
  }
  openConsults(id?: CrewId): ConsultRecord[] { return selectConsults(this.#q, { run: id, state: 'open' }); }
  consult(run: CrewId, consultId: string): ConsultRecord | undefined { return selectConsults(this.#q, { run, id: consultId, limit: 1 })[0]; }
  consultHistory(f: ConsultFilter = {}): ConsultRecord[] { return selectConsults(this.#q, f); }

  /** D97 — Devin sessions: shared rows, owner-scoped writes by convention, no owner handle needed (metadata, not identity). */
  devinUpsert(s: DevinRecord): void { this.#tx(() => upsertDevin(this.#q, s)); }
  devinInsertIfAbsent(s: DevinRecord): boolean { return this.#tx(() => insertDevinIfAbsent(this.#q, s)); }
  devinEvent(sessionId: string, at: number, text: string): void { this.#tx(() => appendDevinEvent(this.#q, sessionId, at, text)); }
  devinSignOff(id: string, at = Date.now()): boolean { return this.#tx(() => signOffDevin(this.#q, id, at)); }
  devinList(): DevinRecord[] { return listDevin(this.#q); }

  listMembers(id: CrewId): Agent[] {
    const c = this.#crew(id);
    return this.#q.select({ actor: agents }).from(agents).innerJoin(members, eq(agents.id, members.agent_id))
      .where(eq(members.crew_id, c.id)).orderBy(agents.id).all().map(r => agent(r.actor));
  }
  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }

  #findCrew(main: AgentRow, ref: string): Crew | undefined {
    if (/^crew_[0-9]+$/.test(ref)) {
      const c = this.#crew(ref as CrewId);
      if (c.owner_id !== main.id) throw new Error('crew owner mismatch');
      return crew(c);
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(ref)) throw new Error('invalid crew slug');
    const rows = this.#q.select().from(crews).where(and(eq(crews.owner_id, main.id), eq(crews.slug, ref))).limit(2).all();
    if (rows.length > 1) throw new Error(`ambiguous crew slug "${ref}"; use its crew_N ID`);
    return rows.length ? crew(rows[0]) : undefined;
  }
  #insertCrew(ownerId: number, slug: string, goal: string): Crew {
    const { id } = this.#q.insert(crews).values({ slug, goal, owner_id: ownerId, created_at: Date.now() }).returning({ id: crews.id }).get();
    this.#q.insert(members).values({ crew_id: id, agent_id: ownerId }).run();
    return this.getCrew(crewId(id));
  }
  #agent(id: AgentId): AgentRow {
    const r = this.#q.select().from(agents).where(eq(agents.id, key(id, 'agent'))).get();
    if (!r) throw new Error('unknown agent ID');
    return r;
  }
  #crew(id: CrewId): CrewRow {
    const r = this.#q.select().from(crews).where(eq(crews.id, key(id, 'crew'))).get();
    if (!r) throw new Error('unknown crew ID');
    return r;
  }
  #owner(h: Owner): AgentRow {
    const r = this.#agent(h.agentId);
    if (r.kind !== 'main' || r.owner_instance === null || r.owner_instance !== h.instanceId || r.generation !== h.generation)
      throw new Error('stale or invalid owner');
    return r;
  }
  #ownedCrew(h: Owner, id: CrewId): CrewRow {
    const main = this.#owner(h), c = this.#crew(id);
    if (c.owner_id !== main.id) throw new Error('crew belongs to another owner');
    return c;
  }
  #worker(id: CrewId, workerId: AgentId): AgentRow {
    const w = this.#agent(workerId);
    if (w.kind === 'main') throw new Error('agent is not a worker');
    const membership = this.#q.select().from(members).where(and(eq(members.crew_id, key(id, 'crew')), eq(members.agent_id, w.id))).get();
    if (!membership) throw new Error('worker is not a crew member');
    return w;
  }
  #tx<T>(fn: () => T): T {
    try { return this.#q.transaction(() => ({ value: fn() }), { behavior: 'immediate' }).value; }
    catch (error) { throw error instanceof DrizzleQueryError && error.cause ? error.cause : error; }
  }
}

export function openCrewStore(path: string): CrewStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (!tables.length) {
        db.exec(SCHEMA_SQL + MEMBERSHIP_TRIGGER);
        drizzle({ client: db }).insert(meta).values({ version: SCHEMA_VERSION }).run();
      }
      else {
        if (!tables.some(t => t.name === 'crew_meta')) throw new Error('unrecognized database schema');
        const versions = db.prepare('SELECT * FROM crew_meta').all();
        if (versions.length !== 1 || !/^[0-9a-f]{32}$/.test(String(versions[0].namespace))) throw new Error('unsupported crew schema version');
        if (versions[0].version === 2) {
          // v2→v3 rebuilds the telemetry tables (no data worth keeping); registry tables are untouched.
          db.exec('DROP TABLE IF EXISTS `model_calls`');
          const telemetry = SCHEMA_SQL.split(';\n').filter(s => s.includes('`model_calls`') || s.includes('`compactions`') || s.includes('compactions_by_agent'));
          if (telemetry.length < 2) throw new Error('v3 migration could not locate telemetry DDL');
          db.exec(telemetry.join(';\n') + ';');
          db.prepare('UPDATE crew_meta SET version = ?').run(3);
          versions[0].version = 3;
        }
        if (versions[0].version === 3) {
          // v3→v4: one additive column; every existing row was a landed compaction.
          db.exec('ALTER TABLE `compactions` ADD COLUMN `applied` integer NOT NULL DEFAULT 1');
          db.prepare('UPDATE crew_meta SET version = ?').run(4);
          versions[0].version = 4;
        }
        if (versions[0].version === 4) {
          // v4→v5: two additive columns, both null for history. Pre-v5 background rows carry the
          // post-splice ledger in `summary_tokens` (enrichment used to overwrite it) — they are NOT
          // comparable with v5 rows, and no backfill can separate summary from kept tail after the fact.
          db.exec('ALTER TABLE `compactions` ADD COLUMN `tokens_after` integer');
          db.exec('ALTER TABLE `compactions` ADD COLUMN `model` text');
          db.prepare('UPDATE crew_meta SET version = ?').run(5);
          versions[0].version = 5;
        }
        if (versions[0].version === 5) {
          // v5→v7: one new table (the consult record), created in its CURRENT shape; nothing existing changes.
          const ddl = SCHEMA_SQL.split(';\n').filter(s => s.includes('`consults`'));
          if (ddl.length < 3) throw new Error('consults migration could not locate its DDL');
          db.exec(ddl.join(';\n') + ';');
          db.prepare('UPDATE crew_meta SET version = ?').run(SCHEMA_VERSION);
          versions[0].version = SCHEMA_VERSION;
        }
        if (versions[0].version === 6) {
          // v6→v7: two additive nullable columns (v6 lived for one afternoon on this machine).
          db.exec('ALTER TABLE `consults` ADD COLUMN `follow_up_of` text');
          db.exec('ALTER TABLE `consults` ADD COLUMN `reply` text');
          db.prepare('UPDATE crew_meta SET version = ?').run(7);
          versions[0].version = 7;
        }
        if (versions[0].version === 7) {
          // v7→v8: the consult thread (one act, many exchanges) — additive nullable column.
          db.exec('ALTER TABLE `consults` ADD COLUMN `thread` text');
          db.prepare('UPDATE crew_meta SET version = ?').run(8);
          versions[0].version = 8;
        }
        if (versions[0].version === 8) {
          // v8→v9: a crew's end is declared by main (crew_close), not inferred from liveness — additive nullable columns.
          db.exec('ALTER TABLE `crews` ADD COLUMN `closed_at` integer');
          db.exec('ALTER TABLE `crews` ADD COLUMN `outcome` text');
          db.prepare('UPDATE crew_meta SET version = ?').run(9);
          versions[0].version = 9;
        }
        if (versions[0].version === 9) {
          // v9→v10 (D97): two new tables for Devin sessions, created in their current shape; the sessions table first — events reference it.
          const ddl = SCHEMA_SQL.split(';\n').filter(s => s.includes('devin')).sort((a, b) => Number(a.includes('`devin_events`')) - Number(b.includes('`devin_events`')));
          if (ddl.length < 4) throw new Error('devin migration could not locate its DDL');
          db.exec(ddl.join(';\n') + ';');
          db.prepare('UPDATE crew_meta SET version = ?').run(SCHEMA_VERSION);
        }
        const now = db.prepare('SELECT version FROM crew_meta').get() as { version: number };
        if (now.version !== SCHEMA_VERSION) throw new Error('unsupported crew schema version');
      }
      db.exec('DROP VIEW IF EXISTS timeline'); db.exec(TIMELINE_VIEW);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.exec('PRAGMA journal_mode = WAL');
    return new CrewStore(db);
  } catch (error) { db.close(); throw error; }
}
