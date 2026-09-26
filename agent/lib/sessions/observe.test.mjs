import assert from "node:assert/strict";
import test from "node:test";
import { observe, rowFor, sortRows } from "./observe.ts";

const now = Date.parse("2026-09-18T12:00:00Z");
const leases = [
  { sessionId: "S1", pid: 10, file: "/s/S1.jsonl", cwd: "/w/a", pane: "%1", alive: true },
  { sessionId: "S2", pid: 20, file: "/s/S2.jsonl", cwd: "/w/b", pane: "%2", alive: true },
  { sessionId: "S3", pid: 30, file: "/s/S3.jsonl", cwd: "/w/c", pane: "%3", alive: false },   // stale lease: dead pid
  { sessionId: "S4", pid: 40, file: "/s/S4.jsonl", cwd: "/w/d", alive: true },                // no tmux
];
const panes = [
  { paneId: "%1", windowId: "@1", dot: { state: "blocked", ts: now - 120_000, reason: "waiting on you: pick a reviewer" } },
  { paneId: "%2", windowId: "@2", dot: { state: "working", ts: now - 5_000 } },
  { paneId: "%9", windowId: "@9", dot: { state: "working", ts: now } },                       // a Claude Code pane: no lease, not a pi session
];
const inputs = {
  leases, panes,
  crews: [{ ownerSession: "S1", slug: "review-71255" }, { ownerSession: "S3", slug: "dead" }],
  devin: [{ ownerSession: "S2", slug: "sqs-spec", live: true, asking: true }, { ownerSession: "S2", slug: "old", live: false }, { ownerSession: undefined, slug: "unowned", live: true }],
  bg: [{ ownerSession: "S1", name: "suite", running: true }, { ownerSession: "S1", name: "push", running: false }],
  label: (s) => (s.pane ? `win ${s.pane}` : `pid ${s.pid}`),
  peek: (f) => (f === "/s/S1.jsonl" ? { lastUser: "review PR 71255 with a team please", lastAt: "2026-09-18T11:58:00Z" } : f === "/s/S4.jsonl" ? undefined : { lastUser: "go", lastAt: "2026-09-18T11:59:55Z" }),
};

test("observe: one view per LIVE lease; everything joins on the session id, never on the pane or pid", () => {
  const views = observe(inputs);
  assert.deepEqual(views.map((v) => v.sessionId), ["S1", "S2", "S4"], "a stale lease is not a session; a pane without a lease is not a pi session");
  const s1 = views[0];
  assert.equal(s1.dot?.state, "blocked");
  assert.deepEqual(s1.crews.map((c) => c.slug), ["review-71255"]);
  assert.deepEqual(s1.bg.map((b) => b.name), ["suite"], "finished jobs are not owned work");
  assert.deepEqual(views[1].devin.map((d) => d.slug), ["sqs-spec"], "a terminal Devin row is not owned work; an unowned row belongs to nobody");
  assert.equal(views[2].dot, undefined); assert.equal(views[2].lastUser, "");
});

test("rowFor: the dot decides the glyph; owed-to-you carries the reason; owned things + last prompt make the detail; the file is the link", () => {
  const [s1, s2, s4] = observe(inputs);
  const r1 = rowFor(s1, now, "S1");
  assert.equal(r1.state, "waiting"); assert.equal(r1.waiting.on, "you"); assert.equal(r1.waiting.why, "waiting on you: pick a reviewer");
  assert.equal(r1.name, "win %1 (you)");
  assert.match(r1.detail, /^waiting on you: pick a reviewer · 1 crew open · 1 bg · “review PR 71255 with a team please”$/);
  assert.equal(r1.url, "file:///s/S1.jsonl");
  assert.equal(r1.ageMs, 120_000, "age = since last activity in the transcript");
  const r2 = rowFor(s2, now);
  assert.equal(r2.state, "working"); assert.equal(r2.detail, "1 devin (1 asking) · “go”");
  const r4 = rowFor(s4, now);
  assert.equal(r4.state, "idle"); assert.equal(r4.pane, "pid 40"); assert.equal(r4.ageMs, 0);
});

test("sortRows: what you owe first, then working, then finished-unseen, then idle", () => {
  const rows = [
    { state: "idle", ageMs: 1 }, { state: "working", ageMs: 5 }, { state: "done", ageMs: 2 }, { state: "waiting", ageMs: 9 }, { state: "working", ageMs: 1 },
  ];
  assert.deepEqual(sortRows(rows).map((r) => `${r.state}:${r.ageMs}`), ["waiting:9", "working:1", "working:5", "done:2", "idle:1"]);
});
