import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneFor, validateAddressing, renderHeader, looksLikeCodeClaim, checkTalksTo } from "./lanes.ts";
import { RoomStore, whoOwns, rosterLines, GONE_AFTER_MS } from "./roster.ts";
import { digest, coalesce, relevantTo } from "./digest.ts";

const env = (over) => ({ id: "m1", run: "r", at: "2026-09-10T00:00:00Z", from: "w2", to: ["w1"], kind: "request", text: "x", ...over });

// ── lanes (D43) ──────────────────────────────────────────────────────────────

test("request/query addressed to me: steer when working, wake when idle, followUp when blocked", () => {
  assert.equal(laneFor(env({}), { me: "w1", presence: "working" }), "steer");
  assert.equal(laneFor(env({ kind: "query" }), { me: "w1", presence: "working" }), "steer");
  assert.equal(laneFor(env({}), { me: "w1", presence: "idle" }), "wake");
  assert.equal(laneFor(env({}), { me: "w1", presence: "blocked", awaiting: "c9" }), "followUp");
  assert.equal(laneFor(env({}), { me: "w1", presence: "stalled" }), "followUp");
});

test("inform/result/propose to me never interrupt: followUp when working, wake when idle", () => {
  for (const kind of ["inform", "result", "propose", "error", "accept", "refuse"]) {
    assert.equal(laneFor(env({ kind }), { me: "w1", presence: "working" }), "followUp", kind);
    assert.equal(laneFor(env({ kind }), { me: "w1", presence: "idle" }), "wake", kind);
  }
});

test("notice, cc-only and broadcast are log-only in every state — they wake nobody", () => {
  for (const presence of ["working", "idle", "blocked", "starting"]) {
    assert.equal(laneFor(env({ kind: "notice", to: ["*"] }), { me: "w1", presence }), "log", `notice/${presence}`);
    assert.equal(laneFor(env({ to: ["w3"], cc: ["w1"] }), { me: "w1", presence }), "log", `cc/${presence}`);
    assert.equal(laneFor(env({ to: ["w3"] }), { me: "w1", presence }), "log", `not-mine/${presence}`);
  }
});

test("the answer to what I am blocked on resolves the call — it is not mail", () => {
  const me = { me: "w1", presence: "blocked", awaiting: "c9" };
  assert.equal(laneFor(env({ kind: "result", re: "c9", from: "governor" }), me), "resolve");
  assert.equal(laneFor(env({ kind: "refuse", re: "c9" }), me), "resolve");
  assert.equal(laneFor(env({ kind: "result", re: "other" }), me), "followUp", "a result for a different request queues");
  // Found by a crew reviewer (beta, 2026-09-10): resolution ran before the addressing check, so a reply TO SOMEONE ELSE
  // that quoted my consult id (cc-only, or mis-addressed) unblocked me. The answer must be addressed to me.
  assert.equal(laneFor(env({ kind: "result", re: "c9", to: ["w3"], cc: ["w1"] }), me), "log", "cc-only reply with my re does not resolve");
  assert.equal(laneFor(env({ kind: "result", re: "c9", to: ["w3"] }), me), "log", "a reply addressed elsewhere does not resolve");
  assert.equal(laneFor(env({ kind: "request", re: "c9" }), me), "followUp", "a request is never an answer, even with my re");
  // D69: the console answers as room member "human", addressed to the worker — the same lane as main's or the governor's answer.
  assert.equal(laneFor(env({ kind: "result", re: "c9", from: "human", to: ["w1"], cc: ["main"] }), me), "resolve", "the human's result unblocks the worker directly");
  // and the hop TO the human never touches the worker: it is cc'd, so log-only
  assert.equal(laneFor(env({ kind: "request", re: "c9", from: "main", to: ["human"], cc: ["w1"] }), me), "log", "the request to the human is ambient for the worker");
});

test("addressing rules: only notice may broadcast; no self-delivery; inform about code must cite", () => {
  assert.equal(validateAddressing(env({ kind: "notice", to: ["*"] })), undefined);
  assert.match(validateAddressing(env({ to: ["*"] })), /only `notice` may broadcast/);
  assert.match(validateAddressing(env({ from: "w1", to: ["w1"] })), /self-delivery/);
  assert.match(validateAddressing(env({ kind: "inform", text: "the bug is in fleet/index.ts" })), /cite an artifact/);
  assert.equal(validateAddressing(env({ kind: "inform", text: "the bug is in fleet/index.ts", cites: ["fleet/index.ts:944"] })), undefined);
  assert.equal(validateAddressing(env({ kind: "inform", text: "I am starting on T3" })), undefined, "non-code inform needs no citation");
  assert.ok(looksLikeCodeClaim("test fails at line 12") && !looksLikeCodeClaim("hello there"));
});

