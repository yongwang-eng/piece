import test from "node:test";
import assert from "node:assert/strict";
import { bodyOf, durText, endedBody, parseMetrics, parseStatus, summaryPath, trackRps } from "./board.ts";

// the REST shape k6 v2 serves (tester/evidence/k6_metrics_per_metric.txt · k6_status_sample.json)
const metric = (id, type, sample) => ({ type: "metrics", id, attributes: { type, contains: "default", tainted: null, sample } });
const metricsJson = (extra = []) => ({ data: [
  metric("http_reqs", "counter", { count: 789, rate: 25.3 }),   // cumulative since start — a run that ramped; NOT what the board shows
  metric("http_req_duration", "trend", { avg: 25.03, max: 157.0, med: 23.3, min: 5.1, "p(90)": 37.5, "p(95)": 39.699 }),
  metric("http_req_failed", "rate", { rate: 0.09632 }),
  metric("vus", "gauge", { value: 2 }), metric("vus_max", "gauge", { value: 10 }),
  metric("iterations", "counter", { count: 789, rate: 39.86 }),
  ...extra,
] });
const statusJson = (over = {}) => ({ data: { type: "status", id: "default", attributes: { status: 7, paused: false, vus: 2, "vus-max": 10, stopped: false, running: true, tainted: false, ...over } } });
const run = { runId: "k6-20260918T182400Z", durationS: 80, rate: 40, target: "127.0.0.1:18081", startedAt: 1_000_000 };

test("parseMetrics: id → sample; tolerant of garbage; parseStatus reads running/tainted/vus", () => {
  const m = parseMetrics(metricsJson());
  assert.equal(m.get("http_reqs").count, 789); assert.equal(m.get("http_req_duration")["p(95)"], 39.699);
  assert.equal(m.get("nope"), undefined);
  assert.equal(parseMetrics(null).size, 0); assert.equal(parseMetrics({ data: "x" }).size, 0); assert.equal(parseMetrics({ data: [null, {}, { id: 1 }] }).size, 0);
  assert.deepEqual(parseStatus(statusJson()), { running: true, tainted: false, vus: 2, vusMax: 10 });
  assert.deepEqual(parseStatus(statusJson({ running: false, tainted: true })), { running: false, tainted: true, vus: 2, vusMax: 10 });
  assert.equal(parseStatus({}), undefined); assert.equal(parseStatus(null), undefined);
});

test("trackRps: rps is Δcount/Δt between polls, never k6's cumulative rate; the first sample makes no point; 61 points → the oldest evicted", () => {
  let t = trackRps(undefined, 100, 10_000);
  assert.deepEqual(t.points, []);
  t = trackRps(t, 140, 11_000);            // +40 in 1 s
  assert.deepEqual(t.points, [40]);
  t = trackRps(t, 240, 13_000);            // +100 in 2 s
  assert.deepEqual(t.points, [40, 50]);
  t = trackRps(t, 240, 14_000);            // no new requests → 0, a real point (the generator stalled)
  assert.deepEqual(t.points, [40, 50, 0]);
  t = trackRps(t, 200, 15_000);            // a counter reset (k6 restarted) → clamped at 0, not negative
  assert.deepEqual(t.points, [40, 50, 0, 0]);
  t = trackRps(t, 200, 15_000);            // same instant → no division by zero, no point
  assert.deepEqual(t.points, [40, 50, 0, 0]);
  for (let i = 0; i < 70; i++) t = trackRps(t, 200 + (i + 1) * 10, 16_000 + i * 1_000);
  assert.equal(t.points.length, 60);
  assert.deepEqual(t.points.slice(0, 3), [10, 10, 10]);   // the 40/50/0/0 are gone
});

