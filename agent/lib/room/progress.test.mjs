import { test } from "node:test";
import assert from "node:assert";
import { parseMilestone, milestoneDetail, progressTrail, coalesceFindings, PROGRESS_TASK, SHARE_MIN_MS } from "./progress.ts";

test("parseMilestone: bounded fields, junk rejected, evidence kept as strings", () => {
  const m = parseMilestone(JSON.stringify({ phase: "reviewing diff", finding: "the retry path swallows ETIMEDOUT", next: "check the caller", evidence: ["src/x.ts:41"], share: true, at: "2026-09-17T20:00:00Z" }));
  assert.deepEqual(m, { phase: "reviewing diff", finding: "the retry path swallows ETIMEDOUT", next: "check the caller", evidence: ["src/x.ts:41"], share: true, at: "2026-09-17T20:00:00Z" });
  assert.equal(parseMilestone("not json"), undefined);
  assert.equal(parseMilestone(JSON.stringify({ finding: "no phase" })), undefined, "phase is the one required field");
  assert.equal(parseMilestone(JSON.stringify({ phase: "x".repeat(500) })).phase.length, 80, "phase is cut, not refused");
  assert.equal(parseMilestone(JSON.stringify({ phase: "p", evidence: [1, "ok", null] })).evidence.length, 1);
  assert.equal(parseMilestone(JSON.stringify({ phase: "p", share: "yes" })).share, false, "share is a boolean or false");
});

test("milestoneDetail: the worker's phase leads, the observed activity follows — two channels, one row", () => {
  const m = { phase: "reviewing diff · 3/6 files", at: "" };
  assert.equal(milestoneDetail(m, "bash"), "reviewing diff · 3/6 files · bash");
  assert.equal(milestoneDetail(m, "thinking"), "reviewing diff · 3/6 files · thinking");
  assert.equal(milestoneDetail(m, "idle"), "reviewing diff · 3/6 files · idle");
  assert.equal(milestoneDetail(m, "reviewing diff · 3/6 files"), "reviewing diff · 3/6 files", "no stutter when observed already says it");
});

test("progressTrail: milestones from the run log, per worker, in order; other notices ignored", () => {
  const lines = [
    { seq: 1, type: "message", kind: "notice", from: "reviewer", to: ["main"], task: PROGRESS_TASK, at: "2026-09-17T20:00:00Z", text: JSON.stringify({ phase: "reading PR" }) },
    { seq: 2, type: "message", kind: "notice", from: "reviewer", to: ["main"], task: "vitals", at: "2026-09-17T20:00:01Z", text: "{\"contextPct\":3}" },
    { seq: 3, type: "message", kind: "notice", from: "implementer", to: ["main"], task: PROGRESS_TASK, at: "2026-09-17T20:00:02Z", text: JSON.stringify({ phase: "writing test", next: "run it red" }) },
    { seq: 4, type: "message", kind: "notice", from: "reviewer", to: ["main"], task: PROGRESS_TASK, at: "2026-09-17T20:01:00Z", text: JSON.stringify({ phase: "reviewing diff", finding: "retry swallows ETIMEDOUT", evidence: ["src/x.ts:41"] }) },
    { seq: 5, type: "message", kind: "notice", from: "reviewer", to: ["main"], task: PROGRESS_TASK, at: "2026-09-17T20:02:00Z", text: "garbage" },
  ];
  const all = progressTrail(lines);
  assert.deepEqual(all.map((m) => [m.worker, m.phase]), [["reviewer", "reading PR"], ["implementer", "writing test"], ["reviewer", "reviewing diff"]]);
  assert.equal(all[2].at, "2026-09-17T20:01:00Z", "the log's timestamp wins over anything the worker wrote");
  assert.deepEqual(progressTrail(lines, "implementer").map((m) => m.next), ["run it red"]);
});

test("coalesceFindings: one message, latest finding per worker, evidence and next carried", () => {
  const pending = new Map([
    ["reviewer", { worker: "reviewer", at: "2026-09-17T20:01:00Z", phase: "reviewing diff", finding: "retry swallows ETIMEDOUT", evidence: ["src/x.ts:41"], next: "check callers" }],
    ["implementer", { worker: "implementer", at: "2026-09-17T20:01:30Z", phase: "writing test", finding: "the fixture already covers the case", next: "delete my copy" }],
  ]);
  const text = coalesceFindings(pending);
  assert.match(text, /^\[crew progress · 2 findings\]/);
  assert.match(text, /reviewer · reviewing diff\n  found: retry swallows ETIMEDOUT\n  evidence: src\/x\.ts:41\n  next: check callers/);
  assert.match(text, /implementer · writing test\n  found: the fixture already covers the case\n  next: delete my copy/);
  assert.match(text, /FYI from workers.*not a request.*no reply is owed/i);
  assert.ok(SHARE_MIN_MS >= 30_000, "a worker cannot wake main more than once a minute");
});
