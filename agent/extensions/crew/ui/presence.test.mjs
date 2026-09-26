import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as lifecycle from "../../../lib/governor/lifecycle.ts";
import { agentDbPath } from "../../../lib/database/store.ts";
import { chooseDeadRequestRung } from "../runtime/failover.ts";
import * as governorPrompt from "../../../lib/governor/prompt.ts";
import { readPredecessor } from "../../../lib/room/artifacts.ts";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { allocatedNames } from "../runtime/names.ts";
import * as communication from "../../../lib/room/communication.ts";
import * as progress from "../../../lib/room/progress.ts";
import * as board from "./board.ts";
import { fit } from "../../../lib/agent-ui/width.ts";
import * as consult from "../../../lib/room/consult.ts";
import * as identity from "../../../lib/agent-ui/identity.ts";
import { PRESENCE_GLYPH } from "../../../lib/room/card.ts";
import { WorkerIds } from "../../../lib/agent-ui/ids.ts";

test("room cards use the compacting glyph", () => {
  assert.equal(PRESENCE_GLYPH.compacting, "◐");
});

// Keep the main factory and callbacks real; only process/transport/UI boundaries are fake.
function mainHarness(files = {}, governorAPI = {}, mainSource) {
  let now = 1_000_000;
  let api, options, widget;
  let governorReply = { kind: "answer", text: "proceed" };
  const calls = [], roster = [], logs = [], messages = [];
  const killedPanes = new Set();
  const commands = new Map();
  const events = new Map();
  let secretResolver; const leasedNames = {};
  const governorCalls = [];
  const timeouts = [];
  const observed = new Map(), waiters = new Map();
  const signal = (key, value) => { observed.set(key, value); waiters.get(key)?.(value); };
  const waitFor = (key) => observed.has(key) ? Promise.resolve(observed.get(key)) : new Promise((resolve) => waiters.set(key, resolve));
  let source = stripTypeScriptTypes(mainSource ?? readFileSync(new URL("../index.ts", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace("export default function", "function main");
  if (process.env.PI_TEST_OMIT_HANDOFF === "1") source = source.replace('handoff: (name, reason) =>', 'omittedHandoff: (name, reason) =>');
  if (process.env.PI_TEST_OMIT_PRESENCE === "1") source = source.replace('onCompactionPresence(run, env.from, env.text);', '/* mutation: lost shim notice */');
  source = source.replace(/}\s*$/, `capture({ workers, presence, wireStatus, refresh, room, kill, onDeadRequest, onConsult, onProgress, milestones, answerConsult, ensureTicker, performOperation, ...(typeof governors === "undefined" ? {} : { governors }), setup(u) { ui = u; } });\n}`);
  const theme = { fg: (tone, text) => `<${tone}>${text}</${tone}>`, bold: (text) => `<bold>${text}</bold>` };
  runInNewContext(`${source}\nmain(pi);`, {
    ...board, allocatedNames, ...communication, ...progress, ...identity, ...consult, WorkerIds, readPredecessor, fit, chooseDeadRequestRung,
    applyDot: async (pane, ev) => { calls.push({ command: "tmux-dot", args: [pane, ev.type] }); }, postNote: (n) => { calls.push({ command: "halo", args: [n.id, n.title] }); }, classifyRepo: () => "unknown", loadClassRows: () => [], mistakeShape: () => undefined, where: () => "11 harness", loadMcpInventory: () => ({}), grantsFor: () => ({ tools: [], servers: [] }), mcpNameViolations: () => [],
    boardOf: () => ({ section(s) { widget = { render: (w) => s.render(w, theme) }; }, remove() { widget = undefined; } }),
    agentDbPath, installUsageCapture() {}, installCompactionCapture() {}, problems: () => ({ report() {}, list: () => [], clear() {} }), withWait: (r) => r, waitsFor: () => new Map(),
    sharedRegistry: () => () => ({ owner: { agentId: 'agent_1' }, store: { namespace: 'fixture', ownedCrews: () => [], openCrews: () => [] } }),
    readFileSync(path) { if (path in files) return files[path]; if (path.endsWith("/halo_pill/sources.json")) return JSON.stringify({ sources: [{ name: "pi-crew", token: "t" }] }); throw new Error("missing fixture"); },
    AbortSignal, fetch(url, init) { calls.push({ command: "halo", args: [url, JSON.parse(init.body).title] }); return Promise.resolve({ ok: true }); },
    capture(value) { api = value; },
    process: { env: { HOME: "/fake", TMUX_PANE: "%1" }, cwd: () => "/work" },
    RedisRoomBus: class { constructor(o) { this.run = o.run; } isConnected() { return true; } async peers() { return [...api.workers.keys()]; } async detach() {} },
    Date: class extends Date { static now() { return now; } },
    recoverWorker(root, name, all) { calls.push({ command: "recover", args: [root, name, all] }); return [{ name, run: "run", sessionFile: "02.jsonl", span: "start → end", lastAssistantText: "recovered answer", paths: [{ path: "/vault/report.md", success: true }, { path: "src/file.ts", success: false, command: "cat > src/file.ts" }], tools: 7, malformed: 1 }]; },
    pi: { registerTool() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, handler) { events.set(name, handler); }, sendMessage(message, options) { messages.push({ message, options }); },
      events: { on() { return () => {}; }, emit(name, payload) { if (name === "secret:resolve") secretResolver?.(payload); if (name === "secret:leased") payload.resolve(leasedNames[payload.ref]); } } },
    writeFileSync(path, value, opts) { calls.push({ command: "write", args: [path, value, opts?.mode] }); },
    Type: new Proxy({}, { get: () => () => ({}) }),
    Governor: class {
      modelLabel = "provider/governor-model";
      constructor(options) { this.id = governorCalls.filter((c) => c.kind === "instance").length; if (this.id > 0) this.modelLabel = "provider/second-model"; governorCalls.push({ kind: "instance", id: this.id, options }); }
      on(hooks) { this.hooks = hooks; return () => governorCalls.push({ kind: "detach", id: this.id }); }
      async warm() { governorCalls.push({ kind: "warm", id: this.id }); this.hooks?.onSession?.({}); }
      reset() { governorCalls.push({ kind: "reset", id: this.id }); }
      async ask(request) { governorCalls.push({ kind: "ask", id: this.id, run: request.run }); return governorReply; }
      packet() { return new Promise(() => {}); }
    },
    registerRoomCardRenderer() {}, sharedGovernor: (options) => { governorCalls.push({ kind: "options", options }); return { modelLabel: "provider/governor-model", on: () => () => governorCalls.push({ kind: "detach" }), warm: async () => { governorCalls.push({ kind: "warm" }); }, reset: () => governorCalls.push({ kind: "reset" }), ask: async () => { governorCalls.push({ kind: "ask" }); return governorReply; }, packet: () => new Promise(() => {}) }; },
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); signal(`timeout:${ms}`, fn); return {}; },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    existsSync: () => false, mkdirSync() {}, rmSync() {}, appendFileSync(_path, text) { logs.push(text); signal(`log:${JSON.parse(text).event}`, text); },
    focusMovingVerb: () => undefined, resolveChild: (_workers, name) => name,
    newestSourceMtime: () => 0, isStale: () => false, STALE_HINT: "stale", holdMessage: (r) => `[HOLD] ${r ?? ""}`, resumeMessage: (t) => `[RESUME] ${t ?? ""}`, HELD_DETAIL: "⏸ held",   // staleness.ts — the sandbox has no real source tree
    killArgs: (pane) => ["kill-pane", "-t", pane],
    execFile(command, args, ...rest) {
      calls.push({ command, args });
      const pane = args[args.indexOf("-t") + 1];
      if (args[0] === "kill-pane") killedPanes.add(pane);
      if (args[0] === "display" && killedPanes.has(pane)) { rest.at(-1)(new Error("can't find pane"), "", "can't find pane"); return; }
      rest.at(-1)(null, command === "pgrep" ? "456" : "123", "");
    },
    ...governorAPI,
    RoomClient: class {
      constructor(_pi, opts) { options = opts; }
      presence(name, state) { roster.push({ name, state }); }
      roster() { return { members: [] }; }
      tail() { return []; }
      send() {}
      memberLeft(name) { roster.push({ name, state: "gone" }); }
    },
  });
  api.setup({
    hasUI: true, ui: { notify() {}, setWidget(_id, factory) { widget = factory?.({}, theme); } },
  });
  const worker = { id: 4, name: "historian", run: "run", pane: "%2", spawnedAt: new Date(now).toISOString() };
  api.workers.set(worker.name, worker);
  api.room("run");
  api.wireStatus.set("historian", "thinking");                                                  // the worker's first status notice, already folded in
  return {
    calls, roster, logs, api, messages, timeouts, governorCalls, waitFor,
    resolveSecret(fn) { secretResolver = fn; },
    lease(ref, name) { leasedNames[ref] = name; },
    emit: (event) => events.get(event)?.(),
    governorReply(value) { governorReply = value; },
    ask: (id, kind = "confirm") => api.onConsult("run", { from: "historian", text: JSON.stringify({ consult: { id, kind, question: "Proceed?" } }) }),
    command: (raw) => commands.get("crew_cli").handler(raw, { hasUI: true, ui: { notify(text) { messages.push({ notification: text }); }, setWidget(_id, factory) { widget = factory?.({}, theme); } } }),
    handoff: (name, reason) => options.handoff?.(name, reason),
    turnEnd: (stop, from = "historian") => options.intercept({ kind: "notice", task: "turn_end", from, text: JSON.stringify({ stop }) }),
    advance(ms) { now += ms; },
    // the worker publishes its board status as a room notice (idle · thinking · tool:<name>); main folds it into the row
    status(value, from = "historian") { options.intercept({ kind: "notice", task: "state", from, text: value }); },
    vitals(median, from = "historian") { return options.intercept({ kind: "notice", task: "vitals", from, text: JSON.stringify({ contextPct: 10, firstTokenMedianMs: median }) }); },
    notice(state, prior) { return options.intercept({ kind: "notice", task: "presence", from: "historian", text: JSON.stringify({ state, prior }) }); },
    peer() { options.intercept({ kind: "notice", task: "state", from: "historian", text: "thinking" }); },
    lines: () => widget?.render(120).join("\n") ?? "",
  };
}

