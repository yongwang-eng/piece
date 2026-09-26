/** mains room over the real local Redis: a control from a live main is acted on; a spoofed sender is dropped. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedisRoomBus } from "../../lib/room/redis-bus.ts";
import { createPubSub, loadPubSubConfig } from "../../../packages/pi-pubsub/src/index.ts";
import { parseControl, planReload, senderIsLive, MAINS_RUN } from "./policy.ts";

let config;
try { config = loadPubSubConfig(); const probe = createPubSub({ ...config, connectTimeoutMs: 1500 }); await probe.connect(); await probe.close(); }
catch (e) { config = undefined; console.log(`# SKIPPING mains tests — local Redis not reachable: ${e.message}`); }
const live = { skip: config ? false : "local Redis not running" };
const until = (pred, ms = 4000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (pred()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timeout")); } }, 25); });

test("a reload from a live main is planned; the same envelope from a name nobody holds is dropped", live, async (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "mains-"));   // a private topic: (run, runDir) hash — never the machine-wide room
  const a = new RedisRoomBus({ run: MAINS_RUN, runDir }), b = new RedisRoomBus({ run: MAINS_RUN, runDir });
  t.after(async () => { await a.detach(); await b.detach(); });
  const heard = [];
  let readyA = false, readyB = false;
  const chA = a.attach("main@a#1", () => {}, () => { readyA = true; });
  b.attach("main@b#2", (ev) => heard.push(ev), () => { readyB = true; });
  await until(() => readyA && readyB);
  await until(async () => true);
  const peers = await b.peers();
  assert.ok(peers.includes("main@a#1") && peers.includes("main@b#2"), `CLIENT LIST shows both mains: ${peers}`);

  chA.publish({ id: "x", at: "t", from: "main@a#1", to: [], kind: "control", text: JSON.stringify({ cmd: "reload", scope: "extensions", reason: "crew ext" }) });
  await until(() => heard.length === 1);
  const env = heard[0].payload;
  assert.ok(senderIsLive(env.from, await b.peers()), "sender is a live main");
  assert.deepEqual(planReload({ scope: parseControl(env.text).scope, from: env.from, self: "main@b#2" }), { act: "ask-owner" }, "the owner is asked; nothing reloads by itself");

  chA.publish({ id: "y", at: "t", from: "main@ghost#9", to: [], kind: "control", text: JSON.stringify({ cmd: "reload", scope: "extensions" }) });
  await until(() => heard.length === 2);
  assert.ok(!senderIsLive(heard[1].payload.from, await b.peers()), "a claimed name that is not connected is dropped");

  chA.publish({ id: "z", at: "t", from: "main@a#1", to: [], kind: "control", text: JSON.stringify({ cmd: "reload", scope: "prompt" }) });
  await until(() => heard.length === 3);
  assert.deepEqual(planReload({ scope: "prompt", from: "main@a#1", self: "main@b#2" }), { act: "ask-owner" });
});
