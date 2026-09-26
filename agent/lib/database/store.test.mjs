import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCrewStore } from './store.ts';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema-ddl.ts';
import { SCHEMA_VERSION } from './schema.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crew-store-'));
  const path = join(root, 'crew.sqlite');
  const stores = [];
  const open = () => { const s = openCrewStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, open, store: open() };
}
function owner(s, session = 'main-session', instance = 'instance-a') {
  const main = s.ensureMain(session);
  return s.claimMain(main.id, instance);
}
function crew(s, h, slug = 'same-slug') {
  return s.createCrew(h, { slug, goal: 'Exercise registry semantics' });
}
const worker = { name: 'reviewer', profile: 'reviewer' };

test('one main session keeps its identity across crews, connections and reopen', t => {
  const { store: s, open } = fixture(t);
  const main = s.ensureMain('session-a');
  assert.equal(s.ensureMain('session-a').id, main.id);
  const h = s.claimMain(main.id, 'runtime');
  const a = crew(s, h), b = crew(s, h);
  assert.notEqual(a.id, b.id);
  assert.equal(a.slug, b.slug, 'a slug is a label, not an identity lookup');
  assert.deepEqual(s.listMembers(a.id).map(x => x.id), [main.id]);
  assert.deepEqual(s.listMembers(b.id).map(x => x.id), [main.id]);
  s.close();
  const reopened = open();
  assert.equal(reopened.ensureMain('session-a').id, main.id);
  assert.equal(reopened.getCrew(a.id).ownerId, main.id);
  assert.notEqual(reopened.ensureMain('fork-session').id, main.id, 'new session control');
});

test('agent IDs are global across crews and connections, not names or local counters', t => {
  const { store: a, open } = fixture(t), b = open();
  const h = owner(a), c1 = crew(a, h), c2 = crew(b, h);
  const w1 = a.registerWorker(h, c1.id, worker);
  const w2 = b.registerWorker(h, c2.id, worker);
  assert.match(c1.id, /^crew_[1-9][0-9]*$/);
  assert.match(w1.id, /^agent_[1-9][0-9]*$/);
  assert.equal(new Set([h.agentId, w1.id, w2.id]).size, 3);
  assert.equal(w1.name, w2.name);
  assert.equal(a.listMembers(c1.id).length, 2);
  assert.equal(a.listMembers(c2.id).length, 2);
});

test('registration precedes execution, duplicate start is idempotent and rebinding is refused', t => {
  const { store: s } = fixture(t), h = owner(s), c = crew(s, h);
  const w = s.registerWorker(h, c.id, worker);
  assert.equal('state' in w, false);
  assert.equal(w.sessionId, null);
  assert.equal(s.getAgent(w.id).sessionId, null);
  assert.equal(s.bindWorkerSession(h, c.id, w.id, 'worker-session').sessionId, 'worker-session');
  assert.equal(s.bindWorkerSession(h, c.id, w.id, 'worker-session').id, w.id);
  assert.throws(() => s.bindWorkerSession(h, c.id, w.id, 'different-session'), /execution|running/);
  assert.equal(s.getAgent(w.id).sessionId, 'worker-session');
});

test('replacement is linked without requiring a reliably recorded predecessor end', t => {
  const { store: s } = fixture(t), h = owner(s), c = crew(s, h);
  const w = s.registerWorker(h, c.id, worker);
  s.bindWorkerSession(h, c.id, w.id, 'predecessor-session');
  const replacement = s.registerWorker(h, c.id, { ...worker, predecessorId: w.id });
  assert.notEqual(replacement.id, w.id);
  assert.equal(replacement.predecessorId, w.id);
  assert.equal(s.getAgent(w.id).sessionId, 'predecessor-session');
  assert.equal(s.getAgent(replacement.id).sessionId, null);
  assert.equal('state' in replacement, false);
});

test('different main owners cannot mutate each other; failures leave membership unchanged', t => {
  const { store: s } = fixture(t), a = owner(s, 'a', 'a-runtime'), b = owner(s, 'b', 'b-runtime');
  const ca = crew(s, a), cb = crew(s, b), w = s.registerWorker(a, ca.id, worker);
  assert.throws(() => s.registerWorker(b, ca.id, worker), /owner/);
  assert.throws(() => s.bindWorkerSession(b, ca.id, w.id, 'forged'), /owner/);
  assert.equal(s.listMembers(ca.id).length, 2);
  assert.equal(s.getAgent(w.id).sessionId, null);
  assert.equal(s.registerWorker(b, cb.id, worker).sessionId, null, 'legitimate owner control');
});

