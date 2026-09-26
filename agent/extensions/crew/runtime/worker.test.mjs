import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

// Execute the real worker factory in isolated globals: no pi installation,
// transport, filesystem writes, or real 30-minute timers needed.
const source = stripTypeScriptTypes(process.env.PI_TEST_PRE7_WORKER === "1" ? execFileSync("git", ["show", "e1ee024:agent/extensions/crew/worker.ts"], { encoding: "utf8" }) : readFileSync(new URL("./worker.ts", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "")
  .replace("export default function", "function worker");
let uuidSeq = 0;
function lifetime(rosterId, env = {}) {
  let consult, options, client;
  let now = 1_000_000;
  const sent = [];
  const logs = [];
  const handlers = new Map();
  const titles = [];
  const timers = new Set();
  const context = {
    Date: class extends Date { static now() { return now; } },
    process: { env: { PI_CREW_ROLE: "worker", PI_CREW_NAME: "same-name", PI_CREW_RUN: "same-run", ...(rosterId === undefined ? {} : { PI_CREW_ID: String(rosterId) }), PI_CREW_BRIEF: "/run/children/same-name/brief.md", ...env }, cwd: () => "/work" },
    dirname,
    elapsed: () => "0s",
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`,
    Type: new Proxy({}, { get: () => () => ({}) }),
    RoomClient: class { constructor(_pi, opts) { options = opts; client = this; } send(env) { sent.push(env); } },
    RedisRoomBus: class { async detach() {} },
    registerRoomCardRenderer() {},
    mkdirSync() {}, appendFileSync(_path, text) { logs.push(JSON.parse(text)); }, existsSync: () => false,
    // role guard: a missing guard file = no rules (the real loader returns undefined); never resolves rules in the sandbox
    loadRoleGuard: async () => undefined, applyRoleRules() {},
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  };
  runInNewContext(`${source}\nworker(pi);`, { ...context, pi: {
    registerTool(tool) { if (tool.name === "consult") consult = tool; },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  } });
  return {
    sent, timers, titles, logs,
    duplicate() { client.sentToMainThisTurn = true; },
    advance(ms) { now += ms; },
    async emit(event, data = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(data, { hasUI: false, model: { contextWindow: 1000 }, getContextUsage: () => ({ tokens: 100 }), ui: { setTitle: (text) => titles.push(text) } });
    },
    ask: () => consult.execute("reused-tool-call", { kind: "confirm", question: "Proceed?" }),
    resolve: (id, text) => options.onResolve({ re: id, text }),
    awaiting: () => options.awaiting(),
    hear: (env) => options.observe?.(env),
  };
}

for (const rosterId of [undefined, 0, -1, 1.5, "not-a-number", Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid PI_CREW_ID (${rosterId}) refuses to issue a consult`, async () => {
    const worker = lifetime(rosterId);
    const call = worker.ask();
    // Settle an erroneously emitted request so the unfixed implementation fails,
    // rather than leaving the test waiting on the fake timeout.
    for (const env of worker.sent) if (env.task === "consult") worker.resolve(env.re, "GOVERNOR: unexpected");
    await assert.rejects(call, /PI_CREW_ID/);
    assert.equal(worker.sent.filter((env) => env.task === "consult").length, 0);
    assert.equal(worker.sent.length, 1);
    assert.equal(worker.sent[0].kind, "error");
    assert.deepEqual(Array.from(worker.sent[0].to), ["main"]);
    assert.match(worker.sent[0].text, /PI_CREW_ID/);
    assert.equal(worker.awaiting(), undefined);
    assert.equal(worker.timers.size, 0);
  });
}

test("same-name worker lifetimes in one run never reuse consult IDs or accept stale answers", async () => {
  const first = lifetime(4);
  const oldCall = first.ask();
  const oldId = first.sent[0].re;
  first.resolve(oldId, "GOVERNOR: old answer");
  assert.equal((await oldCall).details.consult, oldId);

  const second = lifetime(9);
  const newCall = second.ask();
  const newId = second.sent[0].re;
  assert.notEqual(newId, oldId, "respawn must not reuse a consult id in the same run");
  assert.equal(oldId, "c-same-name-4-1", "ID includes readable roster identity and local sequence");
  assert.equal(newId, "c-same-name-9-1");
  assert.equal(JSON.parse(second.sent[0].text).consult.id, newId);
  assert.equal(second.awaiting(), newId);

  let settled = false;
  newCall.then(() => { settled = true; });
  second.resolve(oldId, "HUMAN: stale approval");
  await Promise.resolve();
  assert.equal(settled, false, "old approval must not resolve the new call");
  assert.equal(second.awaiting(), newId);
  second.resolve(newId, "GOVERNOR: new answer");
  const answer = await newCall;
  assert.equal(answer.content[0].text, "GOVERNOR: new answer");
  assert.equal(answer.details.consult, newId);
  assert.equal(second.awaiting(), undefined);

  const thirdCall = second.ask();
  const thirdId = second.sent[1].re;
  assert.equal(thirdId, "c-same-name-9-2");
  assert.notEqual(thirdId, newId, "calls within one lifetime are unique too");
  assert.notEqual(thirdId, oldId);
  second.resolve(thirdId, "GOVERNOR: third answer");
  await thirdCall;
  assert.equal(first.timers.size + second.timers.size, 0);
});

for (const prior of ["working", "idle"]) {
  for (const reason of ["manual", "threshold", "overflow"]) {
    for (const terminal of ["session_compact", "session_compact_failed"]) {
      test(`compaction ${reason} ${terminal} restores ${prior} and reports runtime presence`, async () => {
        const worker = lifetime(4);
        await worker.emit("agent_start");
        if (prior === "idle") await worker.emit("agent_end");
        worker.sent.length = 0;
        await worker.emit("session_before_compact", { reason });
        assert.equal(worker.sent[0]?.task, "presence");
        assert.deepEqual(JSON.parse(worker.sent[0].text), { state: "compacting", prior });
        await worker.emit(terminal, { reason, errorMessage: "summary failed", aborted: false });
        assert.equal(worker.sent[1]?.task, "presence");
        assert.deepEqual(JSON.parse(worker.sent[1].text), { state: "restored", prior });
        assert.equal(worker.sent.filter((e) => e.task === "compact_failed").length, terminal === "session_compact_failed" ? 1 : 0);
        assert.ok(worker.sent.every((e) => e.kind === "notice" && e.to[0] === "main"));
      });
    }
  }
}

test("first-token vitals use agent-start latency, three-sample minimum and last 20 sampled turns", async () => {
  const worker = lifetime(4);
  await worker.emit("session_start");
  const vitals = () => worker.sent.filter((e) => e.task === "vitals").map((e) => JSON.parse(e.text));
  async function sample(ms, type = "text_delta") {
    await worker.emit("agent_start");
    worker.advance(ms);
    await worker.emit("message_update", { assistantMessageEvent: { type, delta: "x" } });
    worker.advance(9999);
    await worker.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "later" } });
    await worker.emit("agent_end");
  }
  await sample(10_000);
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, undefined);
  await sample(50_000, "thinking_delta");
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, undefined);
  await sample(30_000, "toolcall_delta");
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, 30_000);
  await sample(70_000);
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, 40_000);
  for (const stopReason of ["error", "aborted"]) {
    await worker.emit("agent_start");
    worker.advance(900_000);
    await worker.emit("message_end", { message: { role: "assistant", stopReason } });
    await worker.emit("agent_end");
  }
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, 40_000);
  for (let i = 0; i < 20; i++) await sample(1000 * (i + 1));
  assert.equal(vitals().at(-1)?.firstTokenMedianMs, 10_500);
  assert.equal(vitals().length, 24, "sampled turns report vitals despite unchanged context; later deltas do not sample again");
  const nextLifetime = lifetime(5);
  await nextLifetime.emit("session_start");
  await nextLifetime.emit("agent_start");
  nextLifetime.advance(100_000);
  await nextLifetime.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x" } });
  const next = nextLifetime.sent.filter((e) => e.task === "vitals").at(-1);
  assert.equal(JSON.parse(next.text).firstTokenMedianMs, undefined);
});

