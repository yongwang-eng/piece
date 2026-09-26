import { test } from "node:test";
import assert from "node:assert";
import { computeStats, sawtooth, missCause } from "./stats.ts";

const asst = (usage, tools = 0, stop = "toolUse") => ({
  message: { role: "assistant", stopReason: stop, usage,
    content: Array.from({ length: tools }, () => ({ type: "toolCall", id: "x", name: "bash" })) },
});
const toolRes = (name, size) => ({ message: { role: "toolResult", toolName: name, content: [{ type: "text", text: "x".repeat(size) }] } });
const u = (fresh, read, write, out) => ({ input: fresh, cacheRead: read, cacheWrite: write, output: out, cost: { total: 0.01 } });

test("lecture-2 shaped turn: 4 calls, moving bookmark", () => {
  const s = computeStats([
    asst(u(15000, 0, 15000, 100), 1),          // call 1: cold, writes prefix
    toolRes("bash", 4000),
    asst(u(0, 15000, 1100, 100), 1),           // call 2: reads 15k
    toolRes("read", 40000),
    asst(u(0, 16100, 1100, 100), 1),           // call 3
    toolRes("bash", 400),
    asst(u(0, 17200, 1100, 900), 0, "stop"),   // call 4: answers
  ]);
  assert.equal(s.totals.calls, 4);
  assert.equal(s.contextNow, 17200 + 1100);
  assert.equal(s.cacheResets, 0);
  assert.ok(s.hitRate > 0.55, `hitRate ${s.hitRate}`);
  assert.equal(s.topTools[0].name, "read");   // 40kB read is the compaction target
});

test("cache reset detected: mid-session prompt mutation", () => {
  const s = computeStats([
    asst(u(10000, 0, 10000, 50), 1),
    asst(u(0, 10000, 500, 50), 1),
    asst(u(11000, 0, 11000, 50), 1, "stop"),  // read 0 again = prefix changed
  ]);
  assert.equal(s.cacheResets, 1);
});

test("assistant without usage (aborted) is skipped, not a crash", () => {
  const s = computeStats([{ message: { role: "assistant", stopReason: "aborted", content: [] } }]);
  assert.equal(s.totals.calls, 0);
});

// ── recorded ledger ───────────────────────────────────────────────────────────
const pts = (...vals) => vals.map((v, i) => typeof v === 'string'
  ? { at: i, context: 0, compaction: true }
  : { at: i, context: v, compaction: false });

test('sawtooth marks each compaction and scales to the peak', () => {
  const [bar, legend] = sawtooth(pts(10_000, 50_000, 100_000, 'C', 8_000, 40_000));
  assert.equal(bar.length, 6);
  assert.equal(bar[3], '▼', 'the compaction must be visible as a cut');
  assert.equal(bar[2], '█', 'the peak call must be full height');
  assert.ok(bar.indexOf('▁') < 3 || bar[4] === '▁', 'the lowest context must be the lowest bar');
  assert.match(legend, /8\.0k → 100\.0k tok/);
});

test('sawtooth is a no-op when there is nothing to plot', () => {
  assert.deepEqual(sawtooth(pts(5000)), [], 'one point is not a shape');
  assert.deepEqual(sawtooth([]), []);
});

test('a miss right after a compaction is explained, not blamed', () => {
  const comp = [{ at: 1_000_000, reason: 'threshold', fromExtension: true, before: 200_000, summary: 6_000, cost: 0.7 }];
  const after = { at: 1_012_000, model: 'm', wrote: 95_000, cost: 1.22 };
  const cold = { at: 9_000_000, model: 'm', wrote: 195_000, cost: 2.46 };
  assert.match(missCause(after, comp), /after compaction/);
  assert.match(missCause(cold, comp), /cold start/);
  assert.match(missCause(after, []), /cold start/, 'no compaction on record = no excuse');
});

