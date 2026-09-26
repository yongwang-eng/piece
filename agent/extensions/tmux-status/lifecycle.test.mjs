import assert from "node:assert/strict";
import { EVENT_TO_STATUS, settle } from "./lifecycle.ts";
import { next } from "../../lib/tmux-dot/state.ts";

assert.deepEqual(EVENT_TO_STATUS, {
  agent_start: "working",
  tool_execution_end: "touch",
  agent_settled: "done",
  session_shutdown: "end",
});

// a plain turn settles once; a turn owing Yong settles done → blocked, and the dot ends BLOCKED with the reason
assert.deepEqual(settle(true), [{ type: "done", seen: true }]);
const t0 = 1_000;
let dot = { state: "working", ts: t0 };
for (const ev of settle(false, "waiting on you: pick 1–4")) dot = next(dot, ev, t0 + 1);
assert.equal(dot.state, "blocked"); assert.equal(dot.reason, "waiting on you: pick 1–4"); assert.equal(dot.prev, "unread");
// looking at the window acknowledges the owed answer (Yong 2026-09-19); so does the next prompt
assert.equal(next(dot, { type: "read" }, t0 + 2).state, "idle");
assert.equal(next(dot, { type: "working" }, t0 + 3).state, "working");
// a turn that ends owing an answer while Yong is already looking raises nothing: settle carries seen to both events
let seenDot = { state: "working", ts: t0 };
for (const ev of settle(true, "waiting on you")) seenDot = next(seenDot, ev, t0 + 1);
assert.equal(seenDot.state, "idle");

console.log("pi tmux lifecycle mapping + settle: PASS");

// waiting_on_you carries ONE ask and its options; the card is what Yong reads instead of the prose above it
import { owedCard, owedProblem } from "./lifecycle.ts";
assert.equal(owedProblem({ reason: "PR 2 ownership 1/2/3 · ticket · scope · note y/n" }), "one ask per call — split on ' · ' found; ask the first now and drop or re-ask the rest later");
assert.equal(owedProblem({ reason: "pick 1–3", options: ["a"] }), "options need 2–4 entries, each 'label — consequence'");
assert.equal(owedProblem({ reason: "pick 1–3", options: ["a", "b"], pick: 3 }), "pick must index an option (1-based)");
assert.equal(owedProblem({ reason: "pick 1–3", options: ["a — x", "b — y", "c — z"], pick: 1 }), undefined);
assert.equal(owedProblem({ reason: "approve Alex ping" }), undefined);          // a yes/no needs no options
const card = owedCard({ reason: "PR 2 ownership", options: ["Yong — he wrote the migration", "Colin — his adopter stack", "ask Alex"], pick: 1 });
assert.deepEqual(card, [
  "◆ WAITING ON YOU — PR 2 ownership",
  "  1 ⭐ Yong — he wrote the migration",
  "  2    Colin — his adopter stack",
  "  3    ask Alex",
  "  type a number, or a different opinion",
]);
assert.deepEqual(owedCard({ reason: "approve Alex ping" }), ["◆ WAITING ON YOU — approve Alex ping", "  yes / no, or a different opinion"]);
console.log("waiting_on_you card + guard: PASS");
