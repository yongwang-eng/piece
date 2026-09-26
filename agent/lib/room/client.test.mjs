import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { RoomStore } from "./roster.ts";

// Real client/store boundary, without pi or a transport connection.
let source = stripTypeScriptTypes(readFileSync(process.env.CREW_CLIENT_BASE_SOURCE ?? new URL("./client.ts", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
if (process.env.PI_TEST_OMIT_HANDOFF === "1") source = source.replace("this.o.handoff?.(name, reason)", "undefined");

test("RoomClient attaches runtime handoff before removing the roster member", () => {
  const dir = mkdtempSync(`${tmpdir()}/room-client-`);
  try {
    const store = new RoomStore(dir, "run");
    store.join({ name: "historian", role: "historian", backend: "crew", responsibility: "design" });
    const facts = { files: [], decisions: 0, lastMessage: "last", tools: 42, reason: "wedged" };
    let captured = false;
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore });
    const client = new Client({ on() {} }, {
      runDir: dir, run: "run", card: { name: "main" }, isMain: true,
      handoff(name, reason) {
        assert.equal(name, "historian"); assert.equal(reason, "wedged");
        assert.ok(store.read().members.some((m) => m.name === name));
        captured = true;
        return facts;
      },
    });
    client.memberLeft("historian", "wedged");
    assert.equal(captured, true);
    assert.deepEqual(store.since(0).find((l) => l.kind === "member_left").details.handoff, facts);
    assert.equal(store.read().members.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RoomClient rejects foreign-room traffic before interception; own-room traffic is unchanged', () => {
  const dir = mkdtempSync(`${tmpdir()}/room-isolation-`);
  try {
    let intercepted = 0;
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore });
    const client = new Client({ on() {} }, {
      runDir: dir, run: 'crew_1', card: { name: 'main' }, isMain: true,
      intercept() { intercepted++; return true; },
    });
    const message = { kind: 'notice', task: 'vitals', from: 'worker', to: ['main'] };
    client.onEvent({ type: 'message', payload: { ...message, id: 'foreign', run: 'crew_2' } });
    assert.equal(intercepted, 0);
    client.onEvent({ type: 'message', payload: { ...message, id: 'local', run: 'crew_1' } });
    assert.equal(intercepted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('membership validation happens before a card enters the room record', () => {
  const dir = mkdtempSync(`${tmpdir()}/room-membership-`);
  try {
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore });
    const client = new Client({ on() {} }, {
      runDir: dir, run: 'crew_1', card: { name: 'main' }, isMain: true,
      validateMember(card) { if (card.id !== 7) throw new Error('unregistered identity'); },
    });
    const card = { name: 'worker', backend: 'crew', role: 'reviewer', responsibility: 'review' };
    assert.throws(() => client.memberJoined({ ...card, id: 8 }), /unregistered identity/);
    assert.equal(client.roster().members.length, 0);
    client.memberJoined({ ...card, id: 7 });
    assert.equal(client.roster().members[0].id, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('room transport is isolated by storage namespace and normalizes worker-relative paths', async () => {
  const { createHash } = await import('node:crypto');
  const { resolve } = await import('node:path');
  const dir = mkdtempSync(`${tmpdir()}/room-namespace-`);
  try {
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore, createHash, resolve });
    const options = { run: 'crew_1', card: { name: 'main' }, isMain: true };
    const main = new Client({ on() {} }, { ...options, runDir: `${dir}/a/crew_1` });
    const worker = new Client({ on() {} }, { ...options, isMain: false, runDir: `${dir}/a/crew_1/children/worker/../..` });
    const reset = new Client({ on() {} }, { ...options, runDir: `${dir}/b/crew_1` });
    assert.equal(main.namespace, worker.namespace);
    assert.notEqual(main.namespace, reset.namespace, 'a reset DB must not join the old room');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('room namespace stays in the conservative charset [a-z0-9._/-], ≤64 chars, for ANY run id', async () => {
  // Inherited from the pi-intercom era (its registerLocalExtension regex); kept because every transport name charset is a superset — a rejected namespace throws inside an
  // event-bus handler, is swallowed, and every room message queues forever (F12/F13: workers spawned with 0 turns).
  const INTERCOM_NS = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
  const { createHash } = await import('node:crypto');
  const { resolve } = await import('node:path');
  const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore, createHash, resolve });
  for (const run of ['crew_1', 'Yong_Voice', 'a-very-long-run-slug-that-someone-typed-without-thinking-about-limits', 'plat73', 'x']) {
    const c = new Client({ on() {} }, { run, card: { name: 'main' }, isMain: true, runDir: `/tmp/runs/deadbeef/${run}` });
    assert.match(c.namespace, INTERCOM_NS, `run "${run}" → "${c.namespace}" (${c.namespace.length} chars)`);
  }
  // still distinct per (run, runDir)
  const a = new Client({ on() {} }, { run: 'crew_1', card: { name: 'main' }, isMain: true, runDir: '/tmp/runs/aaaa/crew_1' });
  const b = new Client({ on() {} }, { run: 'crew_2', card: { name: 'main' }, isMain: true, runDir: '/tmp/runs/aaaa/crew_2' });
  const c2 = new Client({ on() {} }, { run: 'crew_1', card: { name: 'main' }, isMain: true, runDir: '/tmp/runs/bbbb/crew_1' });
  assert.notEqual(a.namespace, b.namespace); assert.notEqual(a.namespace, c2.namespace);
});

test("ready() is false while an injected channel reports itself disconnected; true once it connects", () => {
  const dir = mkdtempSync(`${tmpdir()}/room-ready-`);
  try {
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore });
    let connected = false;
    const channel = { namespace: "crew.x", snapshot: () => ({ connected }), publish() { if (!connected) throw new Error("not connected"); } };
    const client = new Client({ on() {} }, { runDir: dir, run: "crew_1", card: { name: "main" }, isMain: true, registerNow: true, channel });
    assert.equal(client.ready(), false, "a channel that cannot deliver must not count as ready");
    connected = true;
    assert.equal(client.ready(), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bus option: RoomClient attaches itself, routes bus events in, and flushes on ready", () => {
  const dir = mkdtempSync(`${tmpdir()}/room-bus-`);
  try {
    const Client = runInNewContext(`${source}\nRoomClient`, { RoomStore, laneFor: () => "resolve" });
    let awaiting = 'c-w-1-1';
    const client = new Client({ on() {} }, { runDir: dir, run: 'crew_1', card: { name: 'w' }, isMain: false, awaiting: () => awaiting, onResolve() { awaiting = undefined; } });
    client.turnRunning = true;
    client.sentToMainThisTurn = true;   // the consult request addressed main
    client.onEvent({ type: 'message', payload: { id: 'a1', run: 'crew_1', at: 't', from: 'main', to: ['w'], kind: 'result', re: 'c-w-1-1', text: 'HUMAN: ok' } });
    assert.equal(client.sentToMainThisTurn, false, 'answered: the worker may still report this turn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
