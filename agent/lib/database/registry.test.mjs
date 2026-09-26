import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCrewRegistry, sharedRegistry, resetSharedRegistry } from './registry.ts';
import { openCrewStore } from './store.ts';

const sdk = join(dirname(dirname(process.execPath)), 'lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const { SessionManager } = await import(pathToFileURL(sdk).href);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crew-registry-hook-'));
  const path = join(root, 'crew.sqlite');
  const cleanups = [];
  t.after(() => { for (const close of cleanups) close(); rmSync(root, { recursive: true, force: true }); });
  function runtime() {
    const hooks = new Map();
    const get = installCrewRegistry({ on: (name, fn) => hooks.set(name, fn) }, path);
    const stop = () => hooks.get('session_shutdown')();
    cleanups.push(stop);
    return { get, start: sm => hooks.get('session_start')({}, { sessionManager: sm }), stop };
  }
  return { runtime };
}

test('session hooks bind the real SDK session identity once across multiple crews', t => {
  const { runtime } = fixture(t), r = runtime(), sm = SessionManager.inMemory();
  assert.throws(() => r.get(), /not initialized/);
  r.start(sm);
  const first = r.get();
  const a = first.store.createCrew(first.owner, { slug: 'a', goal: 'A' });
  const b = first.store.createCrew(first.owner, { slug: 'b', goal: 'B' });
  assert.equal(a.ownerId, b.ownerId);
  assert.equal(first.store.getAgent(a.ownerId).sessionId, sm.getSessionId());
  r.start(sm);
  assert.equal(r.get(), first, 'duplicate startup is idempotent');
});

test('reload keeps main identity, changes runtime token and fences old handles', t => {
  const { runtime } = fixture(t), sm = SessionManager.inMemory(), before = runtime();
  before.start(sm);
  const old = before.get();
  before.stop();
  assert.throws(() => before.get(), /not initialized/);
  const after = runtime(); after.start(sm);
  const next = after.get();
  assert.equal(next.owner.agentId, old.owner.agentId);
  assert.notEqual(next.owner.instanceId, old.owner.instanceId);
  assert.ok(next.owner.generation > old.owner.generation);
  assert.throws(() => next.store.createCrew(old.owner, { slug: 'stale', goal: 'Stale' }), /stale/);
  assert.equal(next.store.createCrew(next.owner, { slug: 'valid', goal: 'Valid' }).ownerId, old.owner.agentId);
});

test('new SDK session gets a different main identity without stealing an existing session', t => {
  const { runtime } = fixture(t), sm = SessionManager.inMemory(), r = runtime();
  r.start(sm);
  const id = r.get().owner.agentId;
  sm.newSession();
  r.start(sm);
  assert.notEqual(r.get().owner.agentId, id);
  const duplicate = runtime();
  assert.throws(() => duplicate.start(sm), /already owned/);
  assert.throws(() => duplicate.get(), /not initialized/);
  assert.equal(r.get().store.getAgent(r.get().owner.agentId).sessionId, sm.getSessionId());
});

/** Two extensions in one process, each loaded through its own jiti module graph. */
function twoExtensions() {
  const buses = [];
  const bus = () => { const handlers = new Map(); buses.push(handlers); return { on: (t, fn) => handlers.set(t, fn) }; };
  return { buses, bus };
}
const ctxFor = (sessionId) => ({ sessionManager: { getSessionId: () => sessionId } });

test('two extensions claiming the same main share ONE lease (no "already owned" rejection)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const { buses, bus } = twoExtensions();
  const crew = sharedRegistry(bus(), path);
  const usage = sharedRegistry(bus(), path);
  buses[0].get('session_start')({}, ctxFor('s-1'));
  buses[1].get('session_start')({}, ctxFor('s-1'));   // second claim must not throw
  assert.equal(crew().owner.instanceId, usage().owner.instanceId, 'one process, one instance ID');
  assert.equal(crew().store, usage().store, 'one store handle');
});

test('a consumer can bind lazily when session_start was never delivered to it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const { bus } = twoExtensions();
  const usage = sharedRegistry(bus(), path);
  assert.throws(() => usage(), /not initialized/);        // nothing known yet
  const binding = usage('s-lazy');                         // frame carries its session
  assert.equal(binding.sessionId, 's-lazy');
  assert.equal(usage().sessionId, 's-lazy');
});