for (const prior of ["working", "idle"]) {
  test(`main preserves compacting over stale intercom, renders amber, then restores ${prior}`, async () => {
    const h = mainHarness();
    await h.api.refresh();
    assert.equal(h.notice("compacting", prior), true);
    for (const ms of [120_001, 600_001]) {
      h.advance(ms);
      h.peer();
      await h.api.refresh();
      assert.match(h.lines(), /<warning>◐<\/warning>/);
      assert.match(h.lines(), /compacting/);
      assert.equal(h.roster.at(-1).state, "compacting");
      assert.equal(h.calls.some((c) => c.command === "halo" || c.args[0] === "kill-pane"), false);
      assert.equal(h.logs.some((l) => /worker_stalled|worker_wedged/.test(l)), false);
    }
    assert.ok(h.calls.some((c) => c.args.includes("pane-border-format") && c.args.at(-1).includes("bg=#f9e2af")));
    h.notice("restored", prior);
    assert.equal(h.roster.at(-1).state, prior);
    assert.equal(h.api.presence.get("historian").status, prior === "working" ? "thinking" : "idle");
    h.status("tool:read");
    await h.api.refresh();
    assert.match(h.lines(), /read/);
    assert.doesNotMatch(h.lines(), /compacting/);
    h.status("thinking");
    await h.api.refresh();
    h.advance(120_001);
    await h.api.refresh();
    assert.ok(h.calls.some((c) => c.command === "halo"), "normal stall alarm resumes after restoration");
  });
}

