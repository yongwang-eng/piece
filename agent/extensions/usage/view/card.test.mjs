import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, insights, renderCard, bar, weekChart, splitBar } from "./card.ts";

const stats = {
  calls: [], totals: { calls: 412, cost: 38.2, fresh: 90_000, cacheRead: 40_000_000, cacheWrite: 900_000, output: 1_900_000 },
  hitRate: 0.96, contextNow: 148_000, cacheResets: 6,
  topTools: [{ name: "Bash", bytes: 380_000 }, { name: "Read", bytes: 120_000 }],
};
const now = Date.parse("2026-09-17T20:00:00Z");
const ledger = {
  calls: 520, cost: 45.1, reasoning: 210_000,
  compactions: [{ at: now - 3_600_000, reason: "threshold", fromExtension: true, before: 300_000, summary: 20_000, cost: 0.5 }, { at: now - 600_000, reason: "threshold", fromExtension: true, before: 320_000, summary: 21_000, cost: 0.9 }],
  switches: [], dropped: { count: 0, cost: 0, unknownCost: 0 },
  points: [{ at: 1, context: 82_000, compaction: false }, { at: 2, context: 341_000, compaction: false }, { at: 3, context: 0, compaction: true }, { at: 4, context: 90_000, compaction: false }],
  cache: { hitPct: 96, calls: 520, missCost: 4.1,
    misses: [{ at: now - 3_500_000, model: "m", wrote: 300_000, cost: 1.4 }, { at: now - 8 * 3_600_000, model: "m", wrote: 200_000, cost: 1.3 }, { at: now - 9 * 3_600_000, model: "m", wrote: 200_000, cost: 1.4 }],
    readCost: 20, writeCost: 5 },
  today: [{ kind: "main", calls: 961, cost: 145 }, { kind: "worker", calls: 980, cost: 157 }],
  week: [{ day: "2026-09-11", cost: 100 }, { day: "2026-09-12", cost: 120 }, { day: "2026-09-13", cost: 246 }, { day: "2026-09-14", cost: 395 }, { day: "2026-09-15", cost: 731 }, { day: "2026-09-16", cost: 342 }, { day: "2026-09-17", cost: 302 }],
  startedAt: now - 3 * 3_600_000 - 12 * 60_000, model: "claude-fable-5-1", todayCompactions: { count: 25, cost: 11.35, avgBefore: 186_000, avgSummary: 5_000, byTrigger: [{ trigger: "idle", count: 17, cost: 7.3 }, { trigger: "threshold", count: 8, cost: 4.05 }, { trigger: "dropped", count: 2, cost: 0 }] },
  todaySplit: { calls: 2028, cost: 315.31, fresh: 25.34, cacheRead: 120.71, cacheWrite: 98.29, output: 70.97, hitPct: 95.9, hotCalls: 1970, hotCost: 245.19, coldCalls: 55, coldCost: 70.12 },
};

test("buildCard: five numbers that change a habit, from branch + ledger", () => {
  const c = buildCard(stats, ledger, { contextWindow: 200_000, now });
  assert.equal(c.sessionCost, 46.5);            // ledger calls + compactions: compacted-away calls still cost money, and so did the cut
  assert.equal(c.todayCost, 302); assert.equal(c.sharePct, 15);
  assert.equal(c.ctxNow, 148_000); assert.equal(c.ctxWindow, 200_000); assert.equal(c.ctxPct, 74);
  assert.equal(c.hitPct, 96); assert.equal(c.misses, 3); assert.equal(c.missCost, 4.1); assert.equal(c.missSharePct, 9);
  assert.equal(c.compactions, 2); assert.equal(c.compactionCost, 1.4); assert.equal(c.todayCompactions?.count, 25);
  assert.equal(c.today?.coldSharePct, 22);
  assert.equal(c.model, "claude-fable-5-1"); assert.equal(c.elapsed, "3h12");
  assert.equal(c.weekMedian, 302);              // median of 7 days
  assert.ok(c.sawtooth.length === 2);
});

test("buildCard without a ledger degrades to the branch, never throws", () => {
  const c = buildCard(stats, null, { contextWindow: 200_000, now });
  assert.equal(c.sessionCost, 38.2); assert.equal(c.todayCost, undefined); assert.equal(c.compactions, 0); assert.deepEqual(c.sawtooth, []);
});

