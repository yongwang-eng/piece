import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, fromCompactEvent, headline } from "./detail.ts";

const at = Date.parse("2026-09-13T14:03:05");
const bg = {
  at, mode: "background", label: "threshold 200k", model: "claude-fable-5-1",
  before: 191_033, after: 33_200, summaryChars: 52_400,
  usage: { input: 0, cacheRead: 189_900, cacheWrite: 900, output: 13_100,
    cost: { total: 0.46, input: 0, cacheRead: 0.057, cacheWrite: 0.005, output: 0.398 } },
  summarizeMs: 41_300, waitMs: 12_400,
};

test("headline carries the cut, the ratio, the time, the price and when it finished", () => {
  assert.equal(headline(bg), "191.0k → 33.2k · −83% · 54s · $0.46 · 14:03:05");
});

test("full card: every fact the compaction produced, nothing invented", () => {
  const rows = Object.fromEntries(describe(bg).map(r => [r.key, r.value]));
  assert.equal(rows.trigger, "threshold 200k · background · summarizer claude-fable-5-1");
  assert.match(rows.ledger, /191\.0k → 33\.2k tokens  \(−83%, 157\.8k reclaimed\)/);
  assert.match(rows.summary, /13\.1k tokens · 52\.4k chars · kept tail ≈ 20\.1k · 15:1 compression/);
  assert.match(rows.request, /sent 190\.8k · cached 189\.9k \(99\.5%\) · uncached 900 · out 13\.1k/);
  // rate = 0.057 / 189,900 per token; saving = 157,833 × rate ≈ $0.047/call; 0.46 / 0.047 → 10 calls
  assert.match(rows.cost, /^\$0\.46  \(context \$0\.062 · output \$0\.40\) · saves ≈ \$0\.047\/call → pays back in 10 calls$/);
  assert.equal(rows.timing, "summarized in 41s · waited 12s for a pause · total 54s");
  assert.equal(rows.span, "14:02:11 → 14:03:05");
});

test("a 99.5% hit is a success, a cold summarizer is a warning", () => {
  const tone = (usage) => describe({ ...bg, usage }).find(r => r.key === "request").tone;
  assert.equal(tone(bg.usage), "success");
  assert.equal(tone({ input: 190_000, cacheRead: 0, cacheWrite: 0, output: 13_000 }), "warning");
});

test("a blocking compaction with no usage still reports the ledger and the moment", () => {
  const rows = describe({ at, mode: "blocking", label: "manual", model: "gpt-6-astra", before: 120_000, after: 25_000, summaryChars: 30_000, usage: null, summarizeMs: null, waitMs: null });
  assert.deepEqual(rows.map(r => r.key), ["trigger", "ledger", "span"]);
  assert.equal(rows[2].value, "14:03:05");
  assert.equal(headline({ ...bg, usage: null, summarizeMs: null, waitMs: null, after: null }), "191.0k → ? · 14:03:05");
});

test("session_compact + background facts fold into one record; a native cut borrows nothing", () => {
  const usage = bg.usage;
  const ev = { fromExtension: true, reason: "manual", compactionEntry: { tokensBefore: 191_033, summary: "s".repeat(500), usage } };
  const d = fromCompactEvent(ev, { tokensBefore: 191_033, label: "threshold 200k", startedAt: 1000, readyAt: 42_300 }, 33_200, "claude-fable-5-1", 54_700);
  assert.equal(d.mode, "background"); assert.equal(d.label, "threshold 200k");
  assert.equal(d.summarizeMs, 41_300); assert.equal(d.waitMs, 12_400); assert.equal(d.summaryChars, 500); assert.equal(d.usage, usage);
  // a stale pending from a DIFFERENT cut must not be attached
  const other = fromCompactEvent(ev, { tokensBefore: 5, label: "x", startedAt: 1 }, 33_200, null, 54_700);
  assert.equal(other.mode, "blocking"); assert.equal(other.summarizeMs, null);
  // pi's own threshold/overflow compaction: label is pi's reason, no timings
  const native = fromCompactEvent({ fromExtension: false, reason: "threshold", compactionEntry: { tokensBefore: 90_000 } }, { tokensBefore: 90_000, label: "x", startedAt: 1 }, null, "gpt-6-astra", 5);
  assert.deepEqual([native.mode, native.label, native.before, native.after, native.summarizeMs], ["blocking", "threshold", 90_000, null, null]);
});
