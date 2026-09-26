/**
 * Inter-process: main + two workers in SEPARATE node processes, real RoomClient over RedisRoomBus, real Redis.
 * Two crews with identical member names run at once. Proves: join → main records member; main's request wakes
 * exactly the addressed worker (inject → pi.sendMessage); the worker's result reaches main; nothing crosses crews.
 * Needs 127.0.0.1:16379; skipped visibly otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPubSub, loadPubSubConfig } from "../../../packages/pi-pubsub/src/index.ts";
import { piInstallDir } from "../pi-install.mjs";

let config;
try { config = loadPubSubConfig(); const probe = createPubSub({ ...config, connectTimeoutMs: 1500 }); await probe.connect(); await probe.close(); }
catch (e) { config = undefined; console.log(`# SKIPPING redis-bus IPC test — local Redis not reachable: ${e.message}`); }
const live = { skip: config ? false : "local Redis not running" };

// One process = one member. Fake pi: `on` is a no-op (no session events), `sendMessage` = what the model would read.
const MEMBER = `
import { RoomClient } from ${JSON.stringify(new URL("./client.ts", import.meta.url).pathname)};
import { RedisRoomBus } from ${JSON.stringify(new URL("./redis-bus.ts", import.meta.url).pathname)};
const [run, runDir, name, role] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify({ name, run, ...o }) + "\\n");
const pi = { on() {}, events: { emit() {} }, sendMessage: (m) => out({ ev: "inject", content: m.content, from: m.details?.from }), registerTool() {} };
const isMain = name === "main";
const bus = new RedisRoomBus({ run, runDir, onError: (stage, e) => out({ ev: "error", stage, error: e.message }), onPublish: (p, r) => out({ ev: "publish", id: p.id, kind: p.kind, to: p.to, subscribers: r.subscribers }) });
const client = new RoomClient(pi, { run, runDir, isMain, registerNow: true, bus,
  card: { name, role, backend: isMain ? "main" : "crew", responsibility: role },
  observe: (env) => out({ ev: "observe", id: env.id, kind: env.kind, from: env.from, to: env.to, text: env.text }),
  intercept: isMain ? (env) => { if (env.kind === "result") { out({ ev: "result", from: env.from, text: env.text }); return true; } return false; } : undefined,
});
if (isMain) {
  // the worker's join is the readiness signal: main sends the task only after it is in the roster
  const seen = new Set();
  const tick = setInterval(() => {
    for (const m of client.roster().members) if (m.name !== "main" && !seen.has(m.name)) { seen.add(m.name); out({ ev: "joined", member: m.name }); }
    if (seen.size === 2) { clearInterval(tick); client.send({ to: ["reviewer"], kind: "request", text: "review " + run }); }
  }, 20);
}
process.stdin.on("data", (d) => { for (const line of d.toString().split("\\n").filter(Boolean)) { const c = JSON.parse(line); if (c.send) client.send(c.send); if (c.exit) { client.detachBus().then(() => process.exit(0)); } } });
setInterval(() => {}, 1000);
`;

// pi's bare imports (typebox, @earendil-works/*) resolve only inside pi's install; map them the way pi's loader does.
const PI = piInstallDir();
const HOOK = `
import { register } from "node:module";
register(new URL("data:text/javascript," + encodeURIComponent(\`
  export async function resolve(spec, ctx, next) {
    if (spec === "typebox" || spec.startsWith("@earendil-works/")) return next(spec, { ...ctx, parentURL: ${JSON.stringify("file://" + PI + "/dist/index.js")} });
    return next(spec, ctx);
  }\`)));
`;

const until = (pred, ms = 6000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (pred()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timed out waiting")); } }, 20); });

test("a JOIN published before main is subscribed is lost — the fact spawn's ready() gate exists for", live, async () => {
  const root = mkdtempSync(`${tmpdir()}/room-ipc-race-`);
  const script = `${root}/member.mjs`; writeFileSync(script, MEMBER); const hook = `${root}/hook.mjs`; writeFileSync(hook, HOOK);
  const events = []; const procs = [];
  const start = (run, name, role) => { const p = spawn(process.execPath, ["--import", hook, script, run, `${root}/${run}`, name, role], { stdio: ["pipe", "pipe", "inherit"] }); let buf = ""; p.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) events.push(JSON.parse(l)); }); procs.push(p); };
  const run = `race_${Date.now().toString(36)}`;
  try {
    start(run, "reviewer", "reviewer");                                      // worker first: its JOIN goes out with nobody listening
    await until(() => events.some((e) => e.name === "reviewer" && e.ev === "publish" && e.kind === "notice"));
    assert.equal(events.find((e) => e.name === "reviewer" && e.ev === "publish").subscribers, 1, "only the sender's own subscription heard it");
    start(run, "main", "coordinator");
    await until(() => events.some((e) => e.name === "main" && e.ev === "publish"));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(events.filter((e) => e.ev === "joined").length, 0, "main never learns of a member who joined before it was subscribed");
  } finally {
    for (const p of procs) { try { p.stdin.write(JSON.stringify({ exit: true }) + "\n"); } catch {} }
    await Promise.all(procs.map((p) => new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r(); }, 2000); p.on("exit", () => { clearTimeout(t); r(); }); })));
    rmSync(root, { recursive: true, force: true });
  }
});

test("two crews, three processes each: join → directed request wakes only the addressed worker → result reaches main; zero cross-crew traffic", live, async () => {
  const root = mkdtempSync(`${tmpdir()}/room-ipc-`);
  const script = `${root}/member.mjs`; writeFileSync(script, MEMBER);
  const hook = `${root}/hook.mjs`; writeFileSync(hook, HOOK);
  const events = [];
  const procs = [];
  const byName = new Map();
  const start = (run, name, role) => {
    const p = spawn(process.execPath, ["--import", hook, script, run, `${root}/${run}`, name, role], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = ""; p.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) events.push(JSON.parse(l)); });
    procs.push(p); byName.set(`${run}/${name}`, p); return p;
  };
  const stamp = Date.now().toString(36);
  const A = `ipcA_${stamp}`, B = `ipcB_${stamp}`;
  try {
    // production order: main is subscribed (its own join notice published) before any worker exists — spawn gates on rm.ready()
    for (const run of [A, B]) start(run, "main", "coordinator");
    await until(() => events.filter((e) => e.name === "main" && e.ev === "publish" && e.kind === "notice").length === 2);
    for (const run of [A, B]) { start(run, "reviewer", "reviewer"); start(run, "historian", "historian"); }
    // both mains receive both joins, send their request, and get a result back
    await until(() => events.filter((e) => e.ev === "joined").length === 4, 8000);
    // every worker JOIN reached its main: ≥2 subscriber connections (self + main), never 1
    for (const j of events.filter((e) => e.name !== "main" && e.ev === "publish" && e.kind === "notice")) assert.ok(j.subscribers >= 2, `JOIN heard by nobody: ${JSON.stringify(j)}`);
    const injected = (run) => events.filter((e) => e.run === run && e.ev === "inject");
    await until(() => injected(A).length >= 1 && injected(B).length >= 1);
    for (const run of [A, B]) {
      const inj = injected(run);
      assert.deepEqual(inj.map((e) => e.name), ["reviewer"], `${run}: only the addressed worker is woken`);
      assert.match(inj[0].content, new RegExp(`review ${run}`), "the worker reads the request text");
      // the historian saw it (observe: same topic, ambient) but was NOT injected — the lane, not the transport, decides
      assert.ok(events.some((e) => e.run === run && e.name === "historian" && e.ev === "observe" && e.kind === "request"));
    }
    // the reviewer in A replies; only A's main gets the result
    const reviewerA = byName.get(`${A}/reviewer`); reviewerA.stdin.write(JSON.stringify({ send: { to: ["main"], kind: "result", text: `done ${A}` } }) + "\n");
    await until(() => events.some((e) => e.ev === "result" && e.run === A));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(events.filter((e) => e.ev === "result").map((e) => [e.run, e.from, e.text]), [[A, "reviewer", `done ${A}`]]);
    // cross-crew: no process ever observed an envelope whose text names the other run
    for (const e of events.filter((e) => e.ev === "observe" || e.ev === "inject")) {
      const other = e.run === A ? B : A;
      assert.ok(!JSON.stringify(e).includes(other), `cross-crew leak: ${JSON.stringify(e)}`);
    }
    // Redis's own count: main's directed request reached 3 connections in its crew (2 peers + own subscription), never 6
    const req = events.filter((e) => e.ev === "publish" && e.kind === "request");
    assert.deepEqual(req.map((e) => e.subscribers), [3, 3]);
    assert.equal(events.filter((e) => e.ev === "error").length, 0, JSON.stringify(events.filter((e) => e.ev === "error")));
  } finally {
    for (const p of procs) { try { p.stdin.write(JSON.stringify({ exit: true }) + "\n"); } catch {} }
    await Promise.all(procs.map((p) => new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r(); }, 2000); p.on("exit", () => { clearTimeout(t); r(); }); })));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Redis down: main and worker fail LOUDLY (connect error surfaced), never a silent hang; nothing is delivered", async () => {
  const root = mkdtempSync(`${tmpdir()}/room-ipc-down-`);
  const script = `${root}/member.mjs`; writeFileSync(script, MEMBER);
  const hook = `${root}/hook.mjs`; writeFileSync(hook, HOOK);
  // an agent dir whose pubsub.json points at a port nothing listens on
  mkdirSync(`${root}/agent/config`, { recursive: true });
  writeFileSync(`${root}/agent/config/pubsub.json`, JSON.stringify({ host: "127.0.0.1", port: 1, passwordEnv: "X_PUBSUB_TEST" }));
  const events = []; const procs = [];
  const start = (run, name, role) => {
    const p = spawn(process.execPath, ["--import", hook, script, run, `${root}/${run}`, name, role], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PI_CODING_AGENT_DIR: `${root}/agent`, X_PUBSUB_TEST: "irrelevant" } });
    let buf = ""; p.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) events.push(JSON.parse(l)); });
    procs.push(p);
  };
  try {
    start("down", "main", "coordinator"); start("down", "reviewer", "reviewer");
    await until(() => events.filter((e) => e.ev === "error" && e.stage === "connect").length === 2, 8000);
    for (const e of events.filter((e) => e.ev === "error")) assert.match(e.error, /no Redis at 127\.0\.0\.1:1|ECONNREFUSED/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(events.filter((e) => e.ev === "joined" || e.ev === "inject" || e.ev === "publish").length, 0, "nothing can be delivered without the broker");
  } finally {
    for (const p of procs) { try { p.stdin.write(JSON.stringify({ exit: true }) + "\n"); } catch {} }
    await Promise.all(procs.map((p) => new Promise((r) => { const t = setTimeout(() => { p.kill("SIGKILL"); r(); }, 2000); p.on("exit", () => { clearTimeout(t); r(); }); })));
    rmSync(root, { recursive: true, force: true });
  }
});
