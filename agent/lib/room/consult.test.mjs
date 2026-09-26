import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, makeRequest, answerMatches, overBudget, actionHash, humanLine, resolutionText, replayText, DEFAULT_BUDGET } from "./consult.ts";

test("human-only kinds are HUMAN_REQUIRED regardless of wording", () => {
  for (const k of ["auth", "irreversible", "notify", "money", "policy", "scope"]) {
    const c = classify(k, "anything at all");
    assert.ok(c.humanRequired, k); assert.equal(c.class, k);
  }
});

test("judgment kinds stay with the governor unless the question describes a human-only ACT", () => {
  assert.equal(classify("confirm", "Is the sky blue in this test?").humanRequired, false);
  assert.equal(classify("clarify", "Should I use camelCase or snake_case for the new field?").humanRequired, false);
  assert.equal(classify("stuck", "rg finds no callers of createEvent — is the file name different?").humanRequired, false);
  // the class is about the act, not the label the worker picked
  const a = classify("confirm", "OK to force-push the rebased branch?");
  assert.ok(a.humanRequired); assert.equal(a.class, "irreversible");
  const b = classify("clarify", "Should I request a review from Alex on this PR?");
  assert.ok(b.humanRequired); assert.equal(b.class, "notify");
  const c = classify("confirm", "The dashboard shows an Okta login page — proceed?");
  assert.ok(c.humanRequired); assert.equal(c.class, "auth");
  const d = classify("query", "Can I deploy this to production now?");
  assert.ok(d.humanRequired); assert.equal(d.class, "irreversible");
  const e = classify("confirm", "This is beyond my brief — should I take over the migration side too?");
  assert.ok(e.humanRequired); assert.equal(e.class, "scope");
});

test("request carries a stable action hash; the answer must name the id AND match the hash", () => {
  const r = makeRequest({ id: "c-w1-1", run: "r", worker: "w1", kind: "confirm", question: "Is  the sky   blue?" });
  assert.equal(r.actionHash, actionHash("w1", "confirm", "is the sky blue?"), "hash normalizes whitespace + case");
  assert.equal(answerMatches(r, { id: "c-w1-1", actionHash: r.actionHash }), undefined);
  assert.match(answerMatches(r, { id: "c-w1-2", actionHash: r.actionHash }), /not c-w1-1/, "a bare yes for another consult resolves nothing");
  assert.match(answerMatches(r, { id: "c-w1-1", actionHash: "deadbeef" }), /hash mismatch/);
  assert.equal(answerMatches(r, { id: "c-w1-1" }), undefined, "a human answer without a hash is accepted by id");
});

test("budget: count and minutes; timeouts never assent", () => {
  const t0 = new Date("2026-09-10T10:00:00Z");
  assert.equal(overBudget(0, undefined, t0), undefined);
  assert.equal(overBudget(DEFAULT_BUDGET.maxConsults - 1, t0.toISOString(), t0), undefined);
  assert.match(overBudget(DEFAULT_BUDGET.maxConsults, t0.toISOString(), t0), /8 consults used/);
  assert.match(overBudget(1, t0.toISOString(), new Date(t0.getTime() + 31 * 60_000)), /31 min since first consult/);
});

test("human line is one actionable line; resolution text names who answered", () => {
  const r = makeRequest({ id: "c-w1-3", run: "r", worker: "w1", kind: "irreversible", question: "Delete the stale branch wt-old?" });
  assert.match(humanLine(r), /^◆ w1 · c-w1-3 · irreversible: Delete the stale branch wt-old\?  → \/crew_cli answer c-w1-3 <text>$/);
  assert.equal(resolutionText({ id: "c-w1-3", actionHash: r.actionHash, by: "human", text: "yes, delete it", answeredAt: "" }), "HUMAN: yes, delete it");
  assert.equal(resolutionText({ id: "c-w1-3", actionHash: r.actionHash, by: "governor", text: "proceed", answeredAt: "" }), "GOVERNOR: proceed");
});

// ── the human's decision (built after a bare "waiting on YOU · c-implementer-2" row, 2026-09-10) ─────────────────────
import { deriveAction, decisionOptions, decisionCard, needsYouLine } from "./consult.ts";
import { parsePacket, packetPrompt } from "../governor/prompt.ts";

