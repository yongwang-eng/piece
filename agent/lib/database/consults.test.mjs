import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCrewStore } from './store.ts';
import { SCHEMA_SQL } from './schema-ddl.ts';
import { SCHEMA_VERSION } from './schema.ts';

// v9 added crews.closed_at/outcome, v10 the two devin tables; every older fixture is built from the current DDL without them.
const preV9 = (ddl) => ddl.replace(/\n\t`closed_at` integer,\n\t`outcome` text,/, '')
  .replace(/CREATE TABLE `devin_[a-z]+` \([\s\S]*?\) STRICT;\n\n?/g, '').replace(/CREATE INDEX `devin_[a-z_]*` ON `devin_[a-z]+` \([^)]*\);\n?/g, '');

const fresh = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'consults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openCrewStore(join(root, 'agent.sqlite'));
  t.after(() => store.close());
  const main = store.ensureMain('s-main');
  const owner = store.claimMain(main.id, 'inst');
  const crew = store.createCrew(owner, { slug: 'c', goal: 'g' });
  return { root, store, owner, crew };
};

const ask = (id, extra = {}) => ({
  id, worker: 'verifier', kind: 'irreversible', class: 'irreversible', humanRequired: true,
  question: 'create/delete a prod endpoint', evidence: ['evidence/a.md'],
  action: { verb: 'create/delete', target: 'https://api.acme.example/webhook_endpoints', detail: '{…}' },
  intent: { why: 'prove the flag gates it', exact: 'POST …; DELETE …', effect: 'one endpoint for 30s', reversible: 'yes', ifDenied: 'skip the probe' },
  packet: { whyHuman: 'kind=irreversible is human-only' }, askedAt: 1_000, ...extra,
});

test('a consult is recorded open, answered exactly once; the loser of the race gets false', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-verifier-80-1'));
  const open = store.openConsults();
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].id, open[0].run, open[0].state, open[0].intent.reversible], ['c-verifier-80-1', crew.id, 'open', 'yes']);

  assert.equal(store.answerConsult(crew.id, 'c-verifier-80-1', { by: 'human:console', choice: 'approve', answer: 'APPROVED by Yong: …', at: 7_000, launch: 'L1', agent: 'Safari' }), true);
  assert.equal(store.answerConsult(crew.id, 'c-verifier-80-1', { by: 'human:cli', choice: 'reject', answer: 'REJECTED', at: 8_000 }), false, 'second writer loses');
  assert.equal(store.withdrawConsult(crew.id, 'c-verifier-80-1', 'worker killed'), false, 'cannot withdraw an answered consult');
  assert.equal(store.openConsults().length, 0);

  const [h] = store.consultHistory({ run: crew.id });
  assert.deepEqual([h.state, h.answeredBy, h.choice, h.answer, h.answeredAt, h.launch, h.agent], ['answered', 'human:console', 'approve', 'APPROVED by Yong: …', 7_000, 'L1', 'Safari']);
  assert.equal(h.latencyMs, 6_000);
});

test('governor and pre-authorized answers are recorded too; withdrawal closes an open consult; history filters by kind and who', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-verifier-80-1', { kind: 'confirm', class: 'confirm', humanRequired: false, intent: undefined }));
  store.openConsult(crew.id, ask('c-implementer-81-1', { worker: 'implementer', action: { verb: 'commit', target: 'crew/x' } }));
  store.openConsult(crew.id, ask('c-verifier-80-2', { kind: 'auth', class: 'auth' }));
  assert.equal(store.answerConsult(crew.id, 'c-verifier-80-1', { by: 'governor', choice: 'answer', answer: 'GOVERNOR: yes', at: 2_000 }), true);
  assert.equal(store.answerConsult(crew.id, 'c-implementer-81-1', { by: 'preauthorized', choice: 'approve', answer: 'standing ruling', at: 1_000 }), true);
  assert.equal(store.withdrawConsult(crew.id, 'c-verifier-80-2', 'worker killed'), true);
  assert.equal(store.openConsults().length, 0);
  assert.equal(store.consultHistory({ run: crew.id }).length, 3);
  assert.deepEqual(store.consultHistory({ run: crew.id, kind: 'auth' }).map(h => [h.state, h.answer]), [['withdrawn', 'worker killed']]);
  assert.deepEqual(store.consultHistory({ answeredBy: 'governor' }).map(h => h.id), ['c-verifier-80-1']);
  assert.equal(store.consultHistory({ run: crew.id }).find(h => h.id === 'c-verifier-80-1').intent, null, 'a consult without intent stores null, not "undefined"');
});