test("insights: rule-based, ranked by $ at stake, ≤3, each names the habit", () => {
  const c = buildCard(stats, ledger, { contextWindow: 200_000, now });
  const out = insights(c);
  assert.ok(out.length <= 3, out.join("|"));
  assert.ok(out.some((l) => /2 of 3 misses .*cold-start.*\$2\.70 avoidable/.test(l)), out.join("|"));   // one miss is within 5 min of a compaction → expected
  assert.ok(out.some((l) => /55 cold calls = 22% of today's spend/.test(l)), out.join("|"));   // $70 outranks everything
  const quietDay = insights(buildCard(stats, { ...ledger, todaySplit: { ...ledger.todaySplit, coldCalls: 2, coldCost: 1 } }, { contextWindow: 200_000, now }));
  assert.ok(quietDay.some((l) => /Bash .*380k B/.test(l)), quietDay.join("|"));   // with the cold rule silent, the tool-size habit surfaces
  assert.ok(!out.some((l) => /× your 7-day median/.test(l)), out.join("|"));   // 302 vs median 302 → rule silent
  const spike = insights(buildCard(stats, { ...ledger, week: ledger.week.map((d) => (d.day === "2026-09-17" ? d : { ...d, cost: 100 })) }, { contextWindow: 200_000, now }));
  assert.ok(spike.some((l) => /3\.0× your 7-day median/.test(l)), spike.join("|"));
  assert.deepEqual(insights(buildCard({ ...stats, cacheResets: 0, topTools: [] }, { ...ledger, cache: { ...ledger.cache, misses: [], missCost: 0 }, todaySplit: { ...ledger.todaySplit, coldCalls: 0, coldCost: 0 } }, { contextWindow: 400_000, now })), []);
});

test("bar + renderCard: fits the width, plain palette, tones by threshold", () => {
  assert.equal(bar(74, 10), "▇▇▇▇▇▇▇░░░");
  const pal = { fg: (t, s) => `<${t}>${s}</${t}>`, bold: (s) => s };
  const c = buildCard(stats, ledger, { contextWindow: 200_000, now });
  const lines = renderCard(c, 100, pal, "http://127.0.0.1:9700/usage");
  const plain = lines.map((l) => l.replace(/<\/?[a-z]+>/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""));
  assert.match(plain[0], /^usage · this session/); assert.match(plain[0], /claude-fable-5-1 · 3h12 · 520 calls$/);
  assert.match(plain.join("\n"), /\$46\.50\s+session/); assert.match(plain.join("\n"), /\$302 today · you = 15%/);
  assert.match(plain.join("\n"), /ctx 148k\/200k ▇▇▇▇▇▇▇░░░ 74%/);
  assert.ok(lines.some((l) => l.includes("<warning>") && l.includes("74%")), "ctx over 70% is amber");
  assert.match(plain.join("\n"), /cache 96% hit · 3 misses = \$4\.10 \(9% of spend\)/);
  assert.match(plain.join("\n"), /▼ 2 compactions \$1\.40 · 25 today \$11\.35/);
  assert.match(plain.at(-1), /^7 days.*\$2\.2k.*dashboard ↗$/);
  assert.ok(plain.every((l) => l.length <= 100), plain.find((l) => l.length > 100));
});

test("weekChart: 7 daily bars, today marked, scaled to the week's peak, labelled with $ and total", () => {
  const c = buildCard(stats, ledger, { contextWindow: 200_000, now });
  const lines = weekChart(c.week, 100);
  assert.equal(lines.length, 3, lines.join("|"));                         // bars · day labels · $ labels
  assert.match(lines[0], /█/); assert.ok(lines[0].includes("▁") || lines[0].includes("▂"), lines[0]);   // 100 vs 731 → tall vs short
  assert.match(lines[1], /Fr.*Sa.*Su.*Mo.*Tu.*We.*today/);
  assert.match(lines[2], /100.*120.*246.*395.*731.*342.*302/);
  assert.deepEqual(weekChart([], 100), []);
});

test("today block: stacked cost split, hot vs cold, compactions with the average cut, by agent kind", () => {
  const c = buildCard(stats, ledger, { contextWindow: 200_000, now });
  const pal = { fg: (t, s) => `<${t}>${s}</${t}>`, bold: (s) => s };
  const plain = renderCard(c, 100, pal).map((l) => l.replace(/<\/?[a-z]+>/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")).join("\n");
  assert.match(plain, /today · \$315 · 2028 calls · 96% hit/);
  assert.match(plain, /compactions 25 · \$11\.35 · 186k → 5k avg · idle 17 \$7\.30 · threshold 8 \$4\.05 · dropped 2/);
  assert.match(plain, /fresh 8% · cache read 38% · cache write 31% · output 23%/);
  assert.match(plain, /hot 1970 calls \$245 · cold 55 calls \$70 = 22% of today/);
  assert.match(plain, /main \$145 · worker \$157/);
  assert.equal(splitBar([8, 38, 31, 23], 40, pal).replace(/<\/?[a-z]+>/g, "").length, 40);
  assert.ok(insights(c).some((l) => /55 cold calls .*22% of today/.test(l)), insights(c).join("|"));
});