test("deriveAction: a human-class question without an explicit action still yields WHAT (verb sniffed); judgment kinds yield nothing", () => {
  const a = deriveAction("irreversible", "May I git commit on branch x with message 'y'? No push.");
  assert.equal(a.verb, "commit");
  assert.ok(a.target.startsWith("May I git commit"));
  assert.equal(deriveAction("confirm", "is this done?"), undefined);
  assert.equal(deriveAction("notify", "ok to ping Alex for review?").verb, "notify", "no verb matched → the class is the verb");
});

test("decisionCard: who · action · why yours · evidence · recommendation — never a bare id, never reply syntax", () => {
  const req = makeRequest({ id: "c-impl-1-2", run: "r", worker: "implementer", kind: "irreversible", question: "May I commit 4 files on crew/x? No push.", evidence: ["#538 reviewer ✅", "#541 reviewer-2 ✅"], action: { verb: "commit", target: "crew/x · 4 files", detail: "fix(crew): …" }, intent: { why: "checkpoint the reviewed fix", exact: "git commit -m 'fix(crew): …' (4 files)", effect: "one commit on crew/x, nothing pushed", reversible: "yes — git reset", ifDenied: "work stays unstaged on disk" } });
  const lines = decisionCard(req, { question: "Commit these four files?", context: "Review is complete; this only checkpoints the branch.", whyHuman: "irreversible: a commit cannot be unwound by the room", recommendation: "approve", why: "both reviewers approved the final diff", checked: ["#538 exists", "#541 exists"], risk: "wrong fix lands on the branch (recoverable: branch only)" });
  const text = lines.join("\n");
  assert.equal(lines[0], "implementer needs your decision · c-impl-1-2 · irreversible");
  assert.equal(lines[1], "Question: Commit these four files?");
  assert.ok(lines.includes("Action: commit — crew/x · 4 files (fix(crew): …)"));
  assert.match(text, /Why yours: irreversible/);
  assert.match(text, /Evidence: #538 reviewer ✅ · #541 reviewer-2 ✅/);
  assert.match(text, /Governor checked: #538 exists · #541 exists/);
  assert.match(text, /▶ Governor: Approve — both reviewers/); assert.ok(text.indexOf("▶ Governor") < text.indexOf("Choices:"), "advisory before the choices, never after");
  assert.ok(!/\/crew answer/.test(text), "no reply syntax on the card");
  const bare = decisionCard(makeRequest({ id: "c-a-1-1", run: "r", worker: "a", kind: "notify", question: "ping Alex?" }), undefined);
  assert.match(bare.join("\n"), /▶ Governor: clarify before deciding/);
});

test("decisionOptions: options come from the CLASS; ⭐ from the packet; 'show' is always available for the decisive classes", () => {
  const irr = decisionOptions("irreversible", { whyHuman: "x", recommendation: "approve" });
  assert.deepEqual(irr.map((o) => o.key), ["approve", "amend", "ask", "show", "reject"]);
  assert.equal(irr.find((o) => o.recommended).key, "approve");
  const rej = decisionOptions("irreversible", { whyHuman: "x", recommendation: "reject" });
  assert.equal(rej.find((o) => o.recommended).key, "reject");
  const none = decisionOptions("irreversible", undefined);
  assert.equal(none.filter((o) => o.recommended).length, 0, "no packet → no ⭐ (never invent a recommendation)");
  assert.deepEqual(decisionOptions("notify").map((o) => o.key), ["approve", "amend", "ask", "later", "reject"]);
  assert.deepEqual(decisionOptions("auth").map((o) => o.key), ["self", "ask", "skip", "reject"]);
  for (const o of irr) assert.ok(o.label.split(" ").length <= 4 && /\./.test(o.description), "labels ≤4 words; descriptions are sentences");
});

test("needsYouLine: the action in words on the row, never the bare id", () => {
  const req = makeRequest({ id: "c-impl-1-2", run: "r", worker: "implementer", kind: "irreversible", question: "q", action: { verb: "commit", target: "crew/x · 4 files" } });
  assert.equal(needsYouLine(req), "needs you: commit · crew/x · 4 files");
  assert.ok(!needsYouLine(req).includes("c-impl"));
});

test("governor packet: prompt forbids answering; parse is lenient and never invents a recommendation", () => {
  assert.match(packetPrompt({ id: "c1", worker: "w", kind: "irreversible", question: "q" }), /may NOT answer it/);
  const p = parsePacket("CHECKED: #538 exists; #541 exists\nRISK: wrong fix on branch\nRECOMMEND: approve — both approved");
  assert.deepEqual(p, { checked: ["#538 exists", "#541 exists"], risk: "wrong fix on branch", recommendation: "approve", why: "both approved" });
  assert.deepEqual(parsePacket("I think you should just do it"), { checked: [] });
  assert.equal(parsePacket("RECOMMEND: yes").recommendation, undefined, "'yes' is not one of the three words");
  assert.deepEqual(parsePacket("CHECKED: nothing verifiable").checked, []);
  // live failure 2026-09-11: all three fields on ONE line → card said "none" and swallowed RISK/RECOMMEND into "checked"
  const one = parsePacket("CHECKED: brief requests one clause; room log records 23/23 RISK: commit could include unintended content RECOMMEND: needs-info — inspect the diff first.");
  assert.deepEqual(one.checked, ["brief requests one clause", "room log records 23/23"]);
  assert.equal(one.risk, "commit could include unintended content");
  assert.equal(one.recommendation, "needs-info");
  assert.equal(one.why, "inspect the diff first.");
});

test("classify: start/stop/restart need an OBJECT to be irreversible — a status sentence is not an act (live 2026-09-11)", () => {
  assert.equal(classify("stuck", "ordered item 2 cannot start before item 1 commit").humanRequired, false, "status, not an act");
  assert.equal(classify("stuck", "blocked; please arrange main integration before I start item 3").humanRequired, false);
  assert.equal(classify("confirm", "may I restart the dsync worker?").class, "irreversible");
  assert.equal(classify("confirm", "ok to stop the staging queue consumer?").class, "irreversible");
  assert.equal(classify("confirm", "should I deploy this?").class, "irreversible", "unchanged: deploy needs no object");
});

import { signOff, mergePrompt } from "./consult.ts";

test("signOff: the team's shape decides the reviewer set (role contains review/test); the LATEST verdict counts; a propose withdraws (D57)", () => {
  const members = [{ name: "implementer", role: "implementer" }, { name: "reviewer", role: "reviewer" }, { name: "reviewer-2", role: "reviewer" }, { name: "historian", role: "historian" }];
  const ok = signOff(members, [{ from: "reviewer", kind: "result", seq: 10 }, { from: "reviewer-2", kind: "result", seq: 12 }]);
  assert.equal(ok.complete, true); assert.deepEqual(ok.missing, []);
  assert.equal(ok.reviewers.length, 2, "the historian and implementer are not lenses");
  const withdrawn = signOff(members, [{ from: "reviewer", kind: "result", seq: 10 }, { from: "reviewer", kind: "propose", seq: 14 }, { from: "reviewer-2", kind: "result", seq: 12 }]);
  assert.equal(withdrawn.complete, false); assert.deepEqual(withdrawn.missing, ["reviewer (propose)"], "the latest verdict is the verdict");
  assert.equal(signOff(members, []).complete, false);
  assert.equal(signOff([{ name: "implementer", role: "implementer" }], [] ).complete, false, "no lenses at all is never complete");
});

test("mergePrompt: carries Yong's standing ruling, the commit list, every verdict with its seq, and asks the governor to VERIFY not to decide", () => {
  const p = mergePrompt({ branch: "crew/x", repo: "pi-config", commits: [{ sha: "aa1507fabc", message: "crew: thing" }], suite: "225/225 green", sign: signOff([{ name: "reviewer", role: "reviewer" }], [{ from: "reviewer", kind: "result", seq: 9 }]) });
  assert.match(p, /STANDING RULING/); assert.match(p, /do not wake me/);
  assert.match(p, /aa1507f crew: thing/); assert.match(p, /reviewer=result\(#9\)/); assert.match(p, /225\/225 green/);
  assert.match(p, /VERIFY, not to decide policy/); assert.match(p, /ANSWER: merge approved/); assert.match(p, /ESCALATE:/);
});

test("signOff freshness: a commit AFTER the review it answered makes the approval STALE — a commit is a checkpoint, 'ready' is an event (D57)", () => {
  const members = [{ name: "reviewer", role: "reviewer" }, { name: "reviewer-2", role: "reviewer" }];
  const requests = { r1: "2026-09-11T10:00:00Z", r2: "2026-09-11T10:05:00Z", r3: "2026-09-11T10:20:00Z" };
  const at = (re) => requests[re];
  const verdicts = [
    { from: "reviewer", kind: "result", seq: 10, at: "2026-09-11T10:02:00Z", re: "r1" },
    { from: "reviewer-2", kind: "result", seq: 12, at: "2026-09-11T10:07:00Z", re: "r2" },
  ];
  // no commit since → both fresh
  assert.equal(signOff(members, verdicts, { lastCommitAt: "2026-09-11T09:59:00Z", requestAt: at }).complete, true);
  // a checkpoint commit at 10:10 invalidates BOTH approvals (each reviewed an earlier state)
  const after = signOff(members, verdicts, { lastCommitAt: "2026-09-11T10:10:00Z", requestAt: at });
  assert.equal(after.complete, false);
  assert.deepEqual(after.missing, ["reviewer (stale)", "reviewer-2 (stale)"]);
  // re-requested at 10:20 and re-approved → fresh again
  const re = signOff(members, [...verdicts, { from: "reviewer", kind: "result", seq: 20, at: "2026-09-11T10:22:00Z", re: "r3" }, { from: "reviewer-2", kind: "result", seq: 21, at: "2026-09-11T10:23:00Z", re: "r3" }], { lastCommitAt: "2026-09-11T10:10:00Z", requestAt: at });
  assert.equal(re.complete, true, "approvals of the current state count");
  // without freshness info, behaviour is unchanged (no false staleness)
  assert.equal(signOff(members, verdicts).complete, true);
});

// ── P2 (crew-console): intent, the human as a room member ───────────────────────────────────────────────────────────
import { HUMAN_MEMBER, intentGap, humanRequest, humanChoice, stripWho } from "./consult.ts";

const FULL = { why: "prove the flag gates it", exact: "POST …; DELETE …", effect: "one endpoint for 30s in prod", reversible: "yes — DELETE", ifDenied: "skip the probe" };

test("intent: human-tier acts need the full intent (auth needs only why + exact); judgment kinds never do", () => {
  const irr = (intent) => makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent });
  assert.equal(intentGap(irr(FULL)), undefined);
  assert.equal(intentGap(irr(undefined)), "why, exact, effect, reversible, ifDenied");
  assert.equal(intentGap(irr({ ...FULL, reversible: "" })), "reversible");
  const auth = makeRequest({ id: "c-w-1-2", run: "r", worker: "w", kind: "auth", question: "sign in to the dashboard", action: { verb: "login", target: "signin.acme-test.example" }, intent: { why: "read the flag", exact: "signin.acme-test.example as acme-staging" } });
  assert.equal(intentGap(auth), undefined);
  assert.equal(intentGap(makeRequest({ id: "c-w-1-3", run: "r", worker: "w", kind: "clarify", question: "a or b?" })), undefined);
});

test("intent: without it a human-tier card offers no Approve — only 'Get exact intent' (which resolves the consult so the worker re-asks) and reject", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" } });
  const opts = decisionOptions("irreversible", { whyHuman: "x" }, req);
  assert.deepEqual(opts.map((o) => o.key), ["intent", "reject"]);
  assert.match(opts[0].answer, /INCOMPLETE.*why, exact, effect, reversible, ifDenied/s);
  const withIntent = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent: FULL });
  assert.ok(decisionOptions("irreversible", { whyHuman: "x", question: "Delete ep_1?" }, withIntent).some((o) => o.key === "approve"), "with intent, Approve exists");
  const card = decisionCard(withIntent, { whyHuman: "x" }).join("\n");
  assert.match(card, /Intent\n\s+why\s+prove the flag gates it\n\s+exact\s+POST …; DELETE …\n\s+effect\s+one endpoint/);
  assert.match(card, /if denied\s+skip the probe/);
});

