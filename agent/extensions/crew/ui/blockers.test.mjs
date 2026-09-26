import { test } from "node:test";
import assert from "node:assert/strict";
import { replayWaits } from "./blockers.ts";

const t0 = 1_000_000;
const at = (s) => new Date(t0 + s * 1000).toISOString();
const msg = (seq, kind, from, to, extra = {}) => JSON.stringify({ type: "message", run: "r", id: `${from}-${seq}`, seq, kind, from, to, at: at(seq), text: `${kind} ${seq} body text that is long enough to be cut`, ...extra });
const evt = (seq, member) => JSON.stringify({ type: "event", run: "r", kind: "member_joined", member, seq, details: { backend: "crew" } });

test("a query to a peer with no reply = waiting on that peer, since the query", () => {
  const text = [evt(1, "implementer"), evt(2, "reviewer"), msg(3, "query", "implementer", ["reviewer"])].join("\n");
  const waits = replayWaits(text, "r", t0 + 60_000);
  assert.deepEqual(waits.get("implementer"), { on: "reviewer", why: "query #3 · query 3 body text that is long enough t…", sinceMs: 57_000 });
  assert.equal(waits.get("reviewer"), undefined, "the addressee owes, it is not waiting");
});

test("a reply by `re` (id or seq) or any later directed message from the addressee clears the wait", () => {
  const byId = [evt(1, "a"), evt(2, "b"), msg(3, "query", "a", ["b"]), msg(4, "propose", "b", ["a"], { re: "a-3" })].join("\n");
  assert.equal(replayWaits(byId, "r", t0 + 9e5).get("a"), undefined);
  const bySeq = [evt(1, "a"), evt(2, "b"), msg(3, "request", "a", ["b"]), msg(4, "result", "b", ["a"], { re: 3 })].join("\n");
  assert.equal(replayWaits(bySeq, "r", t0 + 9e5).get("a"), undefined);
  const directed = [evt(1, "a"), evt(2, "b"), msg(3, "query", "a", ["b"]), msg(4, "inform", "b", ["a"])].join("\n");
  assert.equal(replayWaits(directed, "r", t0 + 9e5).get("a"), undefined);
  const unrelated = [evt(1, "a"), evt(2, "b"), evt(3, "c"), msg(4, "query", "a", ["b"]), msg(5, "inform", "b", ["c"])].join("\n");
  assert.equal(replayWaits(unrelated, "r", t0 + 9e5).get("a")?.on, "b", "b talking to c does not answer a");
});

test("a query to main is waiting on main; broadcasts and multi-addressee messages never create a wait", () => {
  const text = [evt(1, "a"), evt(2, "b"), msg(3, "query", "a", ["main"]), msg(4, "notice", "b", ["*"]), msg(5, "inform", "b", ["a", "main"])].join("\n");
  const waits = replayWaits(text, "r", t0 + 9e5);
  assert.equal(waits.get("a").on, "main");
  assert.equal(waits.get("b"), undefined);
});

test("only the LATEST outbound ask counts: a newer result to main after an old unanswered query = done, not waiting", () => {
  const text = [evt(1, "a"), evt(2, "b"), msg(3, "query", "a", ["b"]), msg(9, "result", "a", ["main"])].join("\n");
  const waits = replayWaits(text, "r", t0 + 9e5);
  assert.deepEqual(waits.get("a"), { on: undefined, why: "reported ✓", sinceMs: 891_000, done: true });
});

test("main steering a worker after its report re-opens it (no longer done)", () => {
  const text = [evt(1, "a"), msg(3, "result", "a", ["main"]), msg(4, "request", "main", ["a"])].join("\n");
  assert.equal(replayWaits(text, "r", t0 + 9e5).get("a"), undefined);
});

test("other runs and malformed lines are ignored", () => {
  const text = [evt(1, "a"), JSON.stringify({ type: "message", run: "other", kind: "query", from: "a", to: ["b"], id: "x", seq: 2, at: at(2) }), "{not json", msg(3, "query", "a", ["b"])].join("\n");
  const waits = replayWaits(text, "r", t0 + 9e5);
  assert.equal(waits.get("a").why.startsWith("query #3"), true);
});
