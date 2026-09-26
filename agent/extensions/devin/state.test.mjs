import assert from "node:assert/strict";
import test from "node:test";
import { advance, arrivalChecks, diff, lastDevinQuestion, mayAddress, onBoard, pollDue, rowFor, stageOf, STALE_MS, wakesOnStop, renderTranscript, verdictOf } from "./state.ts";

const base = { id: "abc123def456", slug: "sqs-kept", title: "api: Cover …", url: "https://app.devin.ai/sessions/abc123def456", kind: "build", createdAt: 1_000_000, watch: true };
const snap = (o = {}) => ({ status: "running", status_detail: "working", acus_consumed: 0, pull_requests: [], ...o });

test("diff: working → waiting_for_user emits one `stopped` carrying the question; staying stopped emits nothing", () => {
  const msgs = [{ user_id: "u1", message: "plan" }, { message: "Plan doesn't match main. How do you want to proceed?" }];
  const e1 = diff(base, snap(), snap({ status_detail: "waiting_for_user" }), msgs);
  assert.deepEqual(e1, [{ kind: "stopped", question: "Plan doesn't match main. How do you want to proceed?" }]);
  const e2 = diff(base, snap({ status_detail: "waiting_for_user" }), snap({ status_detail: "waiting_for_user" }), msgs);
  assert.deepEqual(e2, []);
});

test("diff: a PR url appearing emits `pr` once; the same PR again emits nothing", () => {
  const pr = { pr_url: "https://github.com/acme/app/pull/73061", pr_state: "open" };
  assert.deepEqual(diff(base, snap(), snap({ pull_requests: [pr] }), []), [{ kind: "pr", url: pr.pr_url, number: 73061, repo: "acme/app" }]);
  assert.deepEqual(diff(base, snap({ pull_requests: [pr] }), snap({ pull_requests: [pr] }), []), []);
});

test("diff (D97): ENDED statuses emit `ended`; PAUSED ones emit a row-only `paused`; resuming from a stop emits `resumed`", () => {
  assert.deepEqual(diff(base, snap(), snap({ status: "finished", status_detail: "finished" }), []), [{ kind: "ended", status: "finished" }]);
  // suspended · blocked · stopped are Devin finishing a turn, not the session's end: the row stays, nobody is woken
  assert.deepEqual(diff(base, snap(), snap({ status: "suspended", status_detail: "inactivity" }), []), [{ kind: "paused", status: "suspended" }]);
  assert.deepEqual(diff(base, snap(), snap({ status: "blocked", status_detail: "blocked" }), []), [{ kind: "paused", status: "blocked" }]);
  assert.deepEqual(diff(base, snap({ status: "suspended" }), snap({ status: "suspended" }), []), [], "staying paused says nothing");
  assert.deepEqual(diff(base, snap({ status: "suspended" }), snap(), []), [{ kind: "resumed" }], "a paused session picking work back up resumes");
  assert.deepEqual(diff(base, snap({ status_detail: "waiting_for_user" }), snap(), []), [{ kind: "resumed" }]);
  // the PR closing ends the row's reason to exist, whatever Devin's own status says
  const pr = { pr_url: "https://github.com/acme/app/pull/7", pr_state: "open" };
  assert.deepEqual(diff(base, snap({ status: "suspended", pull_requests: [pr] }), snap({ status: "suspended", pull_requests: [{ ...pr, pr_state: "merged" }] }), []), [{ kind: "ended", status: "PR merged" }]);
});

test("pollDue (D97): a live row polls every 30 s, a paused one every 10 min, an ended or signed-off one never", () => {
  const live = { ...base, last: snap(), polledAt: 0 };
  assert.equal(pollDue(live, 31_000), true); assert.equal(pollDue(live, 10_000), false);
  const paused = { ...base, last: snap({ status: "suspended" }), polledAt: 0 };
  assert.equal(pollDue(paused, 31_000), false); assert.equal(pollDue(paused, 601_000), true);
  assert.equal(pollDue({ ...base, last: snap({ status: "finished" }), polledAt: 0 }, 1e9), false);
  assert.equal(pollDue({ ...live, signedOffAt: 5 }, 1e9), false);
});