test('owner release/reclaim fences old callbacks even when the instance label is reused', t => {
  const { store: s, open } = fixture(t), h = owner(s), c = crew(s, h);
  assert.deepEqual(s.claimMain(h.agentId, h.instanceId), h, 'same live instance is idempotent');
  assert.throws(() => open().claimMain(h.agentId, 'other-live-instance'), /owned/);
  s.releaseMain(h);
  const next = s.claimMain(h.agentId, h.instanceId);
  assert.ok(next.generation > h.generation);
  assert.throws(() => s.createCrew(h, { slug: 'stale', goal: 'stale callback' }), /stale/);
  assert.throws(() => s.releaseMain(h), /stale/);
  assert.throws(() => s.registerWorker(h, c.id, worker), /stale/);
  assert.equal(s.registerWorker(next, c.id, worker).sessionId, null, 'new owner control');
});

test('membership does not make a main the owner; a worker cannot join as main', t => {
  const { store: s } = fixture(t), h = owner(s), other = owner(s, 'other', 'other-runtime'), c = crew(s, h);
  s.addMainMember(h, c.id, other.agentId);
  s.addMainMember(h, c.id, other.agentId);
  assert.equal(s.listMembers(c.id).length, 2);
  assert.throws(() => s.registerWorker(other, c.id, worker), /owner/);
  const w = s.registerWorker(h, c.id, worker);
  assert.throws(() => s.addMainMember(h, c.id, w.id), /main/);
  assert.equal(s.listMembers(c.id).length, 3);
});

test('predecessor must be a worker in the same crew', t => {
  const { store: s } = fixture(t), h = owner(s), c1 = crew(s, h), c2 = crew(s, h);
  const w = s.registerWorker(h, c1.id, worker);
  assert.throws(() => s.registerWorker(h, c2.id, { ...worker, predecessorId: w.id }), /member|crew/);
  assert.equal(s.listMembers(c2.id).length, 1);
  assert.throws(() => s.registerWorker(h, c1.id, { ...worker, predecessorId: h.agentId }), /worker/);
});

test('worker mutations require the actual crew binding, including for the same owner', t => {
  const { store: s } = fixture(t), h = owner(s), a = crew(s, h), b = crew(s, h);
  const w = s.registerWorker(h, a.id, worker);
  assert.throws(() => s.bindWorkerSession(h, b.id, w.id, 'wrong-crew'), /member|crew/);
  assert.throws(() => s.bindWorkerSession(h, a.id, h.agentId, 'not-worker'), /worker/);
  assert.equal(s.getAgent(w.id).sessionId, null);
});

test('invalid IDs are refused without changing valid records', t => {
  const { store: s } = fixture(t), h = owner(s), c = crew(s, h), w = s.registerWorker(h, c.id, worker);
  for (const bad of ['agent_0', 'agent_01', 'agent_-1', 'agent_9007199254740992', 'crew_1', "agent_1 OR 1=1"]) {
    assert.throws(() => s.getAgent(bad), /ID/);
  }
  assert.equal(s.getAgent(w.id).sessionId, null);
});

async function parallel(t, data) {
  const { Worker } = await import('node:worker_threads');
  const workers = data.map(workerData => new Worker(new URL('./concurrency.fixture.mjs', import.meta.url), { workerData }));
  t.after(() => Promise.all(workers.map(w => w.terminate())));
  const ready = workers.map(w => new Promise((resolve, reject) => {
    w.once('error', reject); w.once('message', m => m.ready ? resolve() : reject(new Error('missing ready')));
    w.once('exit', code => { if (code) reject(new Error(`worker exit ${code}`)); });
  }));
  await Promise.all(ready);
  const results = workers.map(w => new Promise((resolve, reject) => {
    w.once('error', reject); w.once('message', resolve);
    w.once('exit', code => { if (code) reject(new Error(`worker exit ${code}`)); });
  }));
  for (const w of workers) w.postMessage('go');
  return Promise.all(results);
}