test("the human is a room member: the request is addressed to it (worker cc'd), the answer is its result", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent: FULL });
  const env = humanRequest(req, { whyHuman: "kind=irreversible is human-only", recommendation: "approve" });
  assert.deepEqual([env.to, env.cc, env.kind, env.re, env.task], [[HUMAN_MEMBER], ["w"], "request", "c-w-1-1", "consult"]);
  const body = JSON.parse(env.text).consult;
  assert.deepEqual([body.id, body.worker, body.kind, body.intent.exact, body.packet.recommendation, body.actionHash], ["c-w-1-1", "w", "irreversible", "POST …; DELETE …", "approve", req.actionHash]);
  // what the console publishes is what the worker's blocking call receives — main only records it
  const wire = resolutionText({ id: "c-w-1-1", actionHash: req.actionHash, by: "human", text: "APPROVED by Yong: delete — ep_1. Do exactly this and nothing beyond it.", answeredAt: "t" });
  assert.equal(stripWho(wire), "APPROVED by Yong: delete — ep_1. Do exactly this and nothing beyond it.");
  assert.equal(humanChoice(wire), "approve");
  for (const [t, c] of [["HUMAN: REJECTED by Yong: no", "reject"], ["HUMAN: DECIDED by Yong: b", "decide"], ["HUMAN: NOT NOW (Yong): later", "later"], ["HUMAN: SKIP (Yong): x", "skip"], ["HUMAN: APPROVED by Yong WITH AMENDMENT — x", "amend"], ["HUMAN: I'll do it — Yong signs in", "self"], ["HUMAN: something", null]])
    assert.equal(humanChoice(t), c, t);
});