test("lastDevinQuestion: the newest message without a user_id, else undefined", () => {
  assert.equal(lastDevinQuestion([{ user_id: "u", message: "x" }]), undefined);
  assert.equal(lastDevinQuestion([{ message: "old" }, { user_id: "u", message: "me" }, { message: "new?" }]), "new?");
});

test("rowFor: states map onto the crew board vocabulary — working, waiting on main, PR open, ended", () => {
  const now = 1_000_000 + 12 * 60_000;
  const working = rowFor({ ...base, last: snap({ acus_consumed: 0.4 }) }, now);
  assert.equal(working.state, "working"); assert.match(working.detail, /0\.4 ACU/); assert.equal(working.pane, "devin"); assert.equal(working.ageMs, 12 * 60_000);
  const stopped = rowFor({ ...base, last: snap({ status_detail: "waiting_for_user" }), question: "Which DB?", stoppedAt: now - 60_000 }, now);
  assert.equal(stopped.state, "waiting"); assert.equal(stopped.waiting.on, "main"); assert.match(stopped.detail, /Which DB\?/);
  const ack = rowFor({ ...base, last: snap({ status_detail: "waiting_for_user" }), question: "Understood — staying attached.", stoppedAt: now - 60_000 }, now);
  assert.equal(ack.state, "idle"); assert.match(ack.detail, /paused · Understood/);
  const withPr = rowFor({ ...base, last: snap({ pull_requests: [{ pr_url: "https://github.com/acme/app/pull/73061", pr_state: "open" }] }) }, now);
  assert.match(withPr.detail, /#73061/);
  const ended = rowFor({ ...base, last: snap({ status: "finished" }) }, now);
  assert.equal(ended.state, "done");
});

test("arrivalChecks: every row is a fact from the PR; failures name the expectation that broke", () => {
  const pr = { isDraft: true, headRefName: "yong/sqs-kept-causes-spec", files: [{ path: "packages/api/src/x.spec.ts" }], commits: [{ authors: [{ email: "jane@acme.example" }] }] };
  const expect = { branch: "yong/sqs-kept-causes-spec", authorEmail: "jane@acme.example", filesMatch: "\\.spec\\.ts$" };
  assert.deepEqual(arrivalChecks(pr, expect), { ok: true, failures: [] });
  const bad = arrivalChecks({ ...pr, isDraft: false, commits: [{ authors: [{ email: "devin@bot" }] }], files: [{ path: "packages/api/src/x.ts" }] }, expect);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failures, ["not a draft", "commit author devin@bot ≠ jane@acme.example", "file outside /\\.spec\\.ts$/: packages/api/src/x.ts"]);
});

test("isQuestion: a stop wakes main only when Devin asks something; an acknowledgement is row telemetry", async () => {
  const { isQuestion } = await import("./state.ts");
  assert.equal(isQuestion("Understood — staying attached to #73061 and will only act on bot/CI comments if any arrive."), false);
  assert.equal(isQuestion("On it — adding the specs, then opening a draft PR."), false);
  assert.equal(isQuestion("Plan doesn't match main.\n- no `yielded` reason\nHow do you want to proceed?"), true);
  assert.equal(isQuestion("CI passed on the PR. PR remains draft."), false);
  assert.equal(isQuestion("Should I also cover attempt_failed"), true);
  assert.equal(isQuestion("I need the DATABASE_URL for api_test — which one?"), true);
  assert.equal(isQuestion("Blocked: the environment blueprint failed and I cannot run the specs."), true);
});