test('simultaneous connections allocate unique global IDs and the same main mapping', { timeout: 10000 }, async t => {
  const { path, store: s } = fixture(t), h = owner(s);
  const results = await parallel(t, Array.from({ length: 4 }, () => ({ path, owner: h })));
  assert.deepEqual([...new Set(results.map(r => r.main))], [h.agentId]);
  const ids = results.flatMap(r => r.ids);
  assert.equal(new Set(ids.map(r => r.crew)).size, 32);
  assert.equal(new Set(ids.map(r => r.agent)).size, 32);
  assert.equal(s.getAgent(h.agentId).kind, 'main');
});

test('simultaneous competing main claims have one winner, not last-writer ownership', { timeout: 10000 }, async t => {
  const { path, store: s } = fixture(t), main = s.ensureMain('shared-session');
  const results = await parallel(t, Array.from({ length: 4 }, (_, i) => ({ path, mode: 'claim', agentId: main.id, instanceId: `instance-${i}` })));
  assert.equal(results.filter(r => r.owner).length, 1);
  assert.equal(results.filter(r => r.refused).length, 3);
  const winner = results.find(r => r.owner).owner;
  assert.equal(crew(s, winner).ownerId, main.id);
});

test('bounded lock contention leaves no partial registration and unrelated reads work', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { path, store: s } = fixture(t), h = owner(s), c = crew(s, h);
  const blocker = new DatabaseSync(path);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const start = performance.now();
    assert.throws(() => s.registerWorker(h, c.id, worker), /locked|busy/);
    assert.ok(performance.now() - start < 1000, 'bounded lock failure, not indefinite UI blocking');
    assert.equal(s.listMembers(c.id).length, 1, 'WAL reader and unchanged membership control');
    blocker.exec('ROLLBACK');
    assert.equal(s.registerWorker(h, c.id, worker).sessionId, null);
  } finally { blocker.close(); }
});

test('a membership failure rolls back crew creation, not just its membership row', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { path, store: s } = fixture(t), h = owner(s), existing = crew(s, h);
  const db = new DatabaseSync(path);
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM crews').get().n;
    db.exec("CREATE TRIGGER reject_membership BEFORE INSERT ON crew_members BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => crew(s, h), /injected failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crews').get().n, before);
    assert.equal(s.listMembers(existing.id).length, 1);
    db.exec('DROP TRIGGER reject_membership');
    assert.notEqual(crew(s, h).id, existing.id);
  } finally { db.close(); }
});

test('unknown schemas are refused without adding tables or holding a transaction', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(tmpdir(), 'crew-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const ddl of ['CREATE TABLE legacy_data(value TEXT)', 'CREATE TABLE crew_meta(version INTEGER); INSERT INTO crew_meta VALUES(999)']) {
    const path = join(root, `db-${Math.random()}.sqlite`), db = new DatabaseSync(path);
    try {
      db.exec(ddl);
      const before = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
      const journalHeader = readFileSync(path).subarray(18, 20);
      assert.throws(() => openCrewStore(path), /schema/);
      assert.deepEqual(readFileSync(path).subarray(18, 20), journalHeader, 'refusal must not change persistent journal mode');
      assert.deepEqual(db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(), before);
      db.exec('BEGIN EXCLUSIVE; ROLLBACK');
    } finally { db.close(); }
  }
});

test('execution identity conflicts roll back and cannot turn a worker into main', t => {
  const { store: s } = fixture(t), h = owner(s), c = crew(s, h), w = s.registerWorker(h, c.id, worker);
  assert.throws(() => s.bindWorkerSession(h, c.id, w.id, 'main-session'), /UNIQUE/);
  assert.equal(s.getAgent(w.id).sessionId, null);
  assert.equal(s.getAgent(w.id).sessionId, null);
  s.bindWorkerSession(h, c.id, w.id, 'worker-session');
  assert.throws(() => s.ensureMain('worker-session'), /worker/);
  assert.equal(s.getAgent(w.id).kind, 'worker');
});


test('database stores identities, not a second lifecycle state or presence registry', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { path, store: s } = fixture(t), h = owner(s), c = crew(s, h);
  const w = s.registerWorker(h, c.id, worker);
  const db = new DatabaseSync(path);
  try {
    const columns = db.prepare('PRAGMA table_info(agents)').all().map(r => r.name);
    assert.equal(columns.includes('state'), false, 'lifecycle state belongs in room events, not SQLite');
    assert.equal(columns.includes('presence'), false);
    assert.equal(columns.includes('ended_at'), false);
    assert.equal('state' in s.getAgent(w.id), false);
    assert.equal(typeof s.endWorker, 'undefined', 'ending an execution is a runtime/event operation');
    assert.equal(s.getAgent(h.agentId).sessionId, 'main-session', 'identity control');
  } finally { db.close(); }
});