for (const fault of [undefined, "other", "dead_request"]) {
  test(`dead-request fault (${fault}) injects exactly the next completed turn`, async () => {
    const worker = lifetime(1, fault ? { PI_CREW_FAULT: fault } : {});
    await worker.emit("session_start");
    assert.equal(worker.logs.filter((l) => l.event === "fault_ignored").length, fault === "other" ? 1 : 0);
    for (let turn = 0; turn < 2; turn++) {
      await worker.emit("agent_start");
      await worker.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished normally" }] } });
      await worker.emit("agent_end");
      const report = worker.sent.filter((e) => e.report).at(-1);
      const verdict = worker.sent.filter((e) => e.task === "turn_end").at(-1);
      assert.equal(JSON.parse(verdict?.text ?? "{}").stop, fault === "dead_request" && turn === 0 ? "error" : "stop");
      if (fault === "dead_request" && turn === 0) {
        assert.equal(report.kind, "error");
        assert.equal(report.report, "aborted");
        assert.equal(report.verdict.stop, "error");
        assert.equal(report.verdict.error, "FAULT: injected");
      } else {
        assert.equal(report.report, "done");
        assert.notEqual(report.kind, "error");
      }
    }
  });
}

test("suppressed harness and duplicate reports still publish nonerror turn verdicts", async () => {
  const worker = lifetime(1);
  await worker.emit("session_start");
  for (const prompt of ["[harness] checkpoint", "human question"]) {
    await worker.emit("agent_start");
    await worker.emit("message_start", { message: { role: "user", content: prompt } });
    if (prompt === "human question") worker.duplicate();
    await worker.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    await worker.emit("agent_end");
  }
  assert.equal(worker.sent.filter((e) => e.report).length, 0);
  assert.deepEqual(worker.sent.filter((e) => e.task === "turn_end").map((e) => JSON.parse(e.text).stop), ["stop", "stop"]);
});