test("onBoard: a row paints only in the pi session that owns it; unowned/legacy rows paint nowhere", () => {
  const now = Date.now();
  const mine = { id: "a", title: "a", url: "u", kind: "build", createdAt: now - 1000, watch: true, owner: { session: "S1" }, last: { status: "running" } };
  const theirs = { ...mine, id: "b", owner: { session: "S2" } };
  const legacy = { ...mine, id: "c", owner: undefined };
  assert.equal(onBoard(mine, "S1", now), true);
  assert.equal(onBoard(theirs, "S1", now), false, "another session's live Devin work is not my board's business");
  assert.equal(onBoard(legacy, "S1", now), false);
  assert.equal(onBoard({ ...mine, last: { status: "finished" }, events: [{ at: now - 11 * 60_000, text: "x" }] }, "S1", now), false, "ENDED rows leave after the 10-min grace");
  assert.equal(onBoard({ ...mine, last: { status: "finished" }, events: [{ at: now - 60_000, text: "x" }] }, "S1", now), true, "…but the end is seen first");
  // D97: a pause is not an end — the row stays, however old, until Yong signs it off
  assert.equal(onBoard({ ...mine, last: { status: "suspended" }, events: [{ at: now - 11 * 60_000, text: "x" }] }, "S1", now), true, "a paused row stays");
  assert.equal(onBoard({ ...mine, createdAt: now - 10 * 86_400_000, last: { status: "suspended" } }, "S1", now), true, "age never hides a row");
  assert.equal(onBoard({ ...mine, last: { status: "suspended" }, signedOffAt: now - 1 }, "S1", now), false, "signed off → gone");
});

test("rowFor (D97): a paused row keeps its stage — Yong's move stays ⏳ alert, Devin's move reads as a quiet pause", () => {
  const now = 3_600_000;
  const pr = [{ pr_url: "https://github.com/o/r/pull/7", pr_state: "draft" }];
  const yours = rowFor({ ...base, last: snap({ status: "suspended", status_detail: "inactivity", pull_requests: pr }), stage: { name: "PR #7 · pushed · your un-draft", move: "you", at: 0 } }, now);
  assert.equal(yours.state, "waiting"); assert.equal(yours.waiting.on, "you");
  const idle = rowFor({ ...base, last: snap({ status: "suspended", status_detail: "inactivity" }), stage: { name: "building", move: "devin", at: 0 } }, now);
  assert.equal(idle.state, "idle"); assert.match(idle.detail, /^suspended · building · 1h/);
  const legacy = rowFor({ ...base, last: snap({ status: "suspended" }) }, now);
  assert.equal(legacy.state, "idle", "a pre-stage row that paused is idle, not done"); assert.match(legacy.detail, /^suspended/);
  const ended = rowFor({ ...base, last: snap({ status: "finished" }) }, now);
  assert.equal(ended.state, "done");
});

test("rowFor + health: a live row says on ITSELF when it cannot be polled — no separate warning line", () => {
  const now = Date.now();
  const s = { id: "a", title: "a", url: "u", kind: "build", createdAt: now - 3_600_000, watch: true, polledAt: now - 5 * 60_000, last: { status: "running", status_detail: "working" } };
  assert.equal(rowFor(s, now).detail, "working", "no health → the plain row (the /devin list)");
  assert.match(rowFor(s, now, { leased: true, keyRejected: false }).detail, /^working · stale 5m/);
  assert.equal(rowFor({ ...s, polledAt: now - 10_000 }, now, { leased: true }).detail, "working", "fresh poll → nothing to say");
  const unleased = rowFor(s, now, { leased: false });
  assert.equal(unleased.state, "idle"); assert.match(unleased.detail, /^stale 5m\S* — secret_unlock devin$/);
  const rejected = rowFor(s, now, { leased: true, keyRejected: true });
  assert.equal(rejected.state, "stalled"); assert.match(rejected.detail, /key rejected \(401\)/);
  assert.equal(rowFor({ ...s, last: { status: "finished" } }, now, { leased: false }).detail, "finished", "a finished row needs no key");
  assert.ok(STALE_MS >= 60_000);
});

test("wakesOnStop: a design session wakes main on EVERY stop (a review reply is owed an answer); a build only on a question", () => {
  assert.equal(wakesOnStop("design", "Here is my assessment. VERDICT: agree"), true);
  assert.equal(wakesOnStop("build", "Here is my assessment. VERDICT: agree"), false);
  assert.equal(wakesOnStop("build", "Should I use the outbox table?"), true);
  assert.equal(wakesOnStop("design", ""), false, "an empty stop has nothing to answer");
});