test("bodyOf: the six numbers in importance order, progress from elapsed/duration, the four links, the detail — and every missing id is 0, never blank", () => {
  const m = parseMetrics(metricsJson());
  const st = parseStatus(statusJson());
  const tr = { at: 1_013_000, count: 789, points: [39, 41, 40, 40, 39, 41, 40, 40, 41, 40, 40, 40, 40] };
  const b = bodyOf(run, m, st, tr, 1_013_000);
  assert.equal(b.detail, "k6-20260918T182400Z · 40/s vs 127.0.0.1:18081");
  assert.deepEqual(b.progress, { value: 0.1625, label: "13s / 1m20 · ~1m07" });
  assert.deepEqual(b.stats, [
    { label: "rps", value: "40" }, { label: "p95", value: "40ms" }, { label: "fail", value: "9.6%" }, { label: "VUs", value: "2/10" },
    { label: "429s", value: "0" }, { label: "dropped", value: "0", tone: "quiet" },
  ]);
  assert.deepEqual(b.series, { label: "rps", points: tr.points, unit: "/s" });
  assert.deepEqual(b.links, [
    { label: "log", url: "file:///tmp/k6_k6-20260918T182400Z.log" },
    { label: "dashboard", url: "https://app.datadoghq.com/dashboard/REPLACE-ME?tpl_var_runid=k6-20260918T182400Z" },
    { label: "events", url: "https://app.datadoghq.com/logs?query=%40http.useragent%3Ak6-burst%2Fk6-20260918T182400Z" },
    { label: "k6-20260918T182400Z", url: "file:///tmp/k6_k6-20260918T182400Z.json" },
  ]);
  // present counters are read; dropped > 0 turns alert; tainted turns fail alert
  const m2 = parseMetrics(metricsJson([metric("rate_limited", "counter", { count: 65 }), metric("dropped_iterations", "counter", { count: 3, rate: 0.1 })]));
  const b2 = bodyOf(run, m2, parseStatus(statusJson({ tainted: true })), tr, 1_013_000);
  assert.deepEqual(b2.stats.slice(2), [{ label: "fail", value: "9.6%", tone: "alert" }, { label: "VUs", value: "2/10" }, { label: "429s", value: "65" }, { label: "dropped", value: "3", tone: "alert" }]);
  // no request yet: the trend is missing → p95 —; no track point → rps 0; no status → VUs from the metrics, then ?/?
  const b3 = bodyOf(run, parseMetrics({ data: [metric("vus", "gauge", { value: 1 })] }), undefined, { at: 0, count: 0, points: [] }, 1_001_000);
  assert.deepEqual(b3.stats.slice(0, 4), [{ label: "rps", value: "0" }, { label: "p95", value: "—" }, { label: "fail", value: "0%" }, { label: "VUs", value: "1/?" }]);
  assert.equal(b3.series, undefined);                                   // nothing to draw yet → no part, not an empty one
  // the run is over: progress pins at 1 and the label loses the estimate; elapsed never exceeds the duration
  const done = bodyOf(run, m, parseStatus(statusJson({ running: false })), tr, 1_000_000 + 95_000);
  assert.deepEqual(done.progress, { value: 1, label: "1m20 / 1m20" });
  assert.deepEqual(bodyOf(run, m, st, tr, 1_000_000 + 95_000).progress, { value: 1, label: "1m20 / 1m20" });
  assert.equal(bodyOf({ ...run, rate: undefined, target: undefined }, m, st, tr, 1_013_000).detail, "k6-20260918T182400Z");
  assert.deepEqual(bodyOf({ ...run, log: "/tmp/x.log", summary: "/tmp/x.json" }, m, st, tr, 1_013_000).links.map((l) => l.url).filter((u) => u.startsWith("file:")), ["file:///tmp/x.log", "file:///tmp/x.json"]);
});

test("endedBody: the pin rides on a FACT — k6's --summary-export file written since the run started; no file (k6 killed) → no pin at 95 %, file → pin even at 60 % (a threshold abort still ENDED)", () => {
  const m = parseMetrics(metricsJson());
  const st = parseStatus(statusJson());
  const tr = { at: 1_077_000, count: 3080, points: [39, 41, 40, 40, 39, 41, 40, 40, 41, 40, 40, 40, 38.9] };
  assert.equal(endedBody(run, m, st, tr, 1_000_000 + 77_000, undefined), undefined);          // 96 % through, API gone, no summary: killed — the last honest body stands
  const fin = endedBody(run, m, st, tr, 1_000_000 + 48_000, 1_000_000 + 48_300);              // 60 % through, summary landed → ended
  assert.deepEqual(fin.progress, { value: 1, label: "1m20 / 1m20" });
  assert.equal(fin.stats[0].value, "38.9");                                                    // the last numbers stay on the pinned body
  assert.deepEqual(fin.series, { label: "rps", points: tr.points, unit: "/s" });
  assert.equal(endedBody(run, m, st, tr, 1_000_000 + 77_000, 999_000), undefined);            // a summary older than the run (fixed --summary path, previous run) is not this run's
  assert.equal(endedBody(run, m, st, tr, 1_000_000 + 77_000, 1_000_000).progress.value, 1);   // written at the very start instant still counts
  assert.equal(endedBody(run, m, undefined, tr, 1_000_000 + 79_000, 1_079_000).progress.value, 1);   // /v1/status never parsed → still pins
  assert.equal(endedBody(run, m, parseStatus(statusJson({ tainted: true })), tr, 1_000_000 + 79_000, 1_079_000).stats[2].tone, "alert");   // tainted survives the pin
  // the file the wrapper watches is the file the RUNID link points at
  assert.equal(summaryPath(run), "/tmp/k6_k6-20260918T182400Z.json");
  assert.equal(summaryPath({ ...run, summary: "/tmp/x.json" }), "/tmp/x.json");
  assert.equal(bodyOf(run, m, st, tr, 1_013_000).links.at(-1).url, `file://${summaryPath(run)}`);
});

test("durText: 45s · 4m12 · 10m · 1h05", () => {
  assert.equal(durText(45), "45s"); assert.equal(durText(252), "4m12"); assert.equal(durText(600), "10m"); assert.equal(durText(3900), "1h05"); assert.equal(durText(0), "0s");
});
