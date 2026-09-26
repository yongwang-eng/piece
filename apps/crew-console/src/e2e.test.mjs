// End-to-end over a TEMP agent dir and the real local Redis: a fake worker blocks on a consult; main's record says
// `open`; the console answers via HTTP; the worker's blocking call receives `HUMAN: APPROVED …`; the row is answered
// exactly once. Skips (not fails) when Redis is not reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openCrewStore, agentDbPath } from "../../../agent/lib/database/store.ts";
import { RedisRoomBus } from "../../../agent/lib/room/redis-bus.ts";
import { HUMAN_MEMBER } from "../../../agent/lib/room/consult.ts";

const REAL_AGENT = `${process.env.HOME}/.pi/agent`;
const redisUp = existsSync(`${REAL_AGENT}/config/pubsub.json`) && existsSync(`${process.env.HOME}/.config/claude/pi-pubsub.env`);

test("console answer → worker unblocked with main's exact wording; record answered once", { skip: !redisUp && "redis config absent" }, async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "cc-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  mkdirSync(`${agentDir}/config`, { recursive: true }); cpSync(`${REAL_AGENT}/config/pubsub.json`, `${agentDir}/config/pubsub.json`);
  const store = openCrewStore(agentDbPath(agentDir));
  const main = store.ensureMain("s-main"); const owner = store.claimMain(main.id, "inst");
  const crew = store.createCrew(owner, { slug: "e2e", goal: "prove the console" });
  const runDir = `${agentDir}/workers/runs/${store.namespace}/${crew.id}`; mkdirSync(`${runDir}/children/fakeworker`, { recursive: true });
  writeFileSync(`${runDir}/roster.json`, JSON.stringify({ run: crew.id, revision: 1, members: [{ name: "main", role: "coordinator", presence: "working", backend: "main" }, { name: "fakeworker", id: 7, role: "verifier", presence: "blocked", backend: "crew" }] }));
  writeFileSync(`${runDir}/children/fakeworker/brief.md`, "# brief\nprove it");
  writeFileSync(`${runDir}/log.jsonl`, JSON.stringify({ at: new Date().toISOString(), event: "worker_spawned", worker: "fakeworker" }) + "\n");
  store.openConsult(crew.id, { id: "c-fakeworker-7-1", worker: "fakeworker", kind: "irreversible", class: "irreversible", humanRequired: true, question: "delete the endpoint?", evidence: ["brief.md"],
    action: { verb: "delete", target: "ep_1" }, intent: { why: "w", exact: "DELETE /ep_1", effect: "gone", reversible: "no", ifDenied: "keep" }, packet: { whyHuman: "kind=irreversible is human-only", question: "Delete ep_1?", recommendation: "approve", why: "scoped" }, askedAt: Date.now() - 5000 });
  store.close();

  // the fake worker: on the run's topic, awaiting its consult id
  const received = [];
  const bus = new RedisRoomBus({ run: crew.id, runDir, onError: (s, e) => received.push(`ERR ${s} ${e.message}`) });
  await new Promise((ready) => bus.attach("fakeworker", (ev) => received.push(ev.payload), () => ready()));
  t.after(() => bus.detach());

  const port = 9000 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, [new URL("./server.ts", import.meta.url).pathname], { env: { ...process.env, PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, CREW_CONSOLE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  t.after(() => srv.kill("SIGTERM"));
  for (let i = 0; i < 60 && !out.includes("crew-console http"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes("crew-console http"), `server did not start: ${out}`);
  assert.equal(readFileSync(`${agentDir}/state/crew-console.url`, "utf8").trim(), `http://127.0.0.1:${port}/`);
  const api = `http://127.0.0.1:${port}/api`;

  const state = await (await fetch(`${api}/state`)).json();
  assert.equal(state.open.length, 1);
  assert.deepEqual(state.open[0].options.map((o) => o.key), ["approve", "amend", "ask", "show", "reject"]);
  assert.equal(state.open[0].options[0].recommended, true, "the packet's recommendation stars Approve");
  assert.equal(state.crews[0].id, crew.id);

  const ev = await (await fetch(`${api}/consults/${crew.id}/c-fakeworker-7-1/evidence`)).json();
  assert.match(ev.brief, /prove it/);

  const post = (body) => fetch(`${api}/consults/${crew.id}/c-fakeworker-7-1/answer`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });
  assert.equal((await post({ choice: "amend", text: "" })).status, 400, "amend without text is refused");

  // ── the thread: a question is a turn, not a verdict ────────────────────────────────────────────────────────────────
  const q = await post({ choice: "ask", text: "why prod and not staging?" });
  assert.equal(q.status, 200, await q.text());
  for (let i = 0; i < 50 && !received.some((m) => m?.kind === "result"); i++) await new Promise((res) => setTimeout(res, 100));
  const question = received.find((m) => m?.kind === "result");
  assert.match(question.text, /^HUMAN: QUESTION from Yong: why prod and not staging\?/);
  assert.match(question.text, /consult\(\{ re: "c-fakeworker-7-1", reply: "…" \}\)/);
  let mid = await (await fetch(`${api}/state`)).json();
  assert.equal(mid.open.length, 1, "still open — same id");
  assert.deepEqual(mid.open[0].thread.map((t) => [t.who, t.text]), [["human", "why prod and not staging?"]]);
  assert.equal((await post({ choice: "approve" })).status, 409, "no decision while the worker owes a reply");
  // the worker's reply arrives via main in production (consult({re, reply}) → main appends the turn); here we play main
  {
    const s2 = openCrewStore(agentDbPath(agentDir));
    assert.equal(s2.appendConsultTurn(crew.id, "c-fakeworker-7-1", { who: "worker", text: "staging has no capture flag", at: new Date().toISOString() }), true);
    s2.close();
  }
  mid = await (await fetch(`${api}/state`)).json();
  assert.deepEqual(mid.open[0].thread.map((t) => t.who), ["human", "worker"]);
  assert.deepEqual(mid.open[0].options.map((o) => o.key), ["approve", "amend", "ask", "show", "reject"], "buttons are back, the act unchanged");
  received.length = 0;

  const r = await post({ choice: "approve" });
  const raw = await r.text();
  assert.equal(r.status, 200, raw);
  const body = JSON.parse(raw);
  assert.equal(body.text, "APPROVED by Yong: delete — ep_1. Do exactly this and nothing beyond it.");

  for (let i = 0; i < 50 && !received.some((m) => m?.kind === "result"); i++) await new Promise((res) => setTimeout(res, 100));
  const res = received.find((m) => m?.kind === "result");
  assert.ok(res, `worker never received the result: ${JSON.stringify(received)}`);
  assert.deepEqual([res.from, res.to, res.cc, res.re], [HUMAN_MEMBER, ["fakeworker"], ["main"], "c-fakeworker-7-1"]);
  assert.equal(res.text, "HUMAN: APPROVED by Yong: delete — ep_1. Do exactly this and nothing beyond it.");

  assert.equal((await post({ choice: "reject" })).status, 409, "second answer loses");
  const after = await (await fetch(`${api}/state`)).json();
  assert.equal(after.open.length, 0);
  assert.deepEqual([after.decisions[0].state, after.decisions[0].answeredBy, after.decisions[0].choice], ["answered", "human:console", "approve"]);
  assert.equal(after.decisions.length, 1, "one row for the whole conversation");
  assert.equal(after.decisions[0].thread.length, 2);
  assert.match(after.decisions[0].launch, /#[0-9a-f]{6}$/);

  // ── an OPERATION: approving an act that names an op:// reference is addressed to MAIN, not the worker ──────────────
  {
    const s3 = openCrewStore(agentDbPath(agentDir));
    s3.openConsult(crew.id, { id: "c-fakeworker-7-2", worker: "fakeworker", kind: "irreversible", class: "irreversible", humanRequired: true, question: "call the staging API?",
      action: { verb: "POST", target: "api.acme-test.example/organizations", detail: "bearer from op://Employee/acme-staging/credential" }, intent: { why: "w", exact: "curl -H \"Authorization: Bearer $(op read op://Employee/acme-staging/credential)\"", effect: "one org", reversible: "yes", ifDenied: "skip" }, packet: { whyHuman: "x" }, askedAt: Date.now() });
    s3.close();
  }
  const st = await (await fetch(`${api}/state`)).json();
  assert.deepEqual(st.open[0].operation, { type: "op", refs: ["op://Employee/acme-staging/credential"] }, "the console knows it is an operation without judging");
  received.length = 0;
  const r2 = await fetch(`${api}/consults/${crew.id}/c-fakeworker-7-2/answer`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ choice: "approve" }) });
  assert.equal(r2.status, 200, await r2.text());
  await new Promise((res) => setTimeout(res, 500));
  const op = received.find((m) => m?.kind === "result" && m?.re === "c-fakeworker-7-2");
  assert.deepEqual([op.to, op.cc], [["main"], []], "addressed to main only — the worker is not a recipient until main has performed the operation");

  // ── D73 veto: a two-key settlement is reversible from the pill; a human settlement is not a veto target ─────────────
  {
    const s4 = openCrewStore(agentDbPath(agentDir));
    s4.openConsult(crew.id, { id: "c-fakeworker-7-3", worker: "fakeworker", kind: "irreversible", class: "irreversible", humanRequired: true, question: "push crew/x", action: { verb: "push", target: "origin crew/x" }, packet: { twoKey: { pending: true, why: "own repo" } }, askedAt: Date.now() });
    s4.answerConsult(crew.id, "c-fakeworker-7-3", { by: "two-key", choice: "approve", answer: "APPROVED by two keys (main ✓ governor ✓)", at: Date.now() });
    s4.close();
  }
  received.length = 0;
  const cb = (card_id, action) => fetch(`http://127.0.0.1:${port}/api/halo/callback`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(`${process.env.HOME}/.config/halo_pill/sources.json`, "utf8")).sources.find((x) => x.name === "pi-crew").token}` }, body: JSON.stringify({ card_id, action, actor: { face: "pill" } }) });
  const v1 = await cb(`crew-two-key:${crew.id}:c-fakeworker-7-3`, "veto");
  assert.equal(v1.status, 200, await v1.text());
  await new Promise((res) => setTimeout(res, 500));
  const vetoMsg = received.find((m) => m?.kind === "request" && /^\[VETO\]/.test(m.text));
  assert.ok(vetoMsg, `worker got the [VETO]: ${JSON.stringify(received)}`);
  assert.deepEqual(vetoMsg.to, ["fakeworker"]); assert.match(vetoMsg.text, /c-fakeworker-7-3 \(push — origin crew\/x\)/); assert.match(vetoMsg.text, /STOP/);
  assert.equal((await cb(`crew-two-key:${crew.id}:c-fakeworker-7-3`, "veto")).status, 409, "second veto is refused");
  assert.equal((await cb(`crew-two-key:${crew.id}:c-fakeworker-7-1`, "veto")).status, 409, "Yong's own earlier answer is not a two-key decision");
  {
    const s5 = openCrewStore(agentDbPath(agentDir));
    const rec = s5.consult(crew.id, "c-fakeworker-7-3");
    assert.deepEqual([rec.state, rec.answeredBy, rec.choice], ["answered", "two-key", "vetoed"]); assert.match(rec.answer, /\[VETO by Yong /);
    s5.close();
  }
});