test("member removal clears the compaction override", async () => {
  const h = mainHarness();
  h.notice("compacting", "working");
  const worker = h.api.workers.get("historian");
  await h.api.kill("historian", "test removal");
  assert.equal(h.roster.at(-1).state, "gone");
  h.api.workers.set("historian", worker);
  await h.api.refresh();
  assert.equal(h.api.presence.get("historian").status, "thinking");
});

test("compacting after a notified stall clears main's blocked status", async () => {
  const h = mainHarness();
  await h.api.refresh();
  h.advance(120_001);
  await h.api.refresh();
  assert.ok(h.calls.some((c) => c.command === "tmux-dot" && c.args[1] === "blocked"));
  h.notice("compacting", "working");
  await h.api.refresh();
  assert.ok(h.logs.some((l) => /worker_unstalled/.test(l)));
  assert.ok(h.calls.some((c) => c.command === "tmux-dot" && c.args[1] === "unblocked"));
});

test("main consumes first-token median vitals for board and alarm thresholds", async () => {
  const h = mainHarness();
  await h.api.refresh();
  h.vitals(50_000);
  h.advance(120_001);
  await h.api.refresh();
  assert.doesNotMatch(h.lines(), /stalled/);
  assert.equal(h.calls.some((c) => c.command === "halo"), false);
  h.advance(80_000);
  await h.api.refresh();
  assert.match(h.lines(), /stalled/);
  assert.ok(h.calls.some((c) => c.command === "halo"));
});

test("main keeps median thresholds per worker and clears them on removal", async () => {
  const h = mainHarness();
  const worker = h.api.workers.get("historian");
  h.api.workers.set("reviewer", { ...worker, name: "reviewer", pane: "%3", id: 5 });
  h.status("thinking", "reviewer");
  await h.api.refresh();
  h.vitals(50_000);
  h.vitals(10_000, "reviewer");
  h.advance(120_001);
  await h.api.refresh();
  assert.match(h.lines(), /◆.*reviewer/);
  assert.match(h.lines(), /●.*historian/);
  await h.api.kill("historian", "test removal");
  h.api.workers.set("historian", worker);
  await h.api.refresh();
  h.advance(120_001);
  await h.api.refresh();
  assert.match(h.lines(), /◆.*historian/);
});