test("header is attribution-first and minimal", () => {
  const h = renderHeader(env({ seq: 47, re: "c9", task: "T3" }), "test-suite auditor");
  assert.equal(h, "[room · request · from w2 (test-suite auditor) → w1 · #47 · re c9 · task T3]");
});

// ── roster (D42, D44) ────────────────────────────────────────────────────────

test("roster: join writes the card, bumps revision, logs an event, returns a notice; leave reverses", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-"));
  try {
    const s = new RoomStore(dir, "r1");
    const t0 = new Date("2026-09-10T10:00:00Z");
    const { roster, notice } = s.join({ name: "spies", backend: "crew", role: "test-suite auditor", responsibility: "spy census on OM events", profile: "reviewer" }, "main", t0);
    assert.equal(roster.revision, 1);
    assert.equal(roster.members[0].presence, "starting");
    assert.equal(notice.kind, "notice"); assert.deepEqual(notice.to, ["*"]);
    assert.match(notice.text, /spies joined as test-suite auditor/);
    const disk = JSON.parse(readFileSync(join(dir, "roster.json"), "utf8"));
    assert.equal(disk.members.length, 1);
    const log = readFileSync(join(dir, "room.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log[0].kind, "member_joined"); assert.equal(log[0].seq, 1); assert.equal(log[0].actor, "main");

    const left = s.leave("spies", "main", "manual kill", new Date(t0.getTime() + 1000));
    assert.equal(left.roster.members.length, 0); assert.equal(left.roster.revision, 2);
    assert.match(left.notice.text, /spies left \(manual kill\)/);
    assert.equal(s.leave("spies", "main", "again").notice, undefined, "leaving twice is a no-op, no phantom notice");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("presence: notice only on CHANGE; sweep marks unseen members gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-"));
  try {
    const s = new RoomStore(dir, "r1");
    const t0 = new Date("2026-09-10T10:00:00Z");
    s.join({ name: "w1", backend: "crew", role: "r", responsibility: "x" }, "main", t0);
    assert.ok(s.setPresence("w1", "working", t0).notice, "starting→working is a change");
    assert.equal(s.setPresence("w1", "working", t0).notice, undefined, "same presence = no chatter");
    const later = new Date(t0.getTime() + GONE_AFTER_MS + 1);
    const gone = s.sweep(later);
    assert.equal(gone.length, 1); assert.match(gone[0].text, /w1 is now gone/);
    assert.equal(s.read().members[0].presence, "gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("seq is monotonic across events and messages and survives a new store instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-"));
  try {
    const s = new RoomStore(dir, "r1");
    s.join({ name: "a", backend: "crew", role: "r", responsibility: "x" }, "main");
    const e = env({});
    s.append({ type: "message", envelope: e });
    assert.equal(e.seq, 2, "append stamps seq onto the envelope");
    const s2 = new RoomStore(dir, "r1");
    s2.join({ name: "b", backend: "fleet", role: "r", responsibility: "y" }, "main");
    const seqs = s2.since(0).map((l) => l.seq);
    assert.deepEqual(seqs, [1, 2, 3]);
    assert.deepEqual(s2.since(2).map((l) => l.seq), [3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("whoOwns + rosterLines: the roster is the peers' routing table", () => {
  const roster = { run: "r", revision: 1, updatedAt: "", members: [
    { name: "w1", backend: "crew", role: "migration owner", responsibility: "graphile→SQS migration side", presence: "working", slots: 1, joinedAt: "", lastSeen: "" },
    { name: "w2", backend: "crew", role: "reviewer", responsibility: "review PR 71255", notMyJob: "edits", presence: "idle", slots: 1, joinedAt: "", lastSeen: "" },
  ] };
  assert.deepEqual(whoOwns(roster, "migration").map((m) => m.name), ["w1"]);
  const lines = rosterLines(roster, "w1");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- w2 · reviewer · idle · owns: review PR 71255 · not: edits$/);
});

// ── digest ───────────────────────────────────────────────────────────────────

test("digest: my own events excluded, addressed-to-me excluded (it was injected), cc + notices included, presence coalesced, bounded", () => {
  const L = [
    { seq: 1, type: "event", kind: "member_joined", member: "w1", details: { role: "r", responsibility: "x" } },   // me → excluded
    { seq: 2, type: "event", kind: "member_joined", member: "w3", details: { role: "reviewer", responsibility: "PR 5" } },
    { seq: 3, type: "message", kind: "request", from: "w2", to: ["w1"], text: "do X" },                            // injected on a lane → excluded
    { seq: 4, type: "message", kind: "inform", from: "w2", to: ["w3"], cc: ["w1"], text: "FYI the build is green now" },
    { seq: 5, type: "event", kind: "presence_changed", member: "t1", details: { to: "working" } },
    { seq: 6, type: "event", kind: "presence_changed", member: "t1", details: { to: "idle" } },                      // coalesces with 5
    { seq: 7, type: "message", kind: "notice", from: "room", to: ["*"], text: "main: ruling R4 added" },
    { seq: 8, type: "message", kind: "notice", from: "room", to: ["*"], text: "w3 joined as reviewer — PR 5" },   // duplicate of event 2 → dropped
  ];
  const rel = relevantTo(L, "w1").map((l) => l.seq);
  assert.deepEqual(rel, [2, 4, 5, 6, 7], "the room's own 'X joined' notice is a duplicate of the member_joined event");
  assert.deepEqual(coalesce(relevantTo(L, "w1")).map((l) => l.seq), [2, 4, 6, 7], "presence per member → latest only");
  const d = digest(L, "w1");
  assert.match(d, /^\[room · since your last turn · 1 earlier omitted\]/, "4 items, 3 shown");
  assert.ok(d.includes("• w2: FYI the build is green now") && d.includes("• t1 idle") && d.includes("• room: main: ruling R4 added"));
  assert.ok(!d.includes("w3 joined"), "oldest dropped when over the cap");
  assert.equal(digest([], "w1"), "");
  assert.equal(digest([L[0], L[2]], "w1"), "", "nothing relevant → empty, no header");
});

test("talksTo: absent → anyone; set → main + listed ROLES or exact NAMES (-/_ equal); a name never stands in for a role; '*' notices never filtered", () => {
  const members = { implementer: "implementer", reviewer: "reviewer", reviewer_2: "reviewer", historian: "historian", "researcher-4": "researcher", newbie: "researcher" };
  const roleOf = (n) => members[n];
  const roles = new Set(Object.values(members));
  assert.equal(checkTalksTo({}, ["implementer", "newbie"], roleOf, roles), undefined, "default: anyone");
  const r = { talksTo: ["historian"] };
  assert.equal(checkTalksTo(r, ["main"], roleOf, roles), undefined, "main always");
  assert.equal(checkTalksTo(r, ["historian"], roleOf, roles), undefined, "by role");
  assert.match(checkTalksTo(r, ["implementer"], roleOf, roles), /may only address: main, historian — not implementer/);
  assert.match(checkTalksTo(r, ["reviewer_2"], roleOf, roles), /not reviewer_2/, "a same-role sibling of MINE is still excluded (independence)");
  assert.equal(checkTalksTo(r, ["*"], roleOf, roles), undefined, "broadcast notice is ambient");
  assert.equal(checkTalksTo({ talksTo: ["researcher"] }, ["newbie"], roleOf, roles), undefined, "a later joiner matches by ROLE");
  // yong-voice: the list named researcher_4; the worker was researcher-4 → exact NAME match, - and _ equal
  assert.equal(checkTalksTo({ talksTo: ["researcher_4"] }, ["researcher-4"], roleOf, roles), undefined, "exact name, -/_ normalised");
  // the reviewer's bypass: a member NAMED historian whose ROLE is implementer, when `historian` is a real role in the room
  const tricky = { historian: "implementer", scribe: "historian" };
  assert.match(checkTalksTo({ talksTo: ["historian"] }, ["historian"], (n) => tricky[n], new Set(Object.values(tricky))), /not historian/, "a name is not a role");
  assert.equal(checkTalksTo({ talksTo: ["historian"] }, ["scribe"], (n) => tricky[n], new Set(Object.values(tricky))), undefined, "…the member who HOLDS the role is who matches");
  assert.match(checkTalksTo(r, ["ghost"], roleOf, roles), /not ghost/, "a non-member never matches");
});

test("member_left preserves full handoff facts and main digest shows a bounded handoff card", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-"));
  try {
    const store = new RoomStore(dir, "r");
    store.join({ name: "historian", role: "historian", backend: "crew", responsibility: "design" });
    const handoff = { files: [{ name: "deliverable.md", bytes: 42, lines: 2 }], progress: "section 1 done", decisions: 1, lastDecision: "Use lifecycle events", lastMessage: "inform: checked", tools: 42, reason: "wedged" };
    const result = store.leave("historian", "main", "wedged", new Date("2026-09-11T00:00:00Z"), handoff);
    const events = store.since(0);
    const left = events.find((e) => e.kind === "member_left");
    assert.deepEqual(left.details.handoff, handoff);
    assert.equal(result.notice.kind, "notice");
    const text = digest(events, "main", 180);
    assert.deepEqual(text.split("\n").slice(1), ["historian left — wedged · tools≈42", "progress: section 1 done", "1 files · 1 decisions · last: inform: checked"]);
    assert.equal(text.split("\n").length, 4, "header plus at most three body lines");
    const narrow = digest(events, "main", 40);
    assert.ok(narrow.split("\n").slice(1).every((l) => l.length <= 40));
    assert.deepEqual(store.since(0).find((e) => e.kind === "member_left").details.handoff, handoff, "display truncation never changes the disk facts");
    assert.equal(store.leave("historian", "main", "again", new Date(), handoff).notice, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reason-only handoff renders missing optional facts without exceeding digest bounds", () => {
  const lines = [{ seq: 1, type: "event", kind: "member_left", member: "worker", details: { handoff: { reason: "gone" } } }];
  assert.deepEqual(digest(lines, "main").split("\n").slice(1), ["worker left — gone", "no progress line", "0 files · 0 decisions · last: not recorded"]);
});

test("departure handoff retains approximate tools and outranks newer presence chatter", () => {
  const lines = [
    { seq: 1, type: "event", kind: "member_left", member: "historian", details: { handoff: { reason: "gone", tools: 42, progress: "checkpoint done" } } },
    { seq: 2, type: "event", kind: "presence_changed", member: "a", details: { to: "idle" } },
    { seq: 3, type: "message", kind: "notice", from: "room", text: "b is now working" },
    { seq: 4, type: "event", kind: "presence_changed", member: "c", details: { to: "working" } },
  ];
  const text = digest(lines, "main", 100);
  assert.match(text, /historian left — gone · tools≈42/);
  assert.match(text, /progress: checkpoint done/);
  assert.match(text, /3 items omitted/);
  assert.doesNotMatch(text, /b is now working|• a idle|• c working/);
  assert.equal(text.split("\n").length, 4);
  assert.equal(lines[0].details.handoff.tools, 42, "approximate label does not mutate persisted vitals");
});

test("unknown tools stay null in facts and do not render an approximate placeholder", () => {
  const handoff = { reason: "no vitals", tools: null };
  const lines = [{ seq: 1, type: "event", kind: "member_left", member: "worker", details: { handoff } }];
  assert.equal(digest(lines, "main").split("\n")[1], "worker left — no vitals");
  assert.equal(handoff.tools, null);
});

test("competing departures retain newest-first first lines before spending space on details", () => {
  const departures = [1, 2, 3, 4].map((seq) => ({ seq, type: "event", kind: "member_left", member: `worker${seq}`, details: { handoff: { reason: "gone", progress: `progress${seq}`, tools: seq } } }));
  const two = digest(departures.slice(0, 2), "main");
  assert.match(two, /worker2 left — gone · tools≈2/);
  assert.match(two, /worker1 left — gone · tools≈1/);
  assert.ok(two.indexOf("worker2") < two.indexOf("worker1"));
  assert.equal(two.split("\n").length, 4);
  const four = digest(departures, "main");
  assert.deepEqual(four.split("\n").slice(1), ["worker4 left — gone · tools≈4", "worker3 left — gone · tools≈3", "worker2 left — gone · tools≈2"]);
  assert.match(four, /1 items omitted/);
});

test("room_who: a member is findable BY NAME — it was not, and peers concluded live siblings did not exist", () => {
  const members = [
    { name: "researcher", role: "researcher", responsibility: "code: the contract and 163 call sites" },
    { name: "researcher-3", role: "researcher", responsibility: "record and data: Notion, Sentry" },
    { name: "reviewer", role: "reviewer", responsibility: "judge the diff; query the researchers" },
  ];
  const match = (m, topic) => `${m.name} ${m.role ?? ""} ${m.responsibility ?? ""}`.toLowerCase().includes(topic.toLowerCase());
  const find = (topic) => members.filter((m) => match(m, topic)).map((m) => m.name);

  assert.deepEqual(find("researcher-3"), ["researcher-3"], "the live failure: a name-keyed lookup must resolve");
  assert.deepEqual(find("reviewer"), ["reviewer"]);
  assert.ok(find("researcher").includes("researcher-3"), "role still matches, so the fix is additive");
  assert.deepEqual(find("kubernetes"), [], "a genuine miss is still a miss");

  // the pre-fix behaviour, kept as the regression: name was NOT searched
  const old = (m, topic) => `${m.role ?? ""} ${m.responsibility ?? ""}`.toLowerCase().includes(topic.toLowerCase());
  assert.deepEqual(members.filter((m) => old(m, "researcher-3")).map((m) => m.name), [], "reproduces the bug");
});

test('room writer assigns the serialized cursor even when an incoming envelope already has a sequence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-cursor-'));
  try {
    const store = new RoomStore(dir, 'r');
    store.append({ type: 'message', envelope: env({ id: 'first' }) });
    store.append({ type: 'message', envelope: env({ id: 'second' }) });
    const incoming = env({ id: 'third', seq: 1 });
    assert.equal(store.append({ type: 'message', envelope: incoming }), 3);
    assert.equal(incoming.seq, 3);
    assert.deepEqual(store.since(2).map(r => r.id), ['third']);
    assert.deepEqual(store.since(0).map(r => r.id), ['first', 'second', 'third']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