test("renderTranscript: verbatim, both sides, in order, with who and when — and a header that says it is regenerated", () => {
  const msgs = [
    { user_id: "u1", username: "Jane Doe", message: "PLAN v1\nfiles: a.ts", created_at: 1_700_000_000 },
    { user_id: null, message: "Issue: a.ts was renamed to b.ts on origin/main.\nVERDICT: amend", created_at: 1_700_000_600 },
    { user_id: "u1", message: "PLAN v2\nfiles: b.ts", created_at: 1_700_001_200 },
  ];
  const out = renderTranscript({ title: "an earlier ticket thing", url: "https://app.devin.ai/sessions/x", kind: "design" }, msgs, 1_700_002_000_000);
  assert.match(out, /^# Design review with Devin — an earlier ticket thing/);
  assert.match(out, /rewritten by the pi `devin` extension/);
  assert.match(out, /## Rulings/, "the head main fills in is scaffolded on the first write");
  assert.match(out, /## 1 · pi → Devin/); assert.match(out, /## 2 · Devin → pi/); assert.match(out, /## 3 · pi → Devin/);
  assert.ok(out.indexOf("PLAN v1") < out.indexOf("VERDICT: amend") && out.indexOf("VERDICT: amend") < out.indexOf("PLAN v2"), "in order");
  assert.match(out, /files: a\.ts/, "verbatim, nothing summarized");
  assert.match(out, /https:\/\/app\.devin\.ai\/sessions\/x/);
});

test("verdictOf: the last Devin message's VERDICT line, else undefined", () => {
  const msgs = [{ user_id: null, message: "…\nVERDICT: amend" }, { user_id: "u", message: "ok" }, { user_id: null, message: "Looks right now.\nVERDICT: agree — no further issues" }];
  assert.equal(verdictOf(msgs), "agree");
  assert.equal(verdictOf([{ user_id: null, message: "no verdict line" }]), undefined);
  assert.equal(verdictOf([]), undefined);
});

test("rowFor: a design session that replied is WAITING on main even without a question mark", () => {
  const base = { id: "d", title: "t", url: "u", createdAt: 0, watch: true, last: { status: "running", status_detail: "waiting_for_user" }, question: "Assessment done. VERDICT: amend", stoppedAt: 0 };
  assert.equal(rowFor({ ...base, kind: "design" }, 1000).state, "waiting");
  assert.equal(rowFor({ ...base, kind: "build" }, 1000).state, "idle");
});

test("renderTranscript: main's rulings above the marker survive a regeneration; the transcript below is replaced whole", () => {
  const s = { title: "t", url: "u", kind: "design" };
  const first = renderTranscript(s, [{ user_id: "y", message: "PLAN v1", created_at: 1 }], 2000);
  assert.match(first, /<!-- transcript -->/);
  const edited = first.replace("<!-- transcript -->", "| 1 | x | y | z |\n\n<!-- transcript -->");
  const second = renderTranscript(s, [{ user_id: "y", message: "PLAN v1", created_at: 1 }, { user_id: null, message: "VERDICT: agree", created_at: 2 }], 3000, edited);
  assert.match(second, /\| 1 \| x \| y \| z \|/, "rulings kept");
  assert.equal(second.split("<!-- transcript -->").length, 2, "exactly one marker");
  assert.match(second, /## 2 · Devin → pi/);
  assert.ok(second.indexOf("## Rulings") < second.indexOf("<!-- transcript -->"), "head stays above");
  assert.doesNotMatch(second, /## Rulings[\s\S]*## Rulings/, "not duplicated");
});

// ── stage: where the /task flow is and whose move it is — an explicit field set at each transition, never inferred from prose ──
test("advance: the design → go → build → PR → first pass → fixing → done ladder, with the move at each rung", () => {
  const s = { id: "d", title: "t", url: "u", createdAt: 0, watch: true, kind: "design" };
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "design r1", move: "devin" }, "a fresh design session is Devin's move");
  advance(s, { kind: "design_reply", verdict: "amend" }, 100);
  assert.deepEqual({ ...stageOf(s), at: undefined }, { name: "design r1 · VERDICT amend", move: "main", at: undefined });
  advance(s, { kind: "main_said" }, 200);
  assert.equal(stageOf(s).name, "design r2"); assert.equal(stageOf(s).move, "devin");
  advance(s, { kind: "design_reply", verdict: "agree" }, 300);
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "design r2 · agreed", move: "you" }, "agree ⇒ Yong's go");
  advance(s, { kind: "go" }, 400); s.kind = "build";
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "building", move: "devin" });
  advance(s, { kind: "asked" }, 500);
  assert.equal(stageOf(s).move, "main");
  advance(s, { kind: "main_said" }, 600);
  assert.equal(stageOf(s).name, "building");
  advance(s, { kind: "pr", number: 7 }, 700);
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "PR #7 · first pass owed", move: "main" });
  advance(s, { kind: "main_said" }, 800);
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "PR #7 · Devin fixing", move: "devin" });
  advance(s, { kind: "paused" }, 900);
  assert.deepEqual({ name: stageOf(s).name, move: stageOf(s).move }, { name: "PR #7 · pushed · your un-draft", move: "you" });
  advance(s, { kind: "ended", status: "finished" }, 1000);
  assert.equal(stageOf(s).move, "none");
  assert.equal(s.stage.at, 1000, "at = when this stage began");
});

