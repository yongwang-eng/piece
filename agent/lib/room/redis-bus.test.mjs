/**
 * Two crews on one Redis, same member names in both, all three addressing shapes — zero cross-crew delivery.
 * Needs the local Redis (127.0.0.1:16379); skipped visibly otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisRoomBus, roomTopic } from "./redis-bus.ts";
import { createPubSub, loadPubSubConfig } from "../../../packages/pi-pubsub/src/index.ts";

let config;
try { config = loadPubSubConfig(); const probe = createPubSub({ ...config, connectTimeoutMs: 1500 }); await probe.connect(); await probe.close(); }
catch (e) { config = undefined; console.log(`# SKIPPING redis-bus tests — local Redis not reachable: ${e.message}`); }
const live = { skip: config ? false : "local Redis not running" };
const until = (pred, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(async () => { if (await pred()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timed out waiting")); } }, 10); });
const stamp = Date.now().toString(36);

/** attach and wait for the subscription to be acknowledged */
async function member(bus, name) {
  const seen = [];
  let ready = false;
  const channel = bus.attach(name, (ev) => seen.push(ev), () => { ready = true; });
  await until(() => ready);
  return { name, channel, seen, bus };
}

test("topic is unique per (run, runDir), readable at the tail, and a valid pi-pubsub topic", () => {
  const a = roomTopic("crew_3", "/runs/ns1/crew_3"), b = roomTopic("crew_4", "/runs/ns1/crew_4"), c = roomTopic("crew_3", "/runs/ns2/crew_3");
  assert.notEqual(a, b); assert.notEqual(a, c); assert.match(a, /^crew\.[0-9a-f]{32}\.crew_3$/);
  assert.equal(roomTopic("crew_3", "/runs/ns1/crew_3/"), roomTopic("crew_3", "/runs/ns1/crew_3"), "path normalisation");
});

test("channel publish throws before the subscription is acknowledged — nothing is queued in the bus", live, async () => {
  const bus = new RedisRoomBus({ run: `pre-${stamp}`, runDir: `/tmp/redis-bus/${stamp}/pre` });
  const channel = bus.attach("main", () => {});
  assert.equal(channel.snapshot().connected, false);
  assert.throws(() => channel.publish({ id: "early", kind: "notice" }), /not connected/);
  await until(() => channel.snapshot().connected);
  await bus.detach();
});

test("two crews, reused names, unicast + multicast + broadcast: every message stays inside its own crew", live, async () => {
  const runDir = (run) => `/tmp/redis-bus/${stamp}/${run}`;
  const publishes = [];
  const mk = (run) => new RedisRoomBus({ run, runDir: runDir(run), onPublish: (p, r) => publishes.push([run, p.id, r.subscribers]), onError: (s, e) => { throw new Error(`${s}: ${e.message}`); } });
  const A = { run: `crewA-${stamp}` }, B = { run: `crewB-${stamp}` };
  const buses = [];
  const join = async (crew, name) => { const bus = mk(crew.run); buses.push(bus); return member(bus, name); };
  try {
    // identical member names in both crews
    const [aMain, aRev, aHist, bMain, bRev, bHist] = await Promise.all([join(A, "main"), join(A, "reviewer"), join(A, "historian"), join(B, "main"), join(B, "reviewer"), join(B, "historian")]);

    aMain.channel.publish({ id: "a-uni", run: A.run, from: "main", to: ["reviewer"], kind: "request", text: "review it" });
    aMain.channel.publish({ id: "a-multi", run: A.run, from: "main", to: ["reviewer", "historian"], kind: "query", text: "what is open?" });
    aMain.channel.publish({ id: "a-bcast", run: A.run, from: "main", to: ["*"], kind: "notice", text: "artifact updated" });
    bRev.channel.publish({ id: "b-uni", run: B.run, from: "reviewer", to: ["main"], kind: "result", text: "done" });

    await until(() => aRev.seen.length === 3 && aHist.seen.length === 3 && bMain.seen.length === 1);
    await new Promise((r) => setTimeout(r, 100));                          // let any stray cross-crew frame arrive before asserting absence

    const ids = (m) => m.seen.map((e) => e.payload.id).sort();
    // crew A: every member but the sender gets all three (the envelope decides who ACTS; the transport fans out)
    assert.deepEqual(ids(aRev), ["a-bcast", "a-multi", "a-uni"]); assert.deepEqual(ids(aHist), ["a-bcast", "a-multi", "a-uni"]);
    assert.deepEqual(ids(aMain), [], "own echo is dropped");
    assert.ok(aRev.seen.every((e) => e.from === "main"), "from = the pubsub senderId, not something the payload claims");
    // crew B: only b-uni, and only to the two non-senders — nothing from crew A despite identical names
    assert.deepEqual(ids(bMain), ["b-uni"]); assert.deepEqual(ids(bHist), ["b-uni"]); assert.deepEqual(ids(bRev), []);
    // Redis's own count: each crew-A publish reached exactly 3 subscriber connections (2 peers + the sender's own subscription)
    assert.deepEqual(publishes.filter(([run]) => run === A.run).map(([, id, n]) => [id, n]).sort(), [["a-bcast", 3], ["a-multi", 3], ["a-uni", 3]]);
    assert.deepEqual(publishes.filter(([run]) => run === B.run).map(([, id, n]) => [id, n]), [["b-uni", 3]]);
  } finally { await Promise.all(buses.map((b) => b.detach())); }
});

test("a directed message published when no peer is subscribed reports 1 subscriber (only the sender) — the F12 signal", live, async () => {
  const results = [];
  const bus = new RedisRoomBus({ run: `lonely-${stamp}`, runDir: `/tmp/redis-bus/${stamp}/lonely`, onPublish: (p, r) => results.push([p.id, r.subscribers]) });
  try {
    const m = await member(bus, "main");
    m.channel.publish({ id: "task-1", run: "x", from: "main", to: ["worker"], kind: "request", text: "do it" });
    await until(() => results.length === 1);
    assert.deepEqual(results, [["task-1", 1]]);
  } finally { await bus.detach(); }
});

test("peers() = members connected to Redis for THIS run; a detached member disappears; another run's members never appear", live, async () => {
  const runDir = (run) => `/tmp/redis-bus/${stamp}/${run}`;
  const A = `peersA-${stamp}`, B = `peersB-${stamp}`;
  const a1 = new RedisRoomBus({ run: A, runDir: runDir(A) }), a2 = new RedisRoomBus({ run: A, runDir: runDir(A) }), b1 = new RedisRoomBus({ run: B, runDir: runDir(B) });
  try {
    const [m, r] = await Promise.all([member(a1, "main"), member(a2, "reviewer"), member(b1, "reviewer")]);
    assert.deepEqual((await a1.peers()).sort(), ["main", "reviewer"]);
    assert.deepEqual(await b1.peers(), ["reviewer"]);
    await a2.detach();
    await until(async () => { try { return (await a1.peers()).length === 1; } catch { return false; } });
    assert.deepEqual(await a1.peers(), ["main"]);
  } finally { await Promise.all([a1, a2, b1].map((b) => b.detach())); }
});

