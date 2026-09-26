import test from "node:test";
import assert from "node:assert/strict";
const { resolveLimit, idleCompactDue, idleClock } = await import("./trigger.ts");

test("threshold: absolute tokens, percentage of window, and the maxFraction cap", () => {
  const window = 1_000_000;
  // absolute (the default policy: cost is denominated in tokens, not window-fraction)
  assert.equal(resolveLimit({ at: 200_000, maxFraction: 0.75 }, window), 200_000);
  // percentage string → fraction of the window
  assert.equal(resolveLimit({ at: "20%", maxFraction: 0.75 }, window), 200_000);
  assert.equal(resolveLimit({ at: "12.5%", maxFraction: 0.75 }, 200_000), 25_000);
  // maxFraction caps BOTH forms — a typo can never ride to the overflow edge
  assert.equal(resolveLimit({ at: 900_000, maxFraction: 0.75 }, window), 750_000);
  assert.equal(resolveLimit({ at: "90%", maxFraction: 0.75 }, window), 750_000);
  // small-window model: absolute default larger than the window → the cap binds
  assert.equal(resolveLimit({ at: 200_000, maxFraction: 0.75 }, 128_000), 96_000);
});

test("threshold: session override wins, junk strings fall back to the default", () => {
  assert.equal(resolveLimit({ at: 200_000, maxFraction: 0.75 }, 1_000_000, 150_000), 150_000);
  assert.equal(resolveLimit({ at: "garbage", maxFraction: 0.75 }, 1_000_000), 200_000);
  assert.equal(resolveLimit({ at: "%", maxFraction: 0.75 }, 1_000_000), 200_000);
  assert.equal(resolveLimit({ at: -5, maxFraction: 0.75 }, 1_000_000), 200_000);
});

// A quiet session with a big ledger will pay a full cache write when it wakes, and that write is
// proportional to what the ledger held. Compacting while the cache is STILL WARM moves the same
// compaction to where it costs ~$0.29 instead of ~$2.40. The window is measured, not chosen:
// cache hits are 100% out to 300s and fall off a cliff after (270-300s bucket: 14/14 hits).
test('idle compaction fires only inside the warm window, above the size that pays for it', () => {
  const base = { tokens: 160_000, state: 'idle', after: 270_000, ttl: 300_000, minTokens: 150_000 };
  const due = (o) => idleCompactDue({ ...base, ...o });

  assert.equal(due({ idleMs: 280_000 }), true, 'quiet 4.7min, 160k, warm → compact now');
  assert.equal(due({ idleMs: 200_000 }), false, 'only 3.3min idle — a tab-switch, not a departure');
  // The one that matters: past the TTL the cache is already dead, so summarizing pays the cold
  // price ($1.79-$3.76 measured) to avoid a cold price. Doing nothing is strictly cheaper.
  assert.equal(due({ idleMs: 310_000 }), false, 'cache already expired → do NOT compact');
  assert.equal(due({ tokens: 100_000, idleMs: 280_000 }), false, 'too small to be worth the fidelity');
  assert.equal(due({ state: 'summarizing', idleMs: 280_000 }), false, 'already in flight');
});

// The provider's TTL runs from the last cache READ — the moment the request was prefilled — not from
// when the answer finished streaming. Measured from `agent_settled`, a 46 s final response silently
// pushed a "276 s idle" fire to 322 s after the last read: three cold fires on 2026-09-15 ($5.86),
// every one preceded by a 19-46 s last call; all sixteen warm ones by a 0-26 s one.
test('idle is measured from the last request START, so a long final answer cannot push the fire past the TTL', () => {
  let t = 0;
  const clock = idleClock(() => t);
  assert.equal(clock.idleMs(), undefined, 'no request yet → no idle to speak of (a resumed session must not fire cold)');
  t = 0; clock.request();                 // the last call starts: this is when the cache was read
  t = 46_000;                             // ...and finishes 46 s later; agent_settled fires here — NOT an event for the clock
  t = 46_000 + 276_000;                   // the old trigger point: 276 s after settle
  assert.equal(clock.idleMs(), 322_000, 'the clock says 322 s since the read, not 276 s');
  const base = { tokens: 154_787, state: 'idle', after: 270_000, ttl: 300_000, minTokens: 150_000 };
  assert.equal(idleCompactDue({ ...base, idleMs: clock.idleMs() }), false, 'the 01:21:30Z fire would have been refused');
  t = 280_000;
  assert.equal(idleCompactDue({ ...base, idleMs: clock.idleMs() }), true, 'and it fires at 280 s from the read instead, still warm');
  clock.request();                        // the summarizer request is itself a read
  assert.equal(clock.idleMs(), 0);
});