import { askFirstText } from "./consult.ts";
test("'Ask first' is a verdict: every human-tier set offers it; it resolves with the question and the re-consult threads", () => {
  const base = { id: "c-w-1-1", run: "r", worker: "w", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent: FULL };
  for (const kind of ["irreversible", "notify", "money", "scope", "policy", "auth"]) {
    const req = makeRequest({ ...base, kind, intent: kind === "auth" ? { why: "w", exact: "x" } : FULL });
    assert.ok(decisionOptions(kind, { whyHuman: "x", question: "q" }, req).some((o) => o.key === "ask"), kind);
  }
  const req = makeRequest({ ...base, kind: "irreversible" });
  const text = askFirstText(req, "why prod and not staging?");
  assert.match(text, /^QUESTION from Yong: why prod and not staging\?\nNot decided\./);
  assert.match(text, /re: "c-w-1-1"/); assert.match(text, /Do NOT perform the act/);
  assert.equal(humanChoice(resolutionText({ id: "c-w-1-1", actionHash: "h", by: "human", text, answeredAt: "t" })), "ask");
  const again = makeRequest({ ...base, id: "c-w-1-2", kind: "irreversible", followUpOf: "c-w-1-1", reply: "staging has no capture flag" });
  assert.deepEqual([again.followUpOf, again.reply], ["c-w-1-1", "staging has no capture flag"]);
  assert.match(decisionCard(again, { whyHuman: "x" }).join("\n"), /Follow-up to c-w-1-1 — worker's reply: staging has no capture flag/);
  assert.equal(JSON.parse(humanRequest(again, { whyHuman: "x" }).text).consult.followUpOf, "c-w-1-1");
});

test("an explicit human-class act with a complete intent is decidable WITHOUT the governor's rephrased question (the console saw only 'Give direction' when the packet had not landed)", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent: FULL });
  assert.deepEqual(decisionOptions("irreversible", { whyHuman: "x" }, req).map((o) => o.key), ["approve", "amend", "ask", "show", "reject"]);
  // control: with the act stated but the INTENT missing, still no Approve
  const noIntent = makeRequest({ id: "c-w-1-2", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" } });
  assert.deepEqual(decisionOptions("irreversible", { whyHuman: "x" }, noIntent).map((o) => o.key), ["intent", "reject"]);
});

