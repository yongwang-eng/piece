import { test } from "node:test";
import assert from "node:assert/strict";
import { next, aggregate, glyph, STALE_MS, TOMBSTONE_MS, parseDot, encodeDot } from "./state.ts";

const t0 = 1_000_000;

test("working → touch keeps working and refreshes ts", () => {
  const a = next(undefined, { type: "working" }, t0);
  assert.equal(a.state, "working");
  const b = next(a, { type: "touch" }, t0 + 5_000);
  assert.equal(b.state, "working"); assert.equal(b.ts, t0 + 5_000);
});

test("done: seen → idle, unseen → unread; both leave a tombstone a trailing touch respects", () => {
  const w = next(undefined, { type: "working" }, t0);
  const seen = next(w, { type: "done", seen: true }, t0 + 1);
  assert.equal(seen.state, "idle");
  const unseen = next(w, { type: "done", seen: false }, t0 + 1);
  assert.equal(unseen.state, "unread");
  assert.equal(next(unseen, { type: "touch" }, t0 + 1 + TOMBSTONE_MS - 1).state, "unread", "trailing tool end cannot resurrect a settled turn");
  assert.equal(next(unseen, { type: "touch" }, t0 + 1 + TOMBSTONE_MS + 1).state, "working", "a touch long after the stop is a real turn");
  assert.equal(next(unseen, { type: "working" }, t0 + 2).state, "working", "a new turn always wins");
});

test("read (looking at the window) clears unread AND blocked; working is left alone", () => {
  assert.equal(next({ state: "unread", ts: t0 }, { type: "read" }, t0).state, "idle");
  assert.equal(next({ state: "working", ts: t0 }, { type: "read" }, t0).state, "working");
  assert.equal(next({ state: "blocked", ts: t0, prev: "idle" }, { type: "read" }, t0).state, "idle");
  assert.equal(next({ state: "blocked", ts: t0, prev: "unread", stopTs: t0 }, { type: "read" }, t0).state, "idle", "looking reads the unread underneath too");
  assert.equal(next({ state: "blocked", ts: t0, prev: "working" }, { type: "read" }, t0).state, "working", "a turn still in flight stays green");
});

test("blocked while the window is being looked at raises nothing; unseen raises red", () => {
  const idle = { state: "idle", ts: t0 };
  assert.equal(next(idle, { type: "blocked", reason: "q", seen: true }, t0), idle);
  assert.equal(next(idle, { type: "blocked", reason: "q", seen: false }, t0).state, "blocked");
  assert.equal(next(idle, { type: "blocked", reason: "q" }, t0).state, "blocked", "seen unknown → red (apply fills it)");
});

test("blocked outranks and remembers what it interrupted; unblocked RESTORES it (never assumes working)", () => {
  const idle = { state: "idle", ts: t0 };
  const b = next(idle, { type: "blocked", reason: "crew: stalled" }, t0 + 1);
  assert.equal(b.state, "blocked"); assert.equal(b.reason, "crew: stalled");
  assert.equal(next(b, { type: "unblocked" }, t0 + 2).state, "idle", "the phantom-green bug");
  const w = next({ state: "working", ts: t0 }, { type: "blocked" }, t0 + 1);
  assert.equal(next(w, { type: "unblocked" }, t0 + 2).state, "working");
  assert.equal(next({ state: "idle", ts: t0 }, { type: "unblocked" }, t0).state, "idle", "unblocked when not blocked is a no-op");
  // a turn that ends while blocked settles the pane: the block belonged to the turn
  assert.equal(next(w, { type: "done", seen: false }, t0 + 3).state, "unread");
});

test("end removes the pane", () => {
  assert.equal(next({ state: "working", ts: t0 }, { type: "end" }, t0), undefined);
});

test("option encoding round-trips and tolerates garbage", () => {
  const s = { state: "blocked", ts: t0, prev: "working", reason: "auth" };
  assert.deepEqual(parseDot(encodeDot(s)), s);
  assert.equal(parseDot(""), undefined); assert.equal(parseDot("not json"), undefined); assert.equal(parseDot('{"state":"nope"}'), undefined);
});

test("aggregate: rank blocked > working > unread per window; stale working demotes; a shell-wrapped pi is NOT a dead agent", () => {
  const panes = [
    { paneId: "%1", windowId: "@1", dot: { state: "working", ts: t0 }, command: "node" },
    { paneId: "%2", windowId: "@1", dot: { state: "unread", ts: t0 }, command: "node" },
    { paneId: "%3", windowId: "@2", dot: { state: "unread", ts: t0 }, command: "node" },
    { paneId: "%4", windowId: "@2", dot: { state: "blocked", ts: t0, prev: "idle" }, command: "node" },
    { paneId: "%5", windowId: "@3", dot: { state: "working", ts: t0 - STALE_MS - 1 }, command: "node" },
    { paneId: "%6", windowId: "@4", dot: { state: "working", ts: t0 }, command: "zsh" },
    { paneId: "%7", windowId: "@5", dot: undefined, command: "zsh" },
    { paneId: "%8", windowId: "@6", dot: { state: "blocked", ts: t0 - STALE_MS * 10, prev: "idle" }, command: "node" },
  ];
  const r = aggregate(panes, t0);
  assert.deepEqual(r.windows, { "@1": "working", "@2": "blocked", "@3": "unread", "@4": "working", "@5": undefined, "@6": "blocked" });
  assert.deepEqual(r.rewrite, [["%5", { state: "unread", ts: t0 - STALE_MS - 1, stopTs: t0 }]], "stale → unread is persisted so `read` can clear it; pane_current_command never decides");
});

test("glyph: two frames for the animated states, one for unread, empty for none", () => {
  assert.notEqual(glyph("working", 0), glyph("working", 1));
  assert.equal(glyph("blocked", 0), glyph("blocked", 1));       // solid: a pulsing red drew the eye without saying more
  assert.equal(glyph("unread", 0), glyph("unread", 1));
  assert.equal(glyph(undefined, 0), "");
  assert.match(glyph("blocked", 0), /◆$/);                        // the one different shape: red AND a diamond = needs you
  for (const st of ["working", "unread"]) for (const f of [0, 1]) assert.match(glyph(st, f), /●$/, `${st}/${f}`);
});
