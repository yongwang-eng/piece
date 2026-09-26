/**
 * Integration tests against the local Redis (127.0.0.1:16379). They are SKIPPED — visibly — when it is not running:
 *   /opt/homebrew/bin/redis-server ~/.pi/agent/config/redis.conf --bind 127.0.0.1
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { createPubSub, PubSubUnavailableError } from "./client.ts";
import { loadPubSubConfig } from "./config.ts";

let config;
let admin;
try {
  config = loadPubSubConfig();
  admin = createClient({ socket: { host: config.host, port: config.port, reconnectStrategy: false }, password: config.password, disableOfflineQueue: true });
  admin.on("error", () => {});
  await admin.connect();
} catch (e) {
  admin = undefined;
  console.log(`# SKIPPING pi-pubsub integration tests — local Redis not reachable: ${e.message}`);
}
const live = { skip: admin ? false : "local Redis not running" };
const topic = () => `test.pi-pubsub.${randomUUID().slice(0, 8)}`;
const until = (pred, ms = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(async () => { try { if (await pred()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timed out waiting")); } } catch (e) { clearInterval(i); rej(e); } }, 10); });
const open = async (name) => { const p = createPubSub({ ...config, clientName: name, connectTimeoutMs: 2000 }); await p.connect(); return p; };

test("subscribe is acknowledged before receive; publish reports the subscriber count; payload is exact", live, async () => {
  const a = await open("t-a"), b = await open("t-b");
  try {
    const t = topic(); const got = [];
    assert.equal((await a.publish(t, { id: "m0", senderId: "a", payload: "nobody listening" })).subscribers, 0);
    await b.subscribe(t, (m, ch) => got.push({ m, ch }));
    const r = await a.publish(t, { id: "m1", senderId: "a", payload: { nested: [1, "two"] } });
    assert.equal(r.subscribers, 1);
    await until(() => got.length === 1);
    assert.equal(got[0].ch, t); assert.equal(got[0].m.id, "m1"); assert.equal(got[0].m.senderId, "a"); assert.deepEqual(got[0].m.payload, { nested: [1, "two"] });
    assert.match(got[0].m.sentAt, /^\d{4}-/);
    assert.equal(got.length, 1, "m0 was published before the subscription existed and must not appear");
  } finally { await a.close(); await b.close(); }
});

test("topics are isolated: a subscriber on one exact topic never sees a sibling topic", live, async () => {
  const a = await open("t-iso");
  try {
    const t1 = `${topic()}.one`, t2 = `${t1.slice(0, -4)}.two`; const one = [], two = [];
    await a.subscribe(t1, (m) => one.push(m.id)); await a.subscribe(t2, (m) => two.push(m.id));
    await a.publish(t1, { id: "x1", senderId: "a", payload: 1 }); await a.publish(t2, { id: "x2", senderId: "a", payload: 2 });
    await until(() => one.length + two.length === 2);
    assert.deepEqual(one, ["x1"]); assert.deepEqual(two, ["x2"]);
  } finally { await a.close(); }
});

test("publish fails fast when not connected — nothing is queued", live, async () => {
  const p = createPubSub({ ...config, clientName: "t-offline" });
  await assert.rejects(p.publish(topic(), { id: "m", senderId: "a", payload: 1 }), (e) => e instanceof PubSubUnavailableError && /status: idle/.test(e.message));
  await p.connect(); await p.close();
  assert.equal(p.status, "closed");
  await assert.rejects(p.publish(topic(), { id: "m", senderId: "a", payload: 1 }), PubSubUnavailableError);
});

test("connect() to a dead port rejects within the timeout instead of retrying forever", async () => {
  const p = createPubSub({ host: "127.0.0.1", port: 1, connectTimeoutMs: 500 });
  const t0 = Date.now();
  await assert.rejects(p.connect());
  assert.ok(Date.now() - t0 < 5000); assert.equal(p.status, "closed");
});

test("a killed connection reconnects, restores the subscription, and reports the gap through status", live, async () => {
  const a = await open("t-victim"), b = await open("t-pub");
  try {
    const t = topic(); const got = []; const statuses = [];
    a.onStatus((s) => statuses.push(s));
    await a.subscribe(t, (m) => got.push(m.id));
    const list = await admin.sendCommand(["CLIENT", "LIST"]);
    const victim = list.split("\n").find((l) => l.includes("name=t-victim"));
    assert.ok(victim, "victim connection visible in CLIENT LIST");
    const id = /\bid=(\d+)/.exec(victim)[1];
    await admin.sendCommand(["CLIENT", "KILL", "ID", id]);
    await until(() => statuses.includes("disconnected"), 3000);
    await until(() => a.status === "ready", 5000);
    // no proof of resubscribe until a message actually arrives on the restored connection
    assert.equal((await b.publish(t, { id: "after", senderId: "b", payload: 1 })).subscribers, 1);
    await until(() => got.includes("after"));
    assert.deepEqual(got, ["after"]);
  } finally { await a.close(); await b.close(); }
});

test("a throwing handler and an invalid frame are reported, and delivery continues", live, async () => {
  const errors = [], invalid = [];
  const p = createPubSub({ ...config, clientName: "t-handler", onHandlerError: (e, t) => errors.push([e.message, t]), onInvalidMessage: (raw, t) => invalid.push([raw, t]) });
  await p.connect();
  try {
    const t = topic(); const got = [];
    await p.subscribe(t, (m) => { got.push(m.id); if (m.id === "boom") throw new Error("handler exploded"); });
    await p.publish(t, { id: "boom", senderId: "a", payload: 1 });
    await admin.publish(t, "{not a message");
    await p.publish(t, { id: "next", senderId: "a", payload: 2 });
    await until(() => got.length === 2 && invalid.length === 1);
    assert.deepEqual(got, ["boom", "next"]); assert.deepEqual(errors, [["handler exploded", t]]); assert.deepEqual(invalid, [["{not a message", t]]);
  } finally { await p.close(); }
});

test.after(async () => { if (admin) await admin.close(); });

test("clientNames() lists every connected client's SETNAME — the registry, straight from Redis", live, async () => {
  const a = await open("t-reg-a"), b = await open("t-reg-b");
  try {
    const names = await a.clientNames();
    assert.ok(names.includes("t-reg-a") && names.includes("t-reg-b"), JSON.stringify(names));
    await b.close();
    await until(async () => !(await a.clientNames()).includes("t-reg-b"));
  } finally { await a.close(); }
});
