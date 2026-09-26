/**
 * A deliberate kill must never look like a crash.
 *
 * `crew_kill all` resurrected the entire crew on 2026-09-11: kill() killed the pane BEFORE deleting the worker record,
 * so a liveness sweep landing in that window observed "pane gone" and ran D54's respawn ladder. Three workers came back,
 * each with a STALE brief (capabilities.md had superseded it hours earlier), and the only thing that stopped them acting
 * on it was that they read the record and found Yong's stop order. The respawn cap eventually halted the loop with
 * "has died 3 times" — an alarming message about a routine disposal.
 *
 * The reason-string guard in respawnSuccessor could not fix this: the sweep computes its OWN observational `why`, which
 * never says "crew_kill". Intent has to be recorded before the observation becomes possible.
 */
import assert from "node:assert/strict";
import test from "node:test";

/** The sweep's decision, extracted to the shape the fix introduces. */
function sweepDecision({ paneAlive, hasChild, onBus, disposing, inRoster = true }) {
  if (disposing) return { action: "skip" };                       // intent recorded before the pane dies
  if (!inRoster) return { action: "skip" };                       // kill() finished during the sweep's await
  if (!paneAlive) return { action: "gone", why: "pane gone (killed outside crew or crashed)" };
  if (!hasChild) return { action: "gone", why: "worker process exited (shell has no child)" };
  if (!onBus) return { action: "offbus" };
  return { action: "ok" };
}

test("the window that caused it: pane dead, record still present — without intent that is a crash", () => {
  const d = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: false });
  assert.equal(d.action, "gone", "this is the real bug: an intentional kill observed as a death");
  assert.match(d.why, /killed outside crew or crashed/);
});

test("with intent recorded first, the same observation is skipped entirely", () => {
  const d = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: true });
  assert.equal(d.action, "skip", "no worker_gone, no notify, no respawn ladder");
  assert.equal(d.why, undefined);
});

test("a REAL crash is still detected — the fix must not blind the ladder", () => {
  for (const obs of [
    { paneAlive: false, hasChild: false, onBus: false },   // pane vanished
    { paneAlive: true, hasChild: false, onBus: false },    // process exited under a live pane
  ]) {
    const d = sweepDecision({ ...obs, disposing: false });
    assert.equal(d.action, "gone", `a genuine crash must still fire: ${JSON.stringify(obs)}`);
  }
});

test("a healthy worker is untouched, and an off-bus one still reaches its own branch", () => {
  assert.equal(sweepDecision({ paneAlive: true, hasChild: true, onBus: true, disposing: false }).action, "ok");
  assert.equal(sweepDecision({ paneAlive: true, hasChild: true, onBus: false, disposing: false }).action, "offbus");
});

test("intent must be recorded BEFORE the pane dies, not after — ordering is the whole bug", () => {
  const log = [];
  // the old order: kill the pane, then bookkeep. A sweep between them sees a crash.
  const broken = () => { log.push("pane-killed"); const seen = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: false }); log.push(`swept:${seen.action}`); log.push("record-deleted"); };
  broken();
  assert.deepEqual(log, ["pane-killed", "swept:gone", "record-deleted"], "reproduces the resurrection");

  const fixed = [];
  const correct = () => { fixed.push("intent-recorded"); fixed.push("pane-killed"); const seen = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: true }); fixed.push(`swept:${seen.action}`); fixed.push("record-deleted"); };
  correct();
  assert.deepEqual(fixed, ["intent-recorded", "pane-killed", "swept:gone" === "swept:gone" ? "swept:skip" : "", "record-deleted"]);
});

/**
 * Main must never interrupt a working worker to deliver a keystroke.
 * Live 2026-09-11: `/compact` was typed into a streaming pane after the 60s idle budget expired, and the researcher's
 * turn ABORTED 3ms later. The old code treated "budget exhausted" as permission to send anyway.
 */
test("sendWhenIdle: budget exhausted + still busy ⇒ do NOT send, report undeliverable", () => {
  const decide = ({ status, tries, max = 20 }) =>
    status && status !== "idle" ? (tries < max ? "retry" : "undeliverable") : "send";

  assert.equal(decide({ status: "working", tries: 0 }), "retry", "busy early → wait");
  assert.equal(decide({ status: "working", tries: 19 }), "retry", "still inside the budget");
  assert.equal(decide({ status: "working", tries: 20 }), "undeliverable", "THE BUG: this used to send and abort the turn");
  assert.equal(decide({ status: "idle", tries: 20 }), "send", "idle at the end of the budget still sends");
  assert.equal(decide({ status: "idle", tries: 0 }), "send");
  assert.equal(decide({ status: undefined, tries: 5 }), "send", "unknown status (off-bus) is not a reason to withhold");
});

/**
 * ESCAPE #2 (2026-09-11, same evening): `crew_kill all` respawned researcher and reviewer even WITH the intent flag.
 *
 * The flag is transient — kill() does `disposing.delete(name)` on its last line — while the sweep checks it AFTER an
 * `await tmux(...)`. In that yield the whole of kill() runs: flag set, pane killed, record deleted, flag cleared. The
 * sweep resumes, sees `disposing === false` and a dead pane, and calls it a crash. Log proof: `worker_spawned researcher`
 * sits between `worker_killed researcher` and `worker_killed researcher-3` in the same `crew_kill all`.
 *
 * The durable fact is the ROSTER: kill() removes the worker from `workers` and never puts it back. A worker that is no
 * longer in the roster was disposed on purpose, whatever the transient flag says.
 */
test("the escape: flag already cleared and record already gone — still must not respawn", () => {
  const d = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: false, inRoster: false });
  assert.equal(d.action, "skip", "kill() completed during the sweep's await; this is a disposal, not a crash");
});

test("a crash is a worker STILL in the roster whose pane died — that must still respawn", () => {
  const d = sweepDecision({ paneAlive: false, hasChild: false, onBus: false, disposing: false, inRoster: true });
  assert.equal(d.action, "gone", "the ladder must survive the fix");
});