test("rowFor: the stage is the row — detail names it, the glyph is whose move, age is time IN the stage", () => {
  const s = { id: "d", title: "t", slug: "bpt", url: "u", createdAt: 0, watch: true, kind: "build", last: { status: "running", status_detail: "working", acus_consumed: 1.5, pull_requests: [{ pr_url: "https://github.com/o/r/pull/7", pr_state: "draft" }] }, stage: { name: "PR #7 · first pass owed", move: "main", at: 60_000 } };
  const r = rowFor(s, 120_000);
  assert.equal(r.state, "waiting"); assert.equal(r.waiting.on, "main");
  assert.match(r.detail, /PR #7 · first pass owed/); assert.match(r.detail, /1\.5 ACU/);
  assert.equal(r.waiting.sinceMs, 60_000, "since the stage began, not since creation");
  const yours = rowFor({ ...s, stage: { name: "PR #7 · pushed · your un-draft", move: "you", at: 60_000 } }, 120_000);
  assert.equal(yours.waiting.on, "you", "Yong's move sorts first and shows ⏳");
  const devins = rowFor({ ...s, stage: { name: "building", move: "devin", at: 60_000 } }, 120_000);
  assert.equal(devins.state, "working"); assert.match(devins.detail, /^building · working/);
});

test("rowFor: without a stage (rows written before stages existed) the old status row still renders", () => {
  const r = rowFor({ id: "d", title: "t", url: "u", createdAt: 0, watch: true, kind: "build", last: { status: "running", status_detail: "working" } }, 1000);
  assert.equal(r.state, "working"); assert.equal(r.detail, "working");
});

test("mayAddress: a live owner keeps the conversation — another main may read, not speak or re-claim; dead or absent owner ⇒ open", () => {
  const owned = { ...base, owner: { session: "S1", pane: "%2", pid: 45037, cwd: "/x" } };
  assert.equal(mayAddress(owned, "S1", () => true).ok, true);                                    // mine
  const r = mayAddress(owned, "S2", () => true);
  assert.equal(r.ok, false);
  assert.match(r.reason, /S1|owner/);
  assert.match(r.reason, /devin_messages/);                                                        // the refusal says what to do instead
  assert.equal(mayAddress(owned, "S2", () => false).ok, true);                                   // owner dead ⇒ open
  assert.equal(mayAddress({ ...base }, "S2", () => true).ok, true);                              // never owned ⇒ open
  assert.equal(mayAddress(owned, undefined, () => true).ok, false);                              // no session id (tests, CLI) ⇒ never speaks into a live-owned one
});

test("onBoard: a session whose PR closed is ended — on the board through the 10 min grace, then gone, even while Devin still says suspended", () => {
  const closed = { ...base, owner: { session: "S1" }, last: snap({ status: "suspended", pull_requests: [{ pr_url: "https://github.com/acme/app/pull/1", pr_state: "closed" }] }), events: [{ at: 1_000_000, text: "session PR closed" }] };
  assert.equal(onBoard(closed, "S1", 1_000_000 + 60_000), true);          // grace: the end is seen
  assert.equal(onBoard(closed, "S1", 1_000_000 + 11 * 60_000), false);    // then it leaves, no /devin done needed
  const open = { ...closed, last: snap({ status: "suspended", pull_requests: [{ pr_url: "https://github.com/acme/app/pull/1", pr_state: "open" }] }) };
  assert.equal(onBoard(open, "S1", 1_000_000 + 11 * 60_000), true);       // control: an open PR keeps a paused row
});
