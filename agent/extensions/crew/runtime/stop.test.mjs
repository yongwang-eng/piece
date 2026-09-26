import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { agentDbPath, openCrewStore } from "../../../lib/database/store.ts";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import * as tmuxHelpers from "./tmux.ts";
import { allocatedNames } from "../runtime/names.ts";
import * as communication from "../../../lib/room/communication.ts";
import * as board from "../ui/board.ts";
import * as identity from "../../../lib/agent-ui/identity.ts";
import { WorkerIds, resolveChild } from "../../../lib/agent-ui/ids.ts";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// Execute production closures; only process, transport, disk and UI boundaries are fixtures.
function harness(options = {}) {
  let api, roomOptions, nextSpec, nextPane = 20, nextAgentId = 100, sessionGate, childGate, killGate, splitGate, borderGate, deadPaneForm = "error";
  const calls = [], logs = [], members = [], sessions = [], tools = new Map();
  const panes = new Set(["%2", "%3"]), survivors = new Set();
  const source = stripTypeScriptTypes(process.env.PI_TEST_PRE_STOP === "1" ? execFileSync("git", ["show", "d0ac105:agent/extensions/crew/index.ts"], { encoding: "utf8" }) : readFileSync(process.env.CREW_STOP_BASE_SOURCE ?? new URL("../index.ts", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export default function", "function main")
    .replace(/}\s*$/, "capture({ workers, specOf, respawns, refresh, respawnSuccessor, kill, sendWhenIdle });\n}");
  const room = {
    roster: () => ({ members, revision: 0 }), rosterForBrief: () => [],
    memberLeft(name) { const m = members.find((m) => m.name === name); if (m) m.presence = "gone"; },
    memberJoined(m) {
      if (options.registry) roomOptions.validateMember({ ...m, sessionId: `session-of-${m.name}` });
      members.push({ ...m, address: `redis:${m.name}` });
    }, presence() {}, send() {}, tail: () => [], ready: () => true, namespace: "room/fixture",
  };
  // The transport fixture: liveness = who is "connected" (the sessions list); the sessions gate suspends inside peers().
  class RedisRoomBus {
    constructor(o) { this.run = o.run; }
    isConnected() { return true; }
    async peers() {
      if (sessionGate) { const g = sessionGate; sessionGate = undefined; g.entered.resolve(); await g.release.promise; }
      return sessions.map((s) => s.name);
    }
    async detach() {}
  }
  runInNewContext(`${source}\nmain(pi);`, {
    ...tmuxHelpers, ...board, allocatedNames, ...communication, ...identity, WorkerIds, resolveChild,
    applyDot: async () => undefined, postNote: () => {}, classifyRepo: () => "unknown", loadClassRows: () => [], mistakeShape: () => undefined, where: () => "11 harness", loadMcpInventory: () => ({}), grantsFor: () => ({ tools: [], servers: [] }), mcpNameViolations: () => [],
    boardOf: () => ({ section() {}, remove() {} }),
    agentDbPath, installUsageCapture() {}, installCompactionCapture() {}, problems: () => ({ report() {}, list: () => [], clear() {} }), AbortSignal, fetch: () => Promise.resolve({ ok: true }),
    sharedRegistry: () => options.registry ?? (() => ({ owner: { agentId: 'agent_1' }, store: { namespace: 'fixture',
      resolveCrew: (_owner, ref) => ({ id: ref }), ownedCrews: () => [], openCrews: () => [],
      registerWorker: () => ({ id: `agent_${nextAgentId++}` }),
    } })),
    newestSourceMtime: () => 0, isStale: () => false, STALE_HINT: "stale", holdMessage: (r) => `[HOLD] ${r ?? ""}`, resumeMessage: (t) => `[RESUME] ${t ?? ""}`, HELD_DETAIL: "⏸ held",
    loadModelRegistry: () => ({ tiers: {} }), resolveWorkerModel: (p, _r, fb) => p.model ?? fb,
    capture(value) { api = value; },
    process: { env: { HOME: "/fixture", TMUX_PANE: "%1" }, cwd: () => "/fixture" },
    RedisRoomBus,
    pi: { registerTool(t) { tools.set(t.name, t); }, registerCommand() {}, on() {} },
    Type: new Proxy({}, { get: () => () => ({}) }),
    registerRoomCardRenderer() {}, RoomClient: class { constructor(_pi, opts) { roomOptions = opts; return room; } },
    Governor: class { modelLabel = "fixture/model"; on() { return () => {}; } async warm() {} reset() {} },
    existsSync: (path) => path === "/fixture" || path.endsWith("constitution.md"),
    readFileSync() { throw new Error("no fixture file"); }, mkdirSync() {}, writeFileSync() {},
    appendFileSync(_path, text) { logs.push(JSON.parse(text)); },
    artifactHome: () => ({ dir: "/fixture/artifacts", name: "fixture" }),
    ensureRunArtifacts: () => ({ created: false }), ensureWorkerArtifacts: () => "/fixture/artifacts/worker",
    planScaffold: () => "", editPlan() {}, rosterRow: () => "", addRosterRow: () => "",
    workerCommand(spec) { nextSpec = spec; return "fixture-command"; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    setTimeout, clearTimeout,
    execFile(command, args, ...rest) {
      calls.push({ command, args });
      const cb = rest.at(-1);
      if (command === "pgrep") {
        if (childGate) { const g = childGate; childGate = undefined; g.entered.resolve(); g.release.promise.then(() => cb(new Error("no child"), "", "")); }
        else cb(null, "child", "");
        return;
      }
      if (command !== "tmux") { cb(null, "", ""); return; }
      const pane = args[args.indexOf("-t") + 1];
      if (args[0] === "kill-pane") {
        const finish = () => { if (!survivors.has(pane)) panes.delete(pane); cb(null, "", ""); };
        if (killGate) { const g = killGate; killGate = undefined; g.entered.resolve(); g.release.promise.then(finish); } else finish();
      } else if (args[0] === "display" && args.at(-1) === "#{pane_pid}") {
        // Real tmux reports a dead pane BOTH ways: an error, or exit 0 with an EMPTY pid (observed live 2026-09-11).
        if (panes.has(pane)) cb(null, "123", ""); else if (deadPaneForm === "empty") cb(null, "", ""); else cb(new Error("can't find pane"), "", "can't find pane");
      } else if (args[0] === "split-window") {
        options.onSplit?.(nextSpec);
        // a live worker connects to Redis and announces its JOIN a beat after its pane exists
        const finish = () => { const pane = `%${nextPane++}`; panes.add(pane); sessions.push({ name: nextSpec.name, status: "idle" }); setTimeout(() => members.push({ name: nextSpec.name, address: `redis:${nextSpec.name}`, joinedAt: new Date().toISOString() }), 5); cb(null, pane, ""); };
        if (splitGate) { const g = splitGate; splitGate = undefined; g.entered.resolve(); g.release.promise.then(finish); } else finish();
      } else if (args[0] === "set-option" && borderGate) {
        const g = borderGate; borderGate = undefined; g.entered.resolve(); g.release.promise.then(() => cb(null, "", ""));
      } else cb(null, args.at(-1) === "#{window_width}" ? "120" : "", "");
    },
  });
  const add = (name = "worker", pane = "%2") => {
    const w = { id: members.length + 1, name, run: "fixture-run", pane, mainPane: "%1", cwd: "/fixture", role: "worker", spawnedAt: new Date(Date.now() - 60_000).toISOString() };
    api.workers.set(name, w); api.specOf.set(name, { role: name, task: "fixture", run: w.run, mainCwd: "/fixture" }); members.push({ ...w, joinedAt: w.spawnedAt }); return w;
  };
  const gate = (kind) => {
    const g = { entered: deferred(), release: deferred() };
    if (kind === "child") childGate = g; else if (kind === "kill") killGate = g; else if (kind === "split") splitGate = g; else if (kind === "border") borderGate = g; else sessionGate = g;
    return g;
  };
  return { api, add, gate, calls, logs, panes, survivors, setDeadPaneForm: (f) => { deadPaneForm = f; }, tool: (name, params) => tools.get(name).execute("test", params), kill: (worker) => tools.get("crew_kill").execute("test", { worker }), splits: () => calls.filter((c) => c.args[0] === "split-window") };
}

test("stop during suspended child liveness check cannot spawn a successor", async () => {
  const h = harness(); h.add(); const g = h.gate("child");
  const sweep = h.api.refresh(); await g.entered.promise;
  await h.kill("worker"); g.release.resolve(); await sweep;
  await new Promise(setImmediate);
  assert.equal(h.logs.some((l) => l.event === "worker_gone"), false);
  assert.equal(h.splits().length, 0);
});

test("kill all cancels recovery suspended at spawn admission", async () => {
  const h = harness(); const w = h.add(); h.api.workers.delete(w.name);
  const g = h.gate("sessions"); const recovery = h.api.respawnSuccessor(w, "crashed"); await g.entered.promise;
  await h.kill("all"); g.release.resolve(); await recovery;
  assert.equal(h.splits().length, 0);
});

test("genuine crash without stop still spawns a successor", async () => {
  const h = harness(); const w = h.add(); h.panes.delete(w.pane);
  await h.api.refresh(); await new Promise(setImmediate);
  assert.equal(h.splits().length, 1);
  assert.ok(h.logs.some((l) => l.event === "respawned"));
});

test("surviving pane cannot be reported stopped or forgotten", async () => {
  const h = harness(); const w = h.add(); h.survivors.add(w.pane);
  const result = await h.kill(w.name);
  assert.match(result.content[0].text, /shutdown.unverified/i);
  assert.equal(h.api.workers.get(w.name), w);
  assert.equal(h.logs.some((l) => l.event === "worker_killed"), false);
});

test("kill all marks later targets before awaiting first cleanup", async () => {
  const h = harness(); h.add("first"); const second = h.add("second", "%3");
  const g = h.gate("kill"); const stop = h.kill("all"); await g.entered.promise;
  await h.api.respawnSuccessor(second, "crashed");
  g.release.resolve(); await stop;
  assert.equal(h.splits().length, 0);
});

test("old liveness snapshot cannot remove a reused name", async () => {
  const h = harness(); const old = h.add(); const g = h.gate("child");
  const sweep = h.api.refresh(); await g.entered.promise;
  const replacement = { ...old, id: 99, pane: "%3" }; h.api.workers.set(old.name, replacement);
  g.release.resolve(); await sweep; await new Promise(setImmediate);
  assert.equal(h.api.workers.get(old.name), replacement);
  assert.equal(h.splits().length, 0);
});

test("stop during in-flight pane creation cleans the late pane without delivering a task", async () => {
  const h = harness(); const w = h.add(); h.api.workers.delete(w.name);
  const g = h.gate("split"); const recovery = h.api.respawnSuccessor(w, "crashed"); await g.entered.promise;
  const result = await h.kill("all");
  assert.match(result.content[0].text, /stop requested/);
  g.release.resolve(); await recovery;
  assert.equal(h.panes.has("%20"), false);
  assert.equal(h.logs.some((l) => l.event === "task_sent" || l.event === "respawned"), false);
});

test("idle recovery never types into a stopped lifetime (status is a local map now — no suspension between check and keystroke)", async () => {
  const h = harness(); const w = h.add();
  await h.kill(w.name);
  await h.api.sendWhenIdle(w.run, w.name, w.pane, "/model next", "model_switch_sent");
  assert.equal(h.calls.some((c) => c.args[0] === "send-keys"), false);
  // and a live one does get the keystroke — the guard is the lifetime, not a dead code path
  const live = h.add("live", "%3");
  await h.api.sendWhenIdle(live.run, live.name, live.pane, "/model next", "model_switch_sent");
  assert.equal(h.calls.some((c) => c.args[0] === "send-keys"), true);
});

test("observed stop preserves unrelated worker and reports only verified shutdown", async () => {
  const h = harness(); const w = h.add(); const other = h.add("other", "%3");
  const result = await h.kill(w.name);
  assert.match(result.content[0].text, /worker: stopped/);
  assert.equal(h.panes.has(w.pane), false);
  assert.equal(h.api.workers.get(other.name), other);
  assert.equal(h.panes.has(other.pane), true);
});

test("REAL TMUX FORM: dead pane = exit 0 + empty pid — kill must report stopped, not unverified, and must not leave a ghost row", async () => {
  const h = harness(); h.add(); h.setDeadPaneForm("empty");
  const r = await h.kill("worker");
  assert.match(r.content[0].text, /worker: stopped/, `got: ${r.content[0].text}`);
  assert.equal(h.api.workers.has("worker"), false, "ghost row left on the roster");
  assert.equal(h.logs.some((l) => l.event === "worker_shutdown_unverified"), false);
  assert.equal(h.logs.some((l) => l.event === "worker_killed"), true);
});

test("hold pauses every live worker once; resume lifts all; a held worker stays held across an ordinary steer", async () => {
  const h = harness(); h.add("a", "%2"); h.add("b", "%3");
  const r1 = await h.tool("crew_hold", { reason: "direction may change" });
  assert.deepStrictEqual([...r1.details.held].sort(), ["a", "b"]);
  assert.equal(h.logs.filter((l) => l.event === "worker_held").length, 2);
  const r2 = await h.tool("crew_hold", {});                       // idempotent — nothing new to hold
  assert.equal(r2.details.held.length, 0);
  await h.tool("crew_send", { worker: "a", text: "fyi" });        // an ordinary send must NOT lift the hold
  const r3 = await h.tool("crew_resume", { direction: "go" });
  assert.deepStrictEqual([...r3.details.resumed].sort(), ["a", "b"]);
  assert.equal(h.logs.filter((l) => l.event === "worker_resumed").length, 2);
  const r4 = await h.tool("crew_resume", {});
  assert.equal(r4.details.resumed.length, 0);
});

test("killing a held worker clears its hold — resume afterwards has nothing to lift", async () => {
  const h = harness(); h.add("a", "%2");
  await h.tool("crew_hold", {});
  await h.kill("a");
  const r = await h.tool("crew_resume", {});
  assert.equal(r.details.resumed.length, 0);
});

test("automatic recovery stops after two successors regardless of their generated names", async t => {
  const h = harness(); let worker = h.add();
  for (let attempt = 0; attempt < 3; attempt++) {
    h.api.workers.delete(worker.name);
    await h.api.respawnSuccessor(worker, "crashed");
    if (attempt < 2) {
      const successor = [...h.api.workers.values()].at(-1);
      assert.ok(successor && successor !== worker);
      worker = successor;
    }
  }
  const recoveries = h.splits().length;
  const independent = h.add("other", "%99");
  h.api.workers.delete(independent.name);
  await h.api.respawnSuccessor(independent, "crashed");
  const independentRecoveries = h.splits().length - recoveries;
  assert.equal(independentRecoveries, 1);
  t.diagnostic(`independent-worker control: ${independentRecoveries} recovery; target chain: ${recoveries}`);
  assert.equal(recoveries, 2);
});

for (const mode of ['seed', 'preserve']) test(`startup must ${mode} recovery ancestry before registration finishes`, async () => {
  const h = harness(), parent = h.add(); h.api.workers.delete(parent.name);
  const gate = h.gate('border');
  const recovery = h.api.respawnSuccessor(parent, 'crashed'); await gate.entered.promise;
  const child = [...h.api.workers.values()].at(-1);
  try {
    if (mode === 'seed') assert.equal(h.api.respawns.get(child), 1);
    else h.api.respawns.set(child, 2);
  } finally { gate.release.resolve(); await recovery; }
  if (mode === 'preserve') assert.equal(h.api.respawns.get(child), 2);
});

test('production spawn registers global identity before process creation and binds the announced session', async () => {
  const dir = mkdtempSync(`${tmpdir()}/crew-spawn-registry-`), store = openCrewStore(`${dir}/crew.sqlite`);
  try {
    const owner = store.claimMain(store.ensureMain('real-main-session').id, 'main-instance');
    let launches = 0;
    const h = harness({ registry: () => ({ store, owner }), onSplit(spec) {
      const agent = store.getAgent(`agent_${spec.id}`);
      assert.equal(agent.name, spec.name, 'identity must be committed before launching its process');
      assert.equal(agent.sessionId, null);
      assert.match(spec.run, /^crew_[1-9][0-9]*$/);
      launches++;
    } });
    const first = await h.tool('crew_spawn', { role: 'worker', task: 'fixture task', run: 'first' });
    assert.equal(first.isError, undefined, first.content[0].text);
    const second = await h.tool('crew_spawn', { role: 'worker', task: 'fixture task', run: 'second' });
    assert.equal(second.isError, undefined, second.content[0].text);
    assert.equal(launches, 2);
    assert.notEqual(first.details.id, second.details.id);
    assert.notEqual(first.details.run, second.details.run);
    const agent = store.getAgent(`agent_${first.details.id}`);
    assert.equal(agent.sessionId, `session-of-${first.details.name}`);
    assert.equal('state' in agent, false);
    assert.equal(store.listMembers(first.details.run)[0].id, owner.agentId);
    assert.equal(store.listMembers(second.details.run)[0].id, owner.agentId);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
