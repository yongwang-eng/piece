import assert from "node:assert/strict";
import { buildTrail, formatSilence, parseSteps, tail, wrapTail } from "./ticker.ts";

assert.equal(tail("First point. Second point.  Third\npoint here"), "Second point. Third point here");
assert.equal(tail("a. b. c. d.", 1), "d.");

assert.deepEqual(wrapTail("short", 40, 2), ["short"]);
assert.deepEqual(wrapTail("", 40, 2), []);
assert.deepEqual(wrapTail("supercalifragilistic", 8, 1), ["superca…"]);
assert.deepEqual(wrapTail("the quick brown fox jumps", 10, 2), ["…rown fox", "jumps"]);

assert.equal(formatSilence(14_900), "(no reasoning stream for 14s — model is thinking silently)");

const buf = "**Planning tree**\nfirst body. more.\n\n**Evaluating groups**\n\n**Analyzing outcomes**\nleft pan heavier means 5.";
const steps = parseSteps(buf);
assert.deepEqual(steps.map((s) => s.title), ["Planning tree", "Evaluating groups", "Analyzing outcomes"]);
assert.equal(steps[2].body, "left pan heavier means 5.");

const trail = buildTrail(steps, [0, 9_000, 15_000], 20_000, 80, 4, 20_000, 10_000);
assert.deepEqual(trail.map((l) => l.text), [
  "▸ Planning tree · 9s",
  "▸ Evaluating groups · 6s",
  "● Analyzing outcomes",
  "  …left pan heavier means 5.",
]);

// raw thinking without headlines → sentence tail
const raw = buildTrail(parseSteps("I should check the schema. Then compare ids."), [0], 5_000, 80, 4, 5_000, 10_000);
assert.deepEqual(raw.map((l) => l.kind), ["tail"]);

// silence appended and clipped to maxLines
const quiet = buildTrail(steps, [0, 9_000, 15_000], 40_000, 80, 3, 20_000, 10_000);
assert.equal(quiet.at(-1).kind, "silence");
assert.equal(quiet.length, 3);


// sub-2s gaps between headline arrivals are flush artifacts → no duration shown
const gapSteps = parseSteps("**A**\n\n**B**\n\n**C**");
const gapTrail = buildTrail(gapSteps, [0, 500, 20_000], 25_000, 80, 4, 25_000, 10_000).map((l) => l.text);
assert.deepEqual(gapTrail, ["▸ A", "▸ B · 20s", "● C"]);

console.log("thought-ticker: PASS");
import { paintsAnswer } from "./ticker.ts";
assert.equal(paintsAnswer("waiting_on_you"), true);
assert.equal(paintsAnswer("bash"), false);
console.log("paintsAnswer: PASS");
