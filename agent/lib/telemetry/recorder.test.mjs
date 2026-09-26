import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The recorder reads env at install time; set the badge BEFORE importing.
process.env.PI_CREW_ROLE = 'worker';
process.env.PI_CREW_ID = '2';
const { installUsageRecorder } = await import('./recorder.ts');
const { openCrewStore, agentDbPath } = await import('../database/store.ts');

test('badge path: a worker process records its calls to its pre-minted agent row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recorder-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const setup = openCrewStore(agentDbPath(dir));
  const main = setup.ensureMain('s-main');
  const owner = setup.claimMain(main.id, 'inst-1');
  const crew = setup.createCrew(owner, { slug: 'run1', goal: 'recorder test' });
  const worker = setup.registerWorker(owner, crew.id, { name: 'reviewer', profile: 'reviewer' });
  assert.equal(worker.id, 'agent_2', 'badge must match the pre-minted row');
  setup.close();

  const handlers = new Map();
  const pi = { on: (type, fn) => handlers.set(type, fn) };
  installUsageRecorder(pi, dir);
  const ctx = { sessionManager: { getSessionId: () => 's-worker' } };
  const msg = { role: 'assistant', model: 'm1', provider: 'p1', stopReason: 'stop',
    usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } } };
  handlers.get('turn_start')({ type: 'turn_start', timestamp: 1 }, ctx);
  handlers.get('message_end')({ type: 'message_end', message: msg }, ctx);
  handlers.get('turn_end')({ type: 'turn_end', message: msg, toolResults: [] }, ctx);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(agentDbPath(dir));
  const rows = db.prepare(
    "SELECT a.id agent, a.kind, c.total_tokens FROM model_calls c JOIN turns t ON c.turn_id=t.id JOIN agents a ON t.agent_id=a.id"
  ).all();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(rows.map(r => ({ ...r })), [{ agent: 2, kind: 'worker', total_tokens: 10 }]);
});

test('the recorder is a process singleton: a second install is a no-op', () => {
  let subscriptions = 0;
  installUsageRecorder({ on: () => { subscriptions++; } }, '/nowhere');
  assert.equal(subscriptions, 0);
});