test('run labels resolve only within their owner and explicit IDs never alias another crew', t => {
  const { store: s } = fixture(t), a = owner(s, 'a', 'a-runtime'), b = owner(s, 'b', 'b-runtime');
  const ca = s.resolveCrew(a, 'shared-label'), cb = s.resolveCrew(b, 'shared-label');
  assert.notEqual(ca.id, cb.id);
  assert.equal(s.resolveCrew(a, 'shared-label').id, ca.id);
  assert.equal(s.resolveCrew(a, ca.id).id, ca.id);
  assert.throws(() => s.resolveCrew(b, ca.id), /owner/);
  assert.throws(() => s.resolveCrew(a, 'crew_999999'), /unknown/);
  assert.deepEqual(s.ownedCrews(a).map(c => c.id), [ca.id]);
  assert.deepEqual(s.ownedCrews(b).map(c => c.id), [cb.id]);
  const duplicate = s.createCrew(a, { slug: 'shared-label', goal: 'An explicit separate crew' });
  assert.throws(() => s.resolveCrew(a, 'shared-label'), /ambiguous/);
  assert.equal(s.resolveCrew(a, duplicate.id).id, duplicate.id);
});

test('a fresh database has a distinct namespace so reset IDs cannot reuse old room history', t => {
  const a = fixture(t), b = fixture(t);
  assert.match(a.store.namespace, /^[0-9a-f]{32}$/);
  assert.notEqual(a.store.namespace, b.store.namespace);
  const old = a.store.namespace;
  a.store.close();
  assert.equal(a.open().namespace, old);
});

test('usage is deduplicated, unknown stays unknown, and shared main cost is not charged to every crew', t => {
  const { store: s } = fixture(t), h = owner(s), a = crew(s, h), b = crew(s, h);
  const wa = s.registerWorker(h, a.id, worker), wb = s.registerWorker(h, b.id, worker);
  const call = { phase: 'call', turnKey: 'worker-a-turn', sessionId: 'worker-a-session', startedAt: 10, at: 20,
    provider: 'test', model: 'small', stopReason: 'stop', input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, estimatedCost: 0.01 };
  s.recordUsage(h, wa.id, a.id, call);
  s.recordUsage(h, wa.id, a.id, call);
  s.recordUsage(h, wa.id, a.id, { ...call, phase: 'end', at: 30, toolCount: 2 });
  s.recordUsage(h, wb.id, b.id, { ...call, turnKey: 'worker-b-turn', sessionId: 'worker-b-session', stopReason: 'error', totalTokens: null, estimatedCost: null });
  s.recordUsage(h, h.agentId, null, { ...call, turnKey: 'main-turn', sessionId: 'main-session', model: 'large', totalTokens: 20, estimatedCost: 0.03 });
  assert.equal(s.usageSummary(a.id).totals.calls, 1, 'pi invariant: one assistant call per turn; duplicates dedup');
  assert.equal(s.usageSummary(a.id).totals.totalTokens, 10);
  assert.equal(s.usageSummary(b.id).totals.totalTokens, null);
  const all = s.usageSummary();
  assert.equal(all.totals.calls, 3);
  assert.equal(all.totals.tokenKnownCalls, 2);
  assert.equal(all.totals.costKnownCalls, 2);
  assert.equal(all.totals.totalTokens, 30);
  assert.equal(all.totals.estimatedCost, 0.04);
  assert.equal(all.unclosedTurns, 2, 'unclosed records do not assert live processes');
});

test('usage writes enforce actor ownership and cannot reuse another actor turn key', t => {
  const { store: s } = fixture(t), a = owner(s, 'a', 'a-runtime'), b = owner(s, 'b', 'b-runtime');
  const ca = crew(s, a), cb = crew(s, b), w = s.registerWorker(a, ca.id, worker);
  const frame = { phase: 'start', turnKey: 't1', sessionId: 's1', startedAt: 10, at: 10 };
  assert.throws(() => s.recordUsage(b, w.id, ca.id, frame), /owner/);
  assert.throws(() => s.recordUsage(a, w.id, cb.id, frame), /owner/);
  assert.throws(() => s.recordUsage(a, w.id, null, frame), /crew/);
  s.recordUsage(a, w.id, ca.id, frame);
  assert.throws(() => s.recordUsage(b, b.agentId, null, frame), /identity conflict/);
  assert.equal(s.usageSummary().turns, 1);
});

