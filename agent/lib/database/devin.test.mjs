import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCrewStore } from './store.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'devin-store-'));
  const path = join(root, 'agent.sqlite');
  const stores = [];
  const open = () => { const s = openCrewStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, open, store: open() };
}
const rec = (over = {}) => ({
  id: 'c25ffaff214748ac89f2e9717a7a6528', kind: 'build', title: 'api: boot phase timing', slug: 'boot-phase-timing', url: 'https://app.devin.ai/sessions/c25ffaff',
  createdAt: 1_700_000_000_000, watch: true, owner: { session: 'S1', pane: '%8', pid: 42, cwd: '/tmp' },
  expect: { branch: 'yong/boot-phase-timing' }, stage: { name: 'building', move: 'devin', at: 1_700_000_000_000 }, round: 2,
  last: { status: 'running', status_detail: 'working', acus_consumed: 1.5, pull_requests: [] }, ...over,
});

test('devin sessions (D97): upsert round-trips every field incl. JSON ones; list returns all rows with their events oldest-first', t => {
  const { store } = fixture(t);
  store.devinUpsert(rec());
  store.devinEvent(rec().id, 1_700_000_001_000, 'created');
  store.devinEvent(rec().id, 1_700_000_002_000, 'PR #7 opened');
  const [s] = store.devinList();
  assert.equal(s.id, rec().id); assert.equal(s.kind, 'build'); assert.equal(s.watch, true);
  assert.deepEqual(s.owner, rec().owner); assert.deepEqual(s.expect, rec().expect); assert.deepEqual(s.stage, rec().stage); assert.equal(s.round, 2);
  assert.deepEqual(s.last, rec().last); assert.equal(s.signedOffAt, undefined); assert.equal(s.mirror, undefined);
  assert.deepEqual(s.events, [{ at: 1_700_000_001_000, text: 'created' }, { at: 1_700_000_002_000, text: 'PR #7 opened' }]);
  // upsert is an update: the poll result lands, nothing else moves
  store.devinUpsert({ ...rec(), last: { status: 'suspended', status_detail: 'inactivity' }, polledAt: 5, question: 'Which DB?' });
  const [u] = store.devinList();
  assert.equal(u.last.status, 'suspended'); assert.equal(u.polledAt, 5); assert.equal(u.question, 'Which DB?'); assert.equal(u.round, 2);
  assert.equal(u.events.length, 2, 'events are a separate table; an upsert never touches them');
});

test('devin sessions: two connections write their own rows; neither erases the other (the JSON registry did exactly that)', t => {
  const { store, open } = fixture(t);
  const other = open();
  store.devinUpsert(rec({ id: 'a1', owner: { session: 'S1' } }));
  other.devinUpsert(rec({ id: 'b2', owner: { session: 'S2' } }));
  store.devinUpsert(rec({ id: 'a1', owner: { session: 'S1' }, polledAt: 9 }));
  assert.deepEqual(store.devinList().map(s => s.id).sort(), ['a1', 'b2']);
  assert.deepEqual(other.devinList().map(s => s.id).sort(), ['a1', 'b2']);
});

test('devin sessions: insertIfAbsent imports without clobbering; signOff stamps once and is idempotent', t => {
  const { store } = fixture(t);
  assert.equal(store.devinInsertIfAbsent(rec({ id: 'x', round: 1 })), true);
  assert.equal(store.devinInsertIfAbsent(rec({ id: 'x', round: 7 })), false);
  assert.equal(store.devinList()[0].round, 1);
  assert.equal(store.devinSignOff('x', 123), true);
  assert.equal(store.devinList()[0].signedOffAt, 123);
  assert.equal(store.devinSignOff('x', 456), false, 'already signed off');
  assert.equal(store.devinList()[0].signedOffAt, 123);
  assert.equal(store.devinSignOff('nope', 1), false);
});

test('devin sessions: a v9 database gains the two tables on open and keeps its rows', t => {
  const { path, store } = fixture(t);
  store.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE devin_events; DROP TABLE devin_sessions; UPDATE crew_meta SET version = 9');
  db.prepare("INSERT INTO agents (kind, name, session_id, created_at) VALUES ('main', 'main', 'keep-me', 1)").run();
  db.close();
  const again = openCrewStore(path);
  t.after(() => again.close());
  assert.equal(again.ensureMain('keep-me').sessionId, 'keep-me');
  again.devinUpsert(rec({ id: 'after-migration' }));
  assert.equal(again.devinList().length, 1);
});