test("main rejoining the room (a /reload) re-raises the worker's pending consult; nothing is re-sent when it is not waiting", async () => {
  // main's openConsults is memory; a request published while main was between shutdown and re-adopt reached nobody
  // (Pub/Sub is live-only). The worker still knows it is waiting, so it re-sends the SAME request on main's join notice.
  const worker = lifetime(1);
  const call = worker.ask();
  const first = worker.sent.filter((e) => e.task === "consult");
  assert.equal(first.length, 1);
  worker.hear({ id: "evt-rejoined-abc", run: "same-run", at: "t", from: "room", to: ["*"], kind: "notice", text: "main joined as main — coordinator", re: "main" });
  const again = worker.sent.filter((e) => e.task === "consult");
  assert.equal(again.length, 2, "the pending consult is re-sent once main is listening again");
  assert.equal(again[1].re, first[0].re, "same consult id — main's dedupe and the answer path key on it");
  assert.equal(again[1].text, first[0].text, "same payload");
  assert.ok(worker.logs.some((l) => l.event === "consult_resent"));
  worker.hear({ id: "evt-joined-xyz", run: "same-run", at: "t", from: "room", to: ["*"], kind: "notice", text: "other joined as reviewer — x", re: "other" });
  assert.equal(worker.sent.filter((e) => e.task === "consult").length, 2, "a worker joining is not main");
  worker.resolve(first[0].re, "GOVERNOR: ok");
  await call;
  worker.hear({ id: "evt-rejoined-def", run: "same-run", at: "t", from: "room", to: ["*"], kind: "notice", text: "main joined as main — coordinator", re: "main" });
  assert.equal(worker.sent.filter((e) => e.task === "consult").length, 2, "nothing pending, nothing re-sent");
});
