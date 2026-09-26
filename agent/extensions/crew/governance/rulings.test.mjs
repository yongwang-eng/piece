/**
 * D58 read-before-rule. Both 2026-09-11 collisions reconstructed: main ruled while the same question sat OPEN with Yong.
 * The property that matters is that an OPEN consult is reported first and sets `blocked` — an answered-only search
 * (what main actually did before ruling on item 5) finds nothing and reads as "safe to rule".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { selectRulings } from "./rulings.ts";

const runDir = () => {
  const d = mkdtempSync(`${tmpdir()}/crew-rulings-`);
  mkdirSync(`${d}/children/implementer`, { recursive: true });
  return d;
};
const consults = (d, rows) => writeFileSync(`${d}/children/implementer/consults.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const ASKED = { id: "c-implementer-29-11", worker: "implementer", kind: "clarify", at: "2026-09-11T15:40:00Z", question: "Item5 board row: propose dim row below workers, 'not started' until first consult, counters count all toHuman." };
const ANSWERED = { ...ASKED, answer: "APPROVED by Yong: … Do exactly this and nothing beyond it.", answeredBy: "human" };

test("an OPEN consult on the topic blocks and is reported FIRST — the item 5 collision", () => {
  const d = runDir();
  consults(d, [ASKED]);
  const r = selectRulings(d, "board row counters");
  assert.equal(r.blocked, true, "an open consult means the topic is not main's to rule");
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].id, "c-implementer-29-11");
  assert.match(r.text.split("\n")[0], /OPEN consult/, "the warning is the first line, not buried under history");
  assert.match(r.text, /NOT yours to rule/);
});

test("answered-only searching is what failed: the same record with the answer present does NOT block, and the human answer is marked as governing", () => {
  const d = runDir();
  consults(d, [ANSWERED]);
  const r = selectRulings(d, "board row counters");
  assert.equal(r.blocked, false, "once answered, the topic is settled — not blocked, but governed");
  assert.equal(r.human.length, 1);
  assert.match(r.text, /HUMAN answers \(these GOVERN/);
  assert.match(r.text, /supersedes an earlier one and any main ruling/, "states the precedence that resolved items 4 and 5");
});

test("a clean topic says so explicitly — the tool must be usable as a green light, not only a red one", () => {
  const d = runDir();
  consults(d, [ANSWERED]);
  const r = selectRulings(d, "merge freshness");
  assert.equal(r.blocked, false);
  assert.equal(r.open.length + r.human.length, 0);
  assert.match(r.text, /Safe to rule/);
});

test("governor answers and plan.md rulings are surfaced but never block", () => {
  const d = runDir();
  consults(d, [{ id: "c-r-1", worker: "reviewer", kind: "clarify", at: "t", question: "board row placement?", answer: "clarify: last row", answeredBy: "governor" }]);
  const r = selectRulings(d, "board row", "- 2026-09-11 · **ruling** · main — board row placement is last\n- unrelated line\n");
  assert.equal(r.blocked, false);
  assert.equal(r.gov.length, 1);
  assert.equal(r.rulings.length, 1, "only the ruling line matching the topic");
  assert.match(r.text, /recorded rulings/);
});

test("topic matching ignores short words and is case-insensitive; no topic returns everything", () => {
  const d = runDir();
  consults(d, [ASKED]);
  assert.equal(selectRulings(d, "BOARD").open.length, 1, "case-insensitive");
  assert.equal(selectRulings(d, "of to is a").open.length, 1, "words ≤3 chars are not selective — treated as no topic");
  assert.equal(selectRulings(d, "").open.length, 1, "no topic = everything");
  assert.equal(selectRulings(d, "kubernetes").open.length, 0, "a genuine miss is a miss");
});

test("a malformed line never hides a real open consult", () => {
  const d = runDir();
  writeFileSync(`${d}/children/implementer/consults.jsonl`, `{"broken\n${JSON.stringify(ASKED)}\n\n`);
  const r = selectRulings(d, "board");
  assert.equal(r.open.length, 1, "skip the bad line, keep reading");
});