test('usage whitelists metadata and invalid counters roll back their entire write', async t => {
  const { store: s, path } = fixture(t), h = owner(s);
  const frame = { phase: 'call', turnKey: 'safe', sessionId: 'main-session', startedAt: 10, at: 20,
    provider: 'test', model: 'small', stopReason: 'stop', totalTokens: 12,
    rawRequest: 'DO_NOT_STORE_REQUEST_PAYLOAD', rawResponse: 'DO_NOT_STORE_RESPONSE_PAYLOAD' };
  s.recordUsage(h, h.agentId, null, frame);
  assert.throws(() => s.recordUsage(h, h.agentId, null, { ...frame, turnKey: 'bad', totalTokens: -1 }), /count/);
  assert.equal(s.usageSummary().turns, 1);
  s.close();
  const bytes = readFileSync(path).toString('utf8');
  assert.equal(bytes.includes('DO_NOT_STORE_REQUEST_PAYLOAD'), false);
  assert.equal(bytes.includes('DO_NOT_STORE_RESPONSE_PAYLOAD'), false);
});

test('a v3 database migrates ALL THE WAY to the current version in place: history is kept, every additive column lands', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-store-v3-'));
  const path = join(root, 'agent.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Build a genuine v3 file: current DDL minus every column added after v3, stamped version 3.
  const v3 = new DatabaseSync(path);
  v3.exec(SCHEMA_SQL.replace(/\n\t`applied` integer DEFAULT 1 NOT NULL,/, '')
    .replace(/\n\t`tokens_after` integer,/, '').replace(/\n\t`model` text,\n\t`cost` real/, '\n\t`cost` real')
    .replace(/CREATE TABLE `consults` \([\s\S]*?\) STRICT;\n\n/, '').replace(/CREATE INDEX `consults_[a-z_]*` ON `consults` \([^)]*\);\n/g, ''));   // v3 predates consults (v6)
  v3.exec("INSERT INTO crew_meta (namespace, version) VALUES ('0123456789abcdef0123456789abcdef', 3)");
  v3.exec("INSERT INTO agents (kind, name, session_id, generation, created_at) VALUES ('main','main','s',1,1)");
  v3.exec("INSERT INTO compactions (agent_id, session_id, recorded_at, reason, from_extension, tokens_before, summary_tokens, cost) VALUES (1,'s',5,'manual',0,200000,7000,0.7)");
  for (const col of ['applied', 'tokens_after', 'model'])
    assert.equal(v3.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('compactions') WHERE name=?").get(col).n, 0, `fixture really is v3 (no ${col})`);
  v3.close();

  const store = openCrewStore(path);
  t.after(() => store.close());
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT version FROM crew_meta').get().version, SCHEMA_VERSION);
  const kept = db.prepare('SELECT applied, summary_tokens, tokens_after, model FROM compactions WHERE id = 1').get();
  assert.equal(kept.applied, 1, 'history was all landed compactions');
  assert.equal(kept.summary_tokens, 7000, 'the row survives the migration');
  // Pre-v5 background rows conflated summary with the post-splice ledger; nothing can separate them
  // after the fact, so the new columns stay null rather than being backfilled with a guess.
  assert.equal(kept.tokens_after, null);
  assert.equal(kept.model, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='consults'").get().n, 1, 'v6 table landed');
});

test('an applied background compaction enriches the freshly written row: trigger label replaces pi\'s "manual"; the post-splice ledger and model land in their OWN columns and the summary size survives', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-store-enrich-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openCrewStore(join(root, 'agent.sqlite'));
  t.after(() => store.close());
  const h = owner(store, 'sess-e');
  store.recordCompaction(h, { sessionId: 'sess-e', at: 1_000_000, reason: 'manual', fromExtension: true, tokensBefore: 193240, summaryTokens: 4773, cost: 0.46 });

  const hit = store.enrichCompaction(h, { sessionId: 'sess-e', at: 1_000_500, reason: 'threshold 200k', tokensAfter: 12915, model: 'claude-fable-5-1' });
  assert.equal(hit, true, 'the row within the window is found');
  const db = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const row = db.prepare("SELECT reason, summary_tokens, tokens_after, model, cost, applied FROM compactions WHERE session_id='sess-e'").get();
  assert.equal(row.reason, 'threshold 200k');
  // 4773 = what the summarizer actually emitted; 12915 = that summary PLUS the kept tail. Two quantities, two columns.
  assert.equal(row.summary_tokens, 4773, 'enrichment must not overwrite the summarizer output');
  assert.equal(row.tokens_after, 12915);
  assert.equal(row.model, 'claude-fable-5-1');
  assert.equal(row.cost, 0.46, 'cost untouched — billing is the insert\'s job');
  assert.equal(row.applied, 1);
});