// ── thread model: one consult, many exchanges, ONE act ─────────────────────────────────────────────────────────────
import { awaitingWorker, withTurn } from "./consult.ts";
test("a consult carries a thread: the human's question and the worker's reply append under the SAME id; the act never changes", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete the endpoint", action: { verb: "delete", target: "ep_1" }, intent: FULL });
  assert.equal(awaitingWorker(req), false);
  const asked = withTurn(req, { who: "human", text: "why prod and not staging?", at: "t1" });
  assert.equal(awaitingWorker(asked), true, "after the human asks, the worker owes a reply");
  assert.equal(asked.actionHash, req.actionHash, "the hash is the act, not the conversation");
  const replied = withTurn(asked, { who: "worker", text: "staging has no capture flag", at: "t2" });
  assert.equal(awaitingWorker(replied), false);
  assert.deepEqual(replied.thread.map((t) => t.who), ["human", "worker"]);
  const card = decisionCard(replied, { whyHuman: "x" }).join("\n");
  assert.match(card, /Thread\n\s+you\s+why prod and not staging\?\n\s+w\s+staging has no capture flag/);
  assert.equal(JSON.parse(humanRequest(replied, { whyHuman: "x" }).text).consult.thread.length, 2);
  // the resolution text for "ask" now tells the worker to CONTINUE the same consult, not to re-issue it
  const t = askFirstText(req, "why prod?");
  assert.match(t, /consult\(\{ re: "c-w-1-1", reply: "…" \}\)/); assert.match(t, /ACT must change.*followUpOf/);
});