test('/reload rebinds onto the NEW event bus instead of a dead cached accessor', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reload-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const { buses, bus } = twoExtensions();
  const before = sharedRegistry(bus(), path);
  buses[0].get('session_start')({}, ctxFor('s-1'));
  const firstStore = before().store;

  // reload: old instance shuts down, new instances load and bind to a new bus
  buses[0].get('session_shutdown')({}, ctxFor('s-1'));
  const after = sharedRegistry(bus(), path);
  buses[1].get('session_start')({}, ctxFor('s-1'));
  assert.notEqual(after().store, firstStore, 'a released store must not be reused');
  assert.equal(after().sessionId, 's-1');
  assert.doesNotThrow(() => after().store.ownedCrews(after().owner), 'the new lease must be usable');
});

/** The bug that broke a live /reload: pi loads each extension through its own jiti instance with
 *  `moduleCache: false`, so module-level state is per-extension. Two module graphs here = two
 *  extensions there. With a module-scope singleton the second claim throws "already owned". */
test('the lease is shared across MODULE GRAPHS, not just across calls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'modgraph-'));
  const path = join(dir, 'agent.sqlite');
  const crewMod = await import('./registry.ts');
  const usageMod = await import('./registry.ts?extension=usage');
  assert.notEqual(crewMod, usageMod, 'fixture must model two module graphs');
  t.after(() => { crewMod.resetSharedRegistry(); usageMod.resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });

  const handlers = [new Map(), new Map()];
  const crew = crewMod.sharedRegistry({ on: (t2, fn) => handlers[0].set(t2, fn) }, path);
  const usage = usageMod.sharedRegistry({ on: (t2, fn) => handlers[1].set(t2, fn) }, path);
  handlers[0].get('session_start')({}, ctxFor('s-1'));
  assert.doesNotThrow(() => handlers[1].get('session_start')({}, ctxFor('s-1')), 'second extension must not be rejected');
  assert.equal(crew().owner.instanceId, usage().owner.instanceId);
});

test('a lease left by a DEAD process (crash, or older code that never released) does not stop the next process from binding', t => {
  // 2026-09-14: /reload-all crashed three sessions; `pi -c` on each then failed at session_start with
  // "main already owned by another instance" — a stale lease had become a lockout. Our session file is ours: reclaim.
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const dead = openCrewStore(path);
  const main = dead.ensureMain('s-crashed');
  dead.claimMain(main.id, 'instance-of-a-dead-process');   // never released
  dead.close();
  const { buses, bus } = twoExtensions();
  const crew = sharedRegistry(bus(), path);
  assert.doesNotThrow(() => buses[0].get('session_start')({}, ctxFor('s-crashed')));
  assert.equal(crew().owner.agentId, main.id, 'same main identity');
  assert.notEqual(crew().owner.instanceId, 'instance-of-a-dead-process');
  assert.equal(crew().store.createCrew(crew().owner, { slug: 'after', goal: 'works' }).ownerId, main.id);
});

test('a lease stolen while we run (a reload racing, a second process on our session file) heals on the next write instead of failing forever', t => {
  // 2026-09-15: proj_events_rearch stacked "[usage] capture failed: Error: stale or invalid owner" once per model call for
  // hours — the registry kept handing back the rejected lease because only a session-id change rebinds.
  const dir = mkdtempSync(join(tmpdir(), 'stolen-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const { buses, bus } = twoExtensions();
  const usage = sharedRegistry(bus(), path);
  buses[0].get('session_start')({}, ctxFor('s-stolen'));
  const mine = usage().owner;
  const thief = openCrewStore(path);
  thief.reclaimMain(mine.agentId, 'another-process');       // our row, their lease now
  thief.close();
  assert.throws(() => usage().store.createCrew(usage().owner, { slug: 'dead', goal: 'x' }), /stale or invalid owner/, 'the bare accessor still holds the dead lease');
  const crew = usage.use('s-stolen', ({ store, owner }) => store.createCrew(owner, { slug: 'healed', goal: 'x' }));
  assert.equal(crew.ownerId, mine.agentId, 'same main identity');
  assert.ok(usage().owner.generation > mine.generation, 'the lease was reclaimed, not reused');
  assert.equal(usage.use('s-stolen', ({ store, owner }) => store.createCrew(owner, { slug: 'after', goal: 'x' })).ownerId, mine.agentId, 'and stays healthy');
});

test('use() does not mask a genuine error as a stale lease', t => {
  const dir = mkdtempSync(join(tmpdir(), 'genuine-'));
  const path = join(dir, 'agent.sqlite');
  t.after(() => { resetSharedRegistry(); rmSync(dir, { recursive: true, force: true }); });
  const { bus } = twoExtensions();
  const usage = sharedRegistry(bus(), path);
  let calls = 0;
  assert.throws(() => usage.use('s-g', () => { calls++; throw new Error('disk full'); }), /disk full/);
  assert.equal(calls, 1, 'no retry for a non-lease error');
  const gen = usage().owner.generation;
  assert.equal(usage().owner.generation, gen, 'lease untouched');
});