test('enrichment never touches distant, dropped, or other-session rows', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-store-enrich2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openCrewStore(join(root, 'agent.sqlite'));
  t.after(() => store.close());
  const h = owner(store, 'sess-e2');
  // too old (outside the 15s window)
  store.recordCompaction(h, { sessionId: 'sess-e2', at: 1_000_000, reason: 'manual', fromExtension: true, tokensBefore: 1, summaryTokens: 1, cost: null });
  assert.equal(store.enrichCompaction(h, { sessionId: 'sess-e2', at: 1_020_000, reason: 'threshold 200k', tokensAfter: 9, model: 'm' }), false);
  // dropped row (applied=0) at a matching time
  store.recordCompaction(h, { sessionId: 'sess-e2', at: 2_000_000, reason: 'dropped: stale', fromExtension: true, applied: false, tokensBefore: 2, summaryTokens: 2, cost: null });
  assert.equal(store.enrichCompaction(h, { sessionId: 'sess-e2', at: 2_000_100, reason: 'threshold 200k', tokensAfter: 9, model: 'm' }), false);
  // other session
  assert.equal(store.enrichCompaction(h, { sessionId: 'other', at: 2_000_100, reason: 'threshold 200k', tokensAfter: 9, model: 'm' }), false);
  const db = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT reason FROM compactions ORDER BY id").all().map(r => r.reason), ['manual', 'dropped: stale']);
});

test('closeCrew is declared by main: first close wins, the outcome is durable across reopen, an open crew has null closedAt', t => {
  const { store: s, open } = fixture(t);
  const c = crew(s, owner(s));
  assert.equal(s.listCrews()[0].closedAt, null, 'not closed until declared');
  const closed = s.closeCrew(c.id, 'four probes green; reject path verified', 1_000);
  assert.deepEqual([closed.closedAt, closed.outcome], [1_000, 'four probes green; reject path verified']);
  const again = s.closeCrew(c.id, 'a later, different story', 2_000);
  assert.deepEqual([again.closedAt, again.outcome], [1_000, 'four probes green; reject path verified'], 'idempotent — the first declaration stands');
  s.close();
  const r = open().listCrews()[0];
  assert.equal(r.outcome, 'four probes green; reject path verified');
  assert.throws(() => open().closeCrew('crew_999', 'x'), /unknown crew/);
});

test('a stale lease on OUR main is reclaimed, never fatal: reload over an older instance id must not throw', t => {
  const { store: s } = fixture(t);
  const main = s.ensureMain('session-x');
  const stale = s.claimMain(main.id, 'instance-old');
  assert.throws(() => s.claimMain(main.id, 'instance-new'), /already owned/);
  const fresh = s.reclaimMain(main.id, 'instance-new');
  assert.equal(fresh.instanceId, 'instance-new');
  assert.ok(fresh.generation > stale.generation, 'the stale handle is invalidated by generation');
  assert.throws(() => s.releaseMain(stale), /stale or invalid owner/, 'the stale handle cannot touch the row (registry.unbind swallows this)');
  assert.equal(s.claimMain(main.id, 'instance-new').generation, fresh.generation, 'idempotent for the new owner');
});

test('openCrews omits closed crews: adopt must not open a room bus for a finished run (one idle connection per historical run, seen 2026-09-13)', t => {
  const { store: s } = fixture(t), a = owner(s, 'a', 'a-runtime');
  const live = s.createCrew(a, { slug: 'live', goal: 'still running' });
  const done = s.createCrew(a, { slug: 'done', goal: 'finished' });
  s.closeCrew(done.id, 'shipped', 1_000);
  assert.deepEqual(s.openCrews(a).map(c => c.id), [live.id]);
  assert.deepEqual(s.ownedCrews(a).map(c => c.id), [live.id, done.id], 'ownedCrews still lists history');
});