// ── rehydration: a reloaded main rebuilds its open consults from the record, not from memory ──────────────────────
import { requestFromRecord } from "./consult.ts";
test("requestFromRecord rebuilds the same request (hash, class, thread, waiting) the record was written from", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete ep_1", action: { verb: "delete", target: "ep_1" }, intent: FULL, now: new Date("2026-09-14T10:00:00Z") });
  const asked = withTurn(req, { who: "human", text: "why?", at: "t1" });
  const record = { id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "delete ep_1", evidence: null, action: { verb: "delete", target: "ep_1" }, intent: FULL, thread: asked.thread, followUpOf: null, reply: null, askedAt: Date.parse("2026-09-14T10:00:00Z"), packet: { whyHuman: "x" } };
  const back = requestFromRecord(record);
  assert.equal(back.actionHash, req.actionHash);
  assert.equal(back.classification.class, req.classification.class);
  assert.equal(back.askedAt, req.askedAt);
  assert.equal(awaitingWorker(back), true);
});

test("main's assessment leads the card — risk · recommendation · why — before the governor's block and the choices", () => {
  const req = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "rm the trees", action: { verb: "rm", target: "wt-*" }, intent: FULL });
  const packet = { whyHuman: "x", recommendation: "approve", why: "governor says fine", assessment: { risk: "medium", recommendation: "approve, amended", why: "two of the five trees were touched by a live crew this hour", by: "main", at: "t" } };
  const card = decisionCard(req, packet).join("\n");
  const at = (s) => card.indexOf(s);
  assert.match(card, /▶ Main recommends: approve, amended {3}· risk MEDIUM\n {2}two of the five/);
  assert.ok(at("▶ Main recommends") < at("Choices:"), "right above the choices");
  assert.ok(at("Intent") < at("▶ Main recommends"), "the last thing before the buttons");
  assert.match(card, /\n\n\n▶ Main recommends[^\n]*\n[^\n]*\n[^\n]*\n\n\nChoices:/, "breathing room on both sides");
  assert.match(card, /▶ Main recommends[^\n]*\n[^\n]*\n {2}governor: Approve — governor says fine/, "the governor's line sits under main's, same block");
  assert.doesNotMatch(card.slice(at("Choices:")), /governor|recommends/i, "nothing advisory after the choices");
});