test("main builds member_left handoff from predecessor disk and last room vitals/message", () => {
  const folder = mkdtempSync(`${tmpdir()}/crew-handoff-`);
  try {
    writeFileSync(`${folder}/deliverable.md`, "progress: ready for review\n# Draft\n");
    writeFileSync(`${folder}/decisions.md`, "### Latest choice\nwhy\n");
    const messages = [
      { type: "message", from: "historian", kind: "inform", text: "older message" },
      { type: "message", from: "historian", kind: "inform", text: "last message" },
      { type: "message", from: "historian", kind: "notice", task: "vitals", text: JSON.stringify({ tools: 42 }) },
    ];
    const h = mainHarness({
      "/fake/.pi/agent/workers/runs/fixture/run/artifacts.json": JSON.stringify({ dir: `${folder}/..` }),
      "/fake/.pi/agent/workers/runs/fixture/run/room.jsonl": messages.map((m) => JSON.stringify(m)).join("\n"),
    });
    // The actual vault folder uses the member name; use its basename here.
    const name = folder.split("/").at(-1);
    messages.forEach((m) => { m.from = name; });
    const mapped = mainHarness({
      "/fake/.pi/agent/workers/runs/fixture/run/artifacts.json": JSON.stringify({ dir: `${folder}/..` }),
      "/fake/.pi/agent/workers/runs/fixture/run/room.jsonl": messages.map((m) => JSON.stringify(m)).join("\n"),
    });
    const facts = mapped.handoff(name, "wedged");
    assert.ok(facts, "main must supply a handoff callback to RoomClient");
    assert.equal(facts.progress, "ready for review");
    assert.equal(facts.lastDecision, "Latest choice");
    assert.equal(facts.lastMessage, "inform: last message");
    assert.equal(facts.lastMessages, undefined);
    assert.equal(facts.folder, undefined);
    assert.equal(facts.files[0].head, undefined);
    assert.ok(facts.files.every((f) => Object.keys(f).sort().join(",") === "bytes,lines,name"));
    assert.equal(facts.tools, 42);
    assert.equal(facts.reason, "wedged");
    assert.equal(facts.files.find((f) => f.name === "deliverable.md").bytes, 35);
    const missing = h.handoff("missing", "gone");
    assert.equal(missing.files.length, 0);
    assert.equal(missing.reason, "gone");
    assert.equal(missing.tools, null);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("handoff bounds prose and keeps evidence as one count entry without file heads", () => {
  const folder = mkdtempSync(`${tmpdir()}/crew-handoff-`);
  const name = folder.split("/").at(-1);
  try {
    writeFileSync(`${folder}/deliverable.md`, `progress: ${"p".repeat(300)}\n`);
    writeFileSync(`${folder}/decisions.md`, `### ${"d".repeat(200)}\n### older\n`);
    mkdirSync(`${folder}/evidence`);
    writeFileSync(`${folder}/evidence/a.log`, "a");
    writeFileSync(`${folder}/evidence/b.log`, "b");
    const h = mainHarness({
      "/fake/.pi/agent/workers/runs/fixture/run/artifacts.json": JSON.stringify({ dir: `${folder}/..` }),
      "/fake/.pi/agent/workers/runs/fixture/run/room.jsonl": JSON.stringify({ type: "message", from: name, kind: "inform", text: "m".repeat(300) }),
    });
    const facts = h.handoff(name, "gone");
    assert.equal(facts.progress, "p".repeat(200));
    assert.equal(facts.lastDecision, "d".repeat(120));
    assert.equal(facts.lastMessage, `inform: ${"m".repeat(192)}`);
    assert.equal(facts.decisions, 2);
    assert.equal(facts.files.find((f) => f.name === "evidence/").lines, 2);
    assert.ok(facts.files.every((f) => f.head === undefined));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("crew_cli recover prints session recovery without starting a turn or worker", async () => {
  const h = mainHarness();
  await h.command("recover historian");
  assert.ok(h.calls.some((c) => c.command === "recover" && c.args[0] === "/fake/.pi/agent/workers/runs/fixture" && c.args[1] === "historian"));
  const output = h.messages.at(-1);
  assert.equal(output.options.triggerTurn, false);
  assert.equal(output.message.display, true);
  for (const text of ["historian@run · 02.jsonl · start → end", "recovered answer", "✓ /vault/report.md", "✗ attempted src/file.ts", "cat > src/file.ts", "7 tools", "skipped 1 malformed records"]) assert.ok(output.message.content.includes(text), text);
  assert.equal(h.calls.some((c) => c.command === "tmux"), false);
});

test("crew_cli recover --all forwards mode and labels each session", async () => {
  const h = mainHarness();
  await h.command("recover historian --all");
  assert.ok(h.calls.some((c) => c.command === "recover" && c.args[2] === true));
  assert.match(h.messages.at(-1).message.content, /^== 02.jsonl ==/);
  const invalid = mainHarness();
  await invalid.command("recover historian --bogus");
  assert.match(invalid.messages.at(-1).notification, /usage:/);
  assert.equal(invalid.calls.some((c) => c.command === "recover"), false);
});

test("governor board row is dim, lazy and counts answers separately from escalations", async () => {
  const h = mainHarness();
  await h.api.refresh();
  assert.match(h.lines(), /<dim>⚖ governor · not yet consulted<\/dim>/);
  await h.ask("q1");
  assert.match(h.lines(), /<dim>⚖ governor · governor-model · 1 answered \/ 0 escalated · governor traffic<\/dim>/);
  await h.ask("q1");
  assert.match(h.lines(), /1 answered \/ 0 escalated/, "duplicate ID does not double count");
  h.governorReply({ kind: "escalate", text: "needs human" });
  await h.ask("q2");
  assert.match(h.lines(), /1 answered \/ 1 escalated/);
  h.api.answerConsult("q2", "approved", "test");
  assert.match(h.lines(), /1 answered \/ 1 escalated/);
  await h.ask("q3", "irreversible");
  assert.match(h.lines(), /1 answered \/ 1 escalated/, "direct human-only classes are not governor traffic");
  assert.equal(h.api.workers.size, 1, "governor never becomes a worker");
  h.api.workers.clear();
  await h.api.refresh();
  assert.match(h.lines(), /1 answered/, "answered governor remains after worker disposal");
  await h.command("kill all");
  assert.equal(h.lines(), "", "kill all closes team even after workers were disposed");
  const nextLifetime = mainHarness();
  await nextLifetime.api.refresh();
  assert.match(nextLifetime.lines(), /not yet consulted/);
});

test("governor SLA routing increments escalated without inventing an answer", async () => {
  const h = mainHarness();
  await h.api.refresh();
  h.governorReply(new Promise(() => {}));
  const pending = h.ask("sla");
  h.timeouts.find((t) => t.ms === consult.GOVERNOR_SLA_MS).fn();
  await pending;
  assert.match(h.lines(), /0 answered \/ 1 escalated/);
});

test("governor warms without a model call and resets/detaches on shutdown", async () => {
  const h = mainHarness();
  assert.equal(h.governorCalls.length, 0, "no governor exists before the first crew");
  h.api.ensureTicker();
  assert.equal(h.governorCalls[0].options.settingsKey, "crew.governorModel", "one key; unset ⇒ the governor falls back to main's model and logs it");
  assert.equal(h.governorCalls.filter((c) => c.kind === "warm").length, 1);
  assert.equal(h.governorCalls.filter((c) => c.kind === "ask").length, 0);
  h.api.workers.get("historian").model = "other/governor-worker";
  await h.ask("judge");
  assert.match(h.lines(), /<bold>governor-model<\/bold>/);
  assert.match(h.lines(), /\n\n<dim>┊ <\/dim><dim>⚖ governor/, "infrastructure comes after a blank line");
  h.emit("session_shutdown");
  assert.ok(h.governorCalls.some((c) => c.kind === "reset"));
  assert.ok(h.governorCalls.some((c) => c.kind === "detach"));
});

test("crew owns one governor per run and never asks for a shared singleton", async () => {
  const h = mainHarness({ "/fake/.pi/agent/settings.json": JSON.stringify({ crew: { governorModel: "provider/crew-model" } }) });
  h.api.workers.set("other", { ...h.api.workers.get("historian"), name: "other", run: "second" });
  h.api.ensureTicker();
  const instances = h.governorCalls.filter((c) => c.kind === "instance");
  assert.equal(instances.length, 2);
  assert.ok(instances.every((c) => c.options.settingsKey === "crew.governorModel"));
  assert.equal(h.governorCalls.filter((c) => c.kind === "options").length, 0, "no shared singleton must be requested");
  h.api.ensureTicker();
  assert.equal(h.governorCalls.filter((c) => c.kind === "warm").length, 2);
  await h.ask("first");
  await h.api.onConsult("second", { from: "other", text: JSON.stringify({ consult: { id: "second", kind: "confirm", question: "Proceed?" } }) });
  const asks = h.governorCalls.filter((c) => c.kind === "ask");
  assert.notEqual(asks[0].id, asks[1].id);
  assert.match(h.lines(), /⚖ governor · run · governor-model · 1 answered \/ 0 escalated/);
  assert.match(h.lines(), /⚖ governor · second · second-model · 1 answered \/ 0 escalated/);
  assert.doesNotMatch(h.lines(), /2 answered/);
  h.emit("session_shutdown");
  assert.deepEqual(h.governorCalls.filter((c) => c.kind === "reset").map((c) => c.id).sort(), [0, 1]);
});

test("crew.governorModel unset ⇒ one fallback log per governor instance, still on the crew key (the fleet key is gone)", () => {
  const h = mainHarness({ "/fake/.pi/agent/settings.json": JSON.stringify({ fleet: { governorModel: "provider/legacy-model" } }) });
  h.api.workers.set("other", { ...h.api.workers.get("historian"), name: "other", run: "second" });
  h.api.ensureTicker();
  assert.ok(h.governorCalls.filter((c) => c.kind === "instance").every((c) => c.options.settingsKey === "crew.governorModel"), "a leftover fleet key is never read");
  const fallback = h.logs.filter((l) => /governor_model_fallback/.test(l)).map((l) => JSON.parse(l));
  assert.equal(fallback.length, 2);
  assert.deepEqual(fallback.map((l) => [l.run, l.model, l.reason]), [["run", "provider/governor-model", "crew.governorModel unset"], ["second", "provider/second-model", "crew.governorModel unset"]]);
});

test("late answers from a disposed governor cannot repopulate reset session counters", async () => {
  const h = mainHarness();
  const worker = h.api.workers.get("historian");
  let finish;
  h.governorReply(new Promise((resolve) => { finish = resolve; }));
  const pending = h.ask("late");
  await h.command("kill all");
  finish({ kind: "answer", text: "old answer" });
  await pending;
  h.api.workers.set("historian", worker);
  await h.api.refresh();
  assert.match(h.lines(), /not yet consulted/);
  assert.equal(h.logs.filter((l) => /consult_answered/.test(l)).length, 0);
});

test("governor rows are per-run, idle rows do not multiply and workers retain their budget", async () => {
  const h = mainHarness();
  for (let i = 2; i <= 5; i++) h.api.workers.set(`worker${i}`, { ...h.api.workers.get("historian"), id: i + 4, name: `worker${i}`, run: `run${i}` });
  h.api.ensureTicker();
  await h.api.refresh();
  assert.equal((h.lines().match(/not yet consulted/g) ?? []).length, 1);
  await h.ask("one");
  for (let i = 2; i <= 5; i++) await h.api.onConsult(`run${i}`, { from: `worker${i}`, text: JSON.stringify({ consult: { id: `q${i}`, kind: "confirm", question: "Proceed?" } }) });
  assert.match(h.lines(), /\+3 governor rows hidden/);
  assert.match(h.lines(), /<dim>crew<\/dim><text> · 5 workers/);
  assert.match(h.lines(), /\+2.*more/);
  assert.equal((h.lines().match(/⚖ governor/g) ?? []).length, 2);
  assert.match(h.lines(), /worker2/);
  assert.match(h.lines(), /worker3/);
});

function realGovernorAPI(settings) {
  const source = stripTypeScriptTypes(readFileSync(new URL("../../../lib/governor/index.ts", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, "")
    .replace(/^export \{.*\} from .*;$/gm, "")
    .replace(/^export /gm, "");
  const sessions = [];
  const models = [{ provider: "test", id: "fleet" }, { provider: "test", id: "crew" }];
  // Only SDK session I/O is replaced: Governor, sharedGovernor, SingleFlight,
  // TurnQueue, TurnTally and reset/disposal behavior are the production code.
  return { sessions, ...runInNewContext(`${source}\n({ Governor, sharedGovernor });`, {
    ...lifecycle, ...governorPrompt,
    readFileSync: () => JSON.stringify(settings), join: (...parts) => parts.join("/"),
    getAgentDir: () => "/fixture", SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession() {
      const listeners = new Set();
      const session = {
        model: models[0], disposed: false, calls: 0,
        modelRuntime: { getAvailableSnapshot: () => models },
        async setModel(model) { this.model = model; },
        dispose() { this.disposed = true; listeners.clear(); },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        async prompt() {
          this.calls++;
          for (const fn of [...listeners]) fn({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ANSWER: proceed" }] } });
          for (const fn of [...listeners]) fn({ type: "agent_end" });
        },
      };
      sessions.push(session);
      return { session };
    },
    process: { cwd: () => "/work" },
  }) };
}

test("real governor singleton and fleet session survive crew kill-all unchanged", async () => {
  const settings = { fleet: { governorModel: "test/fleet" }, crew: { governorModel: "test/crew" } };
  const real = realGovernorAPI(settings);
  const fleet = real.sharedGovernor({ settingsKey: "fleet.governorModel" });
  await fleet.warm();
  await fleet.ask({ id: "fleet-q", run: "fleet-run", worker: "fleet-worker", kind: "confirm", question: "Proceed?" }, "");
  const originalSession = fleet.session;
  let fleetChanges = 0;
  fleet.on({ onChange: () => { fleetChanges++; } });
  const before = { model: fleet.modelLabel, state: fleet.state(), calls: originalSession.calls };
  const baseline = process.env.PI_TEST_PRE5B === "1" ? execFileSync("git", ["show", "54d5d5c:agent/extensions/crew/index.ts"], { encoding: "utf8" }) : undefined;
  const h = mainHarness({ "/fake/.pi/agent/settings.json": JSON.stringify(settings) }, real, baseline);
  h.api.ensureTicker();
  if (h.api.governors) await Promise.all([...h.api.governors.values()].map((g) => g.governor.warm()));
  await h.ask("crew-q");
  const ownedBeforeKill = [...(h.api.governors?.values() ?? [])];
  const worker = h.api.workers.get("historian");
  await h.command("kill all");
  assert.equal(real.sharedGovernor(), fleet, "fleet singleton object stays the same");
  assert.equal(fleet.session, originalSession, "crew cannot clear fleet's initialized session");
  assert.equal(originalSession.disposed, false);
  assert.deepEqual({ model: fleet.modelLabel, state: fleet.state(), calls: originalSession.calls }, before);
  assert.equal(before.model, "test/fleet");
  assert.equal(real.sessions.length, 2);
  assert.equal(real.sessions[1].model.id, "crew");
  assert.equal(real.sessions[1].disposed, true, "crew disposes its own session");
  assert.ok(ownedBeforeKill.every((g) => g.governor.state() === "absent" && g.governor.hooks.size === 0));
  assert.equal(fleetChanges, 0, "crew reset does not emit on fleet hooks");
  h.api.workers.set("historian", worker);
  h.api.ensureTicker();
  const ownedBeforeShutdown = [...h.api.governors.values()];
  await Promise.all(ownedBeforeShutdown.map((g) => g.governor.warm()));
  h.emit("session_shutdown");
  assert.equal(real.sharedGovernor(), fleet);
  assert.equal(fleet.session, originalSession);
  assert.equal(originalSession.disposed, false);
  assert.deepEqual({ model: fleet.modelLabel, state: fleet.state(), calls: originalSession.calls }, before);
  assert.ok(ownedBeforeShutdown.every((g) => g.governor.state() === "absent" && g.governor.hooks.size === 0));
  assert.equal(real.sessions[2].disposed, true);
  assert.equal(fleetChanges, 0);
  await fleet.warm();
  assert.ok(fleetChanges > 0, "fleet's own hook still works after crew shutdown");
});

test("real governor resolution emits one fallback per instance and none for configured crew", async () => {
  const legacy = { fleet: { governorModel: "test/fleet" } };
  const real = realGovernorAPI(legacy);
  const h = mainHarness({ "/fake/.pi/agent/settings.json": JSON.stringify(legacy) }, real);
  h.api.workers.set("other", { ...h.api.workers.get("historian"), name: "other", run: "second" });
  h.api.ensureTicker();
  await Promise.all([...h.api.governors.values()].map((g) => g.governor.warm()));
  h.api.ensureTicker();
  await Promise.all([...h.api.governors.values()].map((g) => g.governor.warm()));
  const rows = h.logs.filter((l) => /governor_model_fallback/.test(l)).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.run, r.model, r.reason]), [["run", "test/fleet", "crew.governorModel unset"], ["second", "test/fleet", "crew.governorModel unset"]]);
  const settings = { ...legacy, crew: { governorModel: "test/crew" } };
  const configured = mainHarness({ "/fake/.pi/agent/settings.json": JSON.stringify(settings) }, realGovernorAPI(settings));
  configured.api.ensureTicker();
  await Promise.all([...configured.api.governors.values()].map((g) => g.governor.warm()));
  assert.equal(configured.logs.filter((l) => /governor_model_fallback/.test(l)).length, 0);
  assert.equal([...configured.api.governors.values()][0].governor.modelLabel, "test/crew");
});

test("dead-request main dispatch uses the pure selector and records the dispatched model", async () => {
  const selected = [];
  const baseline = process.env.PI_TEST_PRE7 === "1" ? execFileSync("git", ["show", "e1ee024:agent/extensions/crew/index.ts"], { encoding: "utf8" }) : undefined;
  const h = mainHarness({}, { chooseDeadRequestRung(state) { selected.push(state); return { action: "failover", model: "test/chosen" }; } }, baseline);
  await h.api.onDeadRequest("run", "historian", { stop: "error", error: "provider overloaded", contextPct: 71 });
  assert.equal(selected.length, 1, "main must delegate, not retain a second inline rung policy");
  assert.equal(selected[0].attempt, 1);
  assert.equal(selected[0].contextPct, 71);
  const retry = await h.waitFor("timeout:3000");
  assert.equal(h.api.workers.get("historian").model, undefined, "busy pane has not switched yet");
  assert.equal(h.calls.some((c) => c.args.some((a) => String(a).startsWith("/model "))), false);
  h.status("idle");
  retry();
  await h.waitFor("log:model_switch_sent");
  assert.equal(h.api.workers.get("historian").model, "test/chosen");
  assert.ok(h.calls.some((c) => c.args.includes("/model test/chosen")), "editor command sends the FULL provider/id — a bare id opens the picker when two providers serve it (c9bab18)");
  assert.equal(h.logs.filter((l) => /model_failover/.test(l)).length, 1);
});

test("dead-request counters reset on nonerror turns but failed models persist per lifetime", async () => {
  const selections = [];
  const h = mainHarness({}, { chooseDeadRequestRung(state) { selections.push({ ...state, usedModels: [...state.usedModels] }); return { action: "give_up" }; } });
  h.api.workers.get("historian").model = "anthropic/initial";
  const fail = (name = "historian") => h.api.onDeadRequest("run", name, { stop: "error", error: "dead", contextPct: 71 });
  await fail();
  assert.deepEqual(selections[0].usedModels, ["anthropic/initial"]);
  h.turnEnd("error");
  await fail();
  assert.equal(selections.at(-1).attempt, 2);
  h.turnEnd("stop", "unknown-worker");
  await fail();
  assert.equal(selections.at(-1).attempt, 3, "another worker cannot reset this lifetime");
  for (const stop of ["stop", "aborted", "length"]) {
    h.turnEnd(stop);
    await fail();
    assert.equal(selections.at(-1).attempt, 1);
    assert.deepEqual(selections.at(-1).usedModels, ["anthropic/initial"]);
  }
  h.api.workers.get("historian").model = "openai/next";
  await fail();
  assert.deepEqual(selections.at(-1).usedModels, ["anthropic/initial", "openai/next"]);
  h.api.workers.set("historian_2", { ...h.api.workers.get("historian"), name: "historian_2", model: "third/new" });
  await fail("historian_2");
  assert.equal(selections.at(-1).attempt, 1);
  assert.deepEqual(selections.at(-1).usedModels, ["third/new"], "successor inherits no failed-model history");
});

test("a successful turn resets consecutive dead-request attempts", async () => {
  const attempts = [];
  const h = mainHarness({}, { chooseDeadRequestRung(state) { attempts.push(state.attempt); return { action: "give_up" }; } });
  const fail = () => h.api.onDeadRequest("run", "historian", { stop: "error", error: "dead" });
  await fail();
  h.turnEnd("stop");
  await fail();
  assert.deepEqual(attempts, [1, 1]);
});

test("progress: the worker's milestone leads the row; a shared finding reaches main ONCE, coalesced, as an FYI", async () => {
  const h = mainHarness();
  h.api.workers.set("reviewer", { id: 5, name: "reviewer", run: "run", pane: "%3", spawnedAt: new Date(1_000_000).toISOString() });
  h.status("tool:bash");
  h.status("tool:bash", "reviewer");
  const progress = (from, body) => h.api.onProgress("run", from, JSON.stringify(body), "2026-09-17T20:00:00.000Z");
  progress("historian", { phase: "reading the record · 2/5 files" });
  await h.api.refresh();
  assert.match(h.lines(), /reading the record · 2\/5 files · bash/, "says, then sees");
  assert.doesNotMatch(h.lines(), /reviewer.*reading the record/, "a milestone is per worker");
  assert.equal(h.messages.length, 0, "quiet by default: the row is the whole channel");

  // two shared findings in one burst → one follow-up, latest per worker
  progress("historian", { phase: "reading the record", finding: "the design doc contradicts the brief", evidence: ["design.md:12"], share: true });
  progress("historian", { phase: "reading the record", finding: "the brief is newer — it wins", evidence: ["plan.md:3"], share: true });
  progress("reviewer", { phase: "reviewing diff", finding: "retry swallows ETIMEDOUT", share: true });
  const flush = h.timeouts.at(-1); assert.ok(flush && flush.ms >= 2000, "a debounce, not an immediate wake");
  flush.fn();
  assert.equal(h.messages.length, 1, "one message for the burst");
  const { message, options } = h.messages[0];
  assert.equal(message.customType, "crew_progress");
  assert.match(message.content, /2 findings/);
  assert.match(message.content, /historian · reading the record\n  found: the brief is newer — it wins/);
  assert.doesNotMatch(message.content, /contradicts the brief/, "superseded finding coalesced away");
  assert.match(message.content, /reviewer · reviewing diff\n  found: retry swallows ETIMEDOUT/);
  assert.match(message.content, /no reply is owed/);
  assert.equal(JSON.stringify(options), JSON.stringify({ deliverAs: "followUp", triggerTurn: true }));

  // a second shared finding from the same worker within a minute waits for the rate limit
  progress("reviewer", { phase: "reviewing diff", finding: "and the caller never checks the code", share: true });
  const held = h.timeouts.at(-1); held.fn();
  assert.equal(h.messages.length, 1, "held: ≥60s per worker");
  h.advance(60_001);
  h.timeouts.at(-1).fn();
  assert.equal(h.messages.length, 2, "delivered once the window passed");

  // the milestone reads "says · sees" in every plain state (workflow states — consult, wait, held — overwrite detail after it)
  h.status("thinking");
  progress("historian", { phase: "writing summary" });
  await h.api.refresh();
  assert.match(h.lines(), /historian.*writing summary · thinking/);
});

test("approved op consult: a ref main already leases is handed over from the lease — no second op read; an unleased ref still reads", async () => {
  const h = mainHarness();
  h.resolveSecret((q) => q.resolve(q.ref === "op://Employee/staging/credential" ? "sk_test_leased" : undefined));
  const req = { id: "c1", worker: "historian", kind: "op", question: "need the staging key", askedAt: new Date().toISOString() };
  const out = await h.api.performOperation("run", req, { type: "op", refs: ["op://Employee/staging/credential", "op://Employee/other/credential"] });
  assert.equal(out.ok, true);
  const writes = h.calls.filter((c) => c.command === "write");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].args[1], "sk_test_leased");                                        // from the lease
  assert.equal(writes[0].args[2], 0o600);
  assert.match(writes[0].args[0], /children\/historian\/secrets\/1$/);
  const opReads = h.calls.filter((c) => c.command === "op").map((c) => c.args[1]);
  assert.deepEqual(opReads, ["op://Employee/other/credential"], "only the unleased ref reaches 1Password");
  assert.equal(writes[1].args[1], "123");                                                   // the harness's op stdout
});

test("a worker's op consult is a two-key candidate only when main leases EVERY ref it names; a cold ref reaches Yong as before", async () => {
  const opAsk = (h, id, detail) => h.api.onConsult("run", { from: "historian", text: JSON.stringify({ consult: { id, kind: "policy", question: "use the credential", action: { verb: "POST", target: "api.linear.app/graphql", detail } } }) });
  const cold = mainHarness();
  await opAsk(cold, "op1", "with op://Employee/linear/credential");
  assert.equal(cold.logs.some((l) => /consult_two_key_candidate/.test(l)), false, "cold: not on the list");
  assert.ok(cold.logs.some((l) => /consult_to_human/.test(l)));
  const warm = mainHarness();
  warm.lease("op://Employee/linear/credential", "linear");
  await opAsk(warm, "op2", "with op://Employee/linear/credential");
  const cand = warm.logs.find((l) => /consult_two_key_candidate/.test(l));
  assert.ok(cand, "leased: two-key candidate");
  assert.match(cand, /main already leases linear/);
  const half = mainHarness();
  half.lease("op://Employee/linear/credential", "linear");
  await opAsk(half, "op3", "with op://Employee/linear/credential and op://Employee/other/credential");
  assert.equal(half.logs.some((l) => /consult_two_key_candidate/.test(l)), false, "one cold ref among two: not on the list");
});