test('the same consult id may exist in two crews; a duplicate within one crew is rejected', (t) => {
  const { store, owner, crew } = fresh(t);
  const other = store.createCrew(owner, { slug: 'd', goal: 'g' });
  store.openConsult(crew.id, ask('c-verifier-80-1'));
  store.openConsult(other.id, ask('c-verifier-80-1'));
  assert.throws(() => store.openConsult(crew.id, ask('c-verifier-80-1')));
  assert.equal(store.openConsults().length, 2);
  assert.equal(store.openConsults(other.id).length, 1);
});

test('a v5 database gains the consults table in place and keeps its rows', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'consults-v5-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'agent.sqlite');
  const v5 = new DatabaseSync(path);
  // current DDL minus the consults table and its index, stamped 5
  const sql = preV9(SCHEMA_SQL).replace(/CREATE TABLE `consults` \([\s\S]*?\) STRICT;\n\n/, '').replace(/CREATE INDEX `consults_[a-z_]*` ON `consults` \([^)]*\);\n/g, '');
  assert.ok(!sql.includes('consults'), 'fixture really is v5');
  v5.exec(sql);
  v5.exec("INSERT INTO crew_meta (namespace, version) VALUES ('0123456789abcdef0123456789abcdef', 5)");
  v5.exec("INSERT INTO agents (kind, name, session_id, generation, created_at) VALUES ('main','main','s',1,1)");
  v5.exec("INSERT INTO compactions (agent_id, session_id, recorded_at, reason, tokens_before, cost) VALUES (1,'s',5,'manual',200000,0.7)");
  v5.close();

  const store = openCrewStore(path);
  t.after(() => store.close());
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT version FROM crew_meta').get().version, SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='consults'").get().n, 1);
  assert.equal(db.prepare('SELECT tokens_before FROM compactions WHERE id = 1').get().tokens_before, 200000, 'history kept');
  assert.equal(store.openConsults().length, 0);
});

test('an "Ask first" thread is recorded: the first row closes with choice ask, the re-consult carries follow_up_of + reply', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-verifier-80-1'));
  assert.equal(store.answerConsult(crew.id, 'c-verifier-80-1', { by: 'human:console', choice: 'ask', answer: 'QUESTION from Yong: why prod?', at: 2_000 }), true);
  store.openConsult(crew.id, ask('c-verifier-80-2', { followUpOf: 'c-verifier-80-1', reply: 'staging has no capture flag', askedAt: 3_000 }));
  const [open] = store.openConsults();
  assert.deepEqual([open.id, open.followUpOf, open.reply], ['c-verifier-80-2', 'c-verifier-80-1', 'staging has no capture flag']);
  assert.equal(store.consultHistory({ run: crew.id }).find(h => h.id === 'c-verifier-80-1').choice, 'ask');
});

test('a v6 database gains the thread columns in place', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'consults-v6-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'agent.sqlite');
  const v6 = new DatabaseSync(path);
  const sql = preV9(SCHEMA_SQL).replace(/\n\t`follow_up_of` text,\n\t`reply` text,\n\t`thread` text,/, '');
  assert.ok(!sql.includes('follow_up_of') && !sql.includes('`thread`'), 'fixture really is v6');
  v6.exec(sql);
  v6.exec("INSERT INTO crew_meta (namespace, version) VALUES ('0123456789abcdef0123456789abcdef', 6)");
  v6.exec("INSERT INTO agents (kind, name, session_id, generation, created_at) VALUES ('main','main','s',1,1)");
  v6.exec("INSERT INTO crews (slug, goal, owner_id, created_at) VALUES ('c','g',1,1)");
  v6.exec("INSERT INTO consults (crew_id, id, worker, kind, class, question, asked_at) VALUES (1,'c-w-1-1','w','auth','auth','q',5)");
  v6.close();
  const store = openCrewStore(path);
  t.after(() => store.close());
  assert.equal(new DatabaseSync(path, { readOnly: true }).prepare('SELECT version FROM crew_meta').get().version, SCHEMA_VERSION);
  assert.deepEqual(store.openConsults().map(c => [c.id, c.followUpOf, c.reply, c.thread]), [['c-w-1-1', null, null, []]]);
});

test('the governor packet lands on the open row after the fact (main opens the record before the packet exists)', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-w-1-1'));
  assert.equal(store.setConsultPacket(crew.id, 'c-w-1-1', { whyHuman: 'x', question: 'Delete it?', recommendation: 'approve' }), true);
  assert.deepEqual(store.openConsults()[0].packet, { whyHuman: 'x', question: 'Delete it?', recommendation: 'approve' });
  store.answerConsult(crew.id, 'c-w-1-1', { by: 'human:console', choice: 'approve', answer: 'ok', at: 2 });
  assert.equal(store.setConsultPacket(crew.id, 'c-w-1-1', { question: 'late' }), false, 'a settled row is immutable');
});

