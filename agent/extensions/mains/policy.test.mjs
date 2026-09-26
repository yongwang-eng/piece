import assert from "node:assert/strict";
import test from "node:test";
import { mainName, isMainName, parseControl, planReload, senderIsLive, laneText, MAINS_RUN } from "./policy.ts";

test("a main's name is derived from the process, never chosen: main@<cwd>#<pid>", () => {
  assert.equal(mainName("/Users/me/notes/projects/proj pi", 4242), "main@proj_pi#4242");
  assert.ok(isMainName("main@x#1")); assert.ok(!isMainName("reviewer")); assert.ok(!isMainName("human"));
  assert.equal(MAINS_RUN, "mains");
});

test("controls parse strictly; anything else is not a control", () => {
  assert.deepEqual(parseControl('{"cmd":"reload","scope":"extensions","reason":"crew ext changed"}'), { cmd: "reload", scope: "extensions", reason: "crew ext changed" });
  assert.deepEqual(parseControl('{"cmd":"reload","scope":"prompt"}'), { cmd: "reload", scope: "prompt", reason: undefined });
  assert.equal(parseControl('{"cmd":"reload","scope":"everything"}'), undefined);
  assert.equal(parseControl('{"cmd":"rm -rf"}'), undefined);
  assert.equal(parseControl("not json"), undefined);
});

test("reload policy: a session is never reloaded by another session — every scope only asks; own echo ignored", () => {
  const self = "main@a#1", from = "main@b#2";
  assert.deepEqual(planReload({ scope: "extensions", from, self }), { act: "ask-owner" });
  assert.deepEqual(planReload({ scope: "prompt", from, self }), { act: "ask-owner" });
  assert.deepEqual(planReload({ scope: "extensions", from: self, self }), { act: "ignore", why: "own echo" });
});

test("spoof guard: the sender must be a live main client of the room right now", () => {
  const live = ["main@a#1", "main@b#2", "human"];
  assert.ok(senderIsLive("main@b#2", live));
  assert.ok(!senderIsLive("main@c#3", live), "a name nobody holds");
  assert.ok(!senderIsLive("human", live), "the console seat is a listener, not a controller");
  assert.ok(!senderIsLive("reviewer", live), "a worker name can never pass, even if one were connected");
});

test("lane text names the room and the asking main, tells the owner what to do; never crew wording", () => {
  const t = laneText("main@b#2", { cmd: "reload", scope: "prompt" }, { act: "ask-owner" });
  assert.match(t, /^mains · b#2 asks you to \/reload \(prompt scope\)/); assert.doesNotMatch(t, /crew|worker/);
  assert.match(laneText("main@b#2", { cmd: "reload", scope: "extensions", reason: "crew ext changed" }, { act: "ask-owner" }), /asks you to \/reload — crew ext changed$/);
});