// ── operate vs ack: approval alone is not enough when Yong must act (Touch ID, a sign-in) ────────────────────────────
import { operationOf, humanResultRoute, operationDoneText } from "./consult.ts";
test("an act that names an op:// reference, or kind=auth, is an OPERATION: main performs it after the click; an rm is an ACK", () => {
  const rm = makeRequest({ id: "c-w-1-1", run: "r", worker: "w", kind: "irreversible", question: "rm the file", action: { verb: "rm", target: "/tmp/x" }, intent: FULL });
  assert.equal(operationOf(rm), undefined);
  const op = makeRequest({ id: "c-w-1-2", run: "r", worker: "w", kind: "irreversible", question: "call the API", action: { verb: "POST", target: "api.acme.example/organizations", detail: "with op://Employee/acme-staging/credential" }, intent: { ...FULL, exact: "curl -H \"Authorization: Bearer $(op read op://Employee/acme-staging/credential)\"" } });
  assert.deepEqual(operationOf(op), { type: "op", refs: ["op://Employee/acme-staging/credential"] }, "one ref, deduplicated across fields");
  const auth = makeRequest({ id: "c-w-1-3", run: "r", worker: "w", kind: "auth", question: "sign in to signin.acme-test.example", action: { verb: "sign in", target: "signin.acme-test.example" }, intent: FULL });
  assert.deepEqual(operationOf(auth), { type: "auth", refs: [] });
  // the wire carries it so the console can route without judging
  assert.deepEqual(JSON.parse(humanRequest(op, { whyHuman: "x" }).text).consult.operation, { type: "op", refs: ["op://Employee/acme-staging/credential"] });
  assert.equal(JSON.parse(humanRequest(rm, { whyHuman: "x" }).text).consult.operation, undefined);
});
test("routing: an approval of an OPERATION goes to main only (it must act first); everything else goes straight to the worker with main on cc", () => {
  const op = { worker: "w", operation: { type: "op", refs: ["op://a/b/c"] } };
  assert.deepEqual(humanResultRoute(op, "approve"), { to: ["main"], cc: [] });
  assert.deepEqual(humanResultRoute(op, "amend"), { to: ["main"], cc: [] });
  assert.deepEqual(humanResultRoute(op, "reject"), { to: ["w"], cc: ["main"] }, "a refusal needs no operation");
  assert.deepEqual(humanResultRoute(op, "ask"), { to: ["w"], cc: ["main"] });
  assert.deepEqual(humanResultRoute({ worker: "w" }, "approve"), { to: ["w"], cc: ["main"] }, "an ACK never detours");
});
test("the worker gets ONE result: approved + all set (where the credential is, how to use it) or approved + failed (do not proceed)", () => {
  const ok = operationDoneText("HUMAN: APPROVED by Yong: POST — api. Do exactly this.", { type: "op", refs: ["op://a/b/c"] }, { ok: true, files: { "op://a/b/c": "/runs/x/children/w/secrets/1" } });
  assert.match(ok, /^HUMAN: APPROVED by Yong: POST — api\. Do exactly this\.\nAll set — main obtained the permission\./);
  assert.match(ok, /op:\/\/a\/b\/c → \/runs\/x\/children\/w\/secrets\/1 \(use inline: "\$\(cat \/runs\/x\/children\/w\/secrets\/1\)"; never echo, print or paste it; the file is removed when you report\)/);
  const bad = operationDoneText("HUMAN: APPROVED by Yong: POST — api.", { type: "op", refs: ["op://a/b/c"] }, { ok: false, error: "user cancelled" });
  assert.match(bad, /^HUMAN: APPROVED by Yong: POST — api\.\nBUT the operation FAILED \(user cancelled\)/); assert.match(bad, /Do NOT proceed/);
  const auth = operationDoneText("HUMAN: I'll do it", { type: "auth", refs: [] }, { ok: true });
  assert.match(auth, /All set — main obtained the permission\. The browser identity is signed in; continue with the same session\./);
});

test("replay: a re-sent consult that is already settled gets the recorded answer again, in the worker's wire format; open ⇒ nothing", () => {
  assert.equal(replayText({ id: "c-w-1-1", state: "answered", answeredBy: "human:console", answer: "APPROVED by Yong: go" }), "HUMAN: APPROVED by Yong: go");
  assert.equal(replayText({ id: "c-w-1-1", state: "answered", answeredBy: "governor", answer: "proceed" }), "GOVERNOR: proceed");
  assert.match(replayText({ id: "c-w-1-1", state: "withdrawn", answeredBy: "withdrawn:worker gone", answer: "worker gone" }), /^SYSTEM: consult c-w-1-1 was withdrawn \(worker gone\)\. Do NOT proceed/);
  assert.equal(replayText({ id: "c-w-1-1", state: "open", answeredBy: null, answer: null }), undefined);
});

test("decisionOptions: a human-tier consult with NO explicit act still offers 'Give direction' — Yong states the act in his own words (c-reviewer-193-1, 2026-09-14)", () => {
  const req = makeRequest({ worker: "reviewer", kind: "irreversible", question: "My brief requires local POST/act probes and npm test; constitution requires authorization for create/start/submit. May I carry out test-owned local mutations?", evidence: [] });
  assert.equal(req.actionExplicit, false, "fixture: the worker did not submit verb+target");
  const keys = decisionOptions(req.classification.class, undefined, req).map((o) => o.key);
  assert.ok(keys.includes("answer"), `expected 'answer' among ${keys}`);
  assert.ok(keys.includes("show") && keys.includes("reject"), "the two existing exits stay");
  assert.equal(keys.indexOf("answer"), 0, "direction is the first choice: it is what a human who has read the question usually wants");
});