test('thread: a human question and a worker reply append to the OPEN row under one id; a question is not an answer', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-w-1-1'));
  assert.equal(store.appendConsultTurn(crew.id, 'c-w-1-1', { who: 'human', text: 'why prod?', at: 't1' }), true);
  let [row] = store.openConsults();
  assert.deepEqual([row.state, row.thread], ['open', [{ who: 'human', text: 'why prod?', at: 't1' }]]);
  assert.equal(store.appendConsultTurn(crew.id, 'c-w-1-1', { who: 'worker', text: 'staging has no flag', at: 't2' }), true);
  [row] = store.openConsults();
  assert.equal(row.thread.length, 2);
  assert.equal(store.consultHistory({ run: crew.id }).length, 1, 'still one row');
  store.answerConsult(crew.id, 'c-w-1-1', { by: 'human:console', choice: 'approve', answer: 'ok', at: 3 });
  assert.equal(store.appendConsultTurn(crew.id, 'c-w-1-1', { who: 'human', text: 'late', at: 't3' }), false, 'a settled row takes no more turns');
});

test('a v7 database gains the thread column in place', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'consults-v7-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'agent.sqlite');
  const v7 = new DatabaseSync(path);
  const sql = preV9(SCHEMA_SQL).replace(/\n\t`thread` text,/, '');
  assert.ok(!sql.includes('`thread`'), 'fixture really is v7');
  v7.exec(sql);
  v7.exec("INSERT INTO crew_meta (namespace, version) VALUES ('0123456789abcdef0123456789abcdef', 7)");
  v7.exec("INSERT INTO agents (kind, name, session_id, generation, created_at) VALUES ('main','main','s',1,1)");
  v7.exec("INSERT INTO crews (slug, goal, owner_id, created_at) VALUES ('c','g',1,1)");
  v7.exec("INSERT INTO consults (crew_id, id, worker, kind, class, question, asked_at) VALUES (1,'c-w-1-1','w','auth','auth','q',5)");
  v7.close();
  const store = openCrewStore(path);
  t.after(() => store.close());
  assert.equal(new DatabaseSync(path, { readOnly: true }).prepare('SELECT version FROM crew_meta').get().version, SCHEMA_VERSION);
  assert.deepEqual(store.openConsults().map(c => [c.id, c.thread]), [['c-w-1-1', []]]);
});

test('a consult is found by id within its run — the lookup a re-sent request keys on', (t) => {
  const { store, crew } = fresh(t);
  store.openConsult(crew.id, ask('c-w-1-1'));
  assert.equal(store.consult(crew.id, 'c-w-1-1')?.state, 'open');
  assert.equal(store.consult(crew.id, 'c-w-1-9'), undefined);
  store.answerConsult(crew.id, 'c-w-1-1', { by: 'governor', choice: null, answer: 'proceed', at: 5 });
  assert.deepEqual([store.consult(crew.id, 'c-w-1-1').state, store.consult(crew.id, 'c-w-1-1').answer], ['answered', 'proceed']);
});

test('D73 veto: only an answered two-key row flips to vetoed, once; human settlements and open rows are untouched', (t) => {
  const { store, crew } = fresh(t);
  for (const id of ['tk', 'hu', 'op']) store.openConsult(crew.id, ask(id));
  store.answerConsult(crew.id, 'tk', { by: 'two-key', choice: 'approve', answer: 'APPROVED by two keys', at: 2_000 });
  store.answerConsult(crew.id, 'hu', { by: 'human:console', choice: 'approve', answer: 'APPROVED by Yong', at: 2_000 });
  assert.equal(store.vetoConsult(crew.id, 'tk', 3_000), true);
  assert.equal(store.vetoConsult(crew.id, 'tk', 4_000), false, 'a second veto is a no-op');
  assert.equal(store.vetoConsult(crew.id, 'hu', 3_000), false, "Yong's own answer is not a two-key decision");
  assert.equal(store.vetoConsult(crew.id, 'op', 3_000), false, 'an open row has nothing to veto');
  const tk = store.consult(crew.id, 'tk');
  assert.equal(tk.choice, 'vetoed'); assert.match(tk.answer, /^APPROVED by two keys\n\n\[VETO by Yong 1970-01-01T00:00:03\.000Z\]$/); assert.deepEqual([tk.state, tk.answeredBy], ['answered', 'two-key']);
  assert.equal(store.consult(crew.id, 'hu').choice, 'approve');
  assert.equal(store.openConsults().length, 1, 'op is still open');
});
