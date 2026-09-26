import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBoardFile, MAX_BYTES, parseBoardFile, readBoardFile, STALE_MS, withBoardFile } from "./board-file.ts";

const good = {
  detail: "k6-20260918T222100Z · 300/s vs staging_key",
  progress: { value: 0.42, label: "4m12 / 10m" },
  stats: [{ label: "rps", value: "298" }, { label: "fail", value: "0.8%", tone: "alert" }, { label: "dropped", value: "0", tone: "quiet" }],
  series: { label: "rps", points: [281, 290, 305, 298], unit: "/s" },
  links: [{ label: "log", url: "file:///tmp/k6.log" }, { label: "dashboard", url: "https://app.datadoghq.com/dashboard/X" }, { label: "vault", url: "obsidian://open?vault=v&file=f" }],
};
const row = { name: "k6", pane: "bg", state: "working", detail: "last log line", ageMs: 5000, url: "file:///tmp/pi-bg/k6.log" };

test("parseBoardFile: the §3.1 shape comes through verbatim; unknown keys are dropped", () => {
  const r = parseBoardFile(JSON.stringify({ ...good, extra: 1, stale: true }));
  assert.deepEqual(r, { detail: good.detail, body: { progress: good.progress, stats: good.stats, series: good.series, links: good.links } });
  assert.equal("stale" in r.body, false);                       // only bg may say stale — never the file
  assert.deepEqual(parseBoardFile("{}"), { detail: undefined, body: {} });
});

test("parseBoardFile: unparseable / non-object → undefined (the caller keeps the previous body)", () => {
  for (const bad of ["", "{", '{"detail":"x","prog', "[1,2]", "null", "42", '"s"', "not json"]) assert.equal(parseBoardFile(bad), undefined, JSON.stringify(bad));
});

test("parseBoardFile: a bad field is dropped, never thrown, never shown — NaN progress, non-finite points, non-string stat, bad scheme, 9 stats → 8, 7 links → 6, multi-line strings → one line", () => {
  const r = parseBoardFile(JSON.stringify({
    detail: "line one\nline two\ttabbed\u0007",
    progress: { value: "0.5", label: "not a number" },
    stats: [{ label: "bad", value: 42 }, { label: 7, value: "x" }, null, "str", ...Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, value: String(i) }))],
    series: { label: "rps", points: [1, null, "x", 1e999, -0.5, 2] },
    links: [{ label: "evil", url: "javascript:alert(1)" }, { label: "data", url: "data:text/html,x" }, { label: "esc", url: "https://x/\u001b]8;;y" }, { label: "sp", url: "https://x/a b" }, ...Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, url: `https://example.invalid/${i}` }))],
  }));
  assert.equal(r.detail, "line one ⏎ line two ⏎ tabbed");
  assert.equal(r.body.progress, undefined);
  assert.equal(r.body.stats.length, 8);
  assert.deepEqual(r.body.stats.map((s) => s.label), Array.from({ length: 8 }, (_, i) => `s${i}`));
  assert.deepEqual(r.body.series, { label: "rps", points: [1, -0.5, 2] });
  assert.equal(r.body.links.length, 6);
  assert.deepEqual(r.body.links.map((l) => l.label), Array.from({ length: 6 }, (_, i) => `l${i}`));
  // NaN literal and Infinity are not JSON → the whole file is unparseable → undefined
  assert.equal(parseBoardFile('{"progress":{"value":NaN}}'), undefined);
  // progress out of range clamps; a missing label is fine; points capped at the last 120; empty parts vanish
  const p = parseBoardFile(JSON.stringify({ progress: { value: 2 }, stats: [], links: [], series: { label: "s", points: Array.from({ length: 200 }, (_, i) => i) } }));
  assert.deepEqual(p.body.progress, { value: 1 });
  assert.equal(parseBoardFile(JSON.stringify({ progress: { value: -3 } })).body.progress.value, 0);
  assert.equal(p.body.stats, undefined); assert.equal(p.body.links, undefined);
  assert.equal(p.body.series.points.length, 120); assert.equal(p.body.series.points[0], 80);
  // a stat tone outside the vocabulary is dropped from the stat, not the stat from the line
  assert.deepEqual(parseBoardFile(JSON.stringify({ stats: [{ label: "a", value: "1", tone: "loud" }] })).body.stats, [{ label: "a", value: "1" }]);
});

test("readBoardFile: a tmp-dir fixture — good file → body + its mtime; half-written / >64 KB → the previous read; no file → nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-board-"));
  try {
    const path = join(dir, "k6.board.json");
    assert.equal(readBoardFile(path, undefined), undefined);
    writeFileSync(path, JSON.stringify(good));
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    const first = readBoardFile(path, undefined);
    assert.equal(first.detail, good.detail); assert.equal(first.mtimeMs, 1_000_000); assert.deepEqual(first.body.links, good.links);
    // a half-written file (the nonatomic writer) keeps the previous read — body AND its mtime
    writeFileSync(path, JSON.stringify(good).slice(0, 40));
    utimesSync(path, new Date(2_000_000), new Date(2_000_000));
    assert.equal(readBoardFile(path, first), first);
    assert.equal(readBoardFile(path, undefined), undefined);
    // > 64 KB is not even parsed
    writeFileSync(path, JSON.stringify({ ...good, pad: "x".repeat(MAX_BYTES) }));
    assert.equal(readBoardFile(path, first), first);
    // the file goes away → the body goes with it
    rmSync(path);
    assert.equal(readBoardFile(path, first), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("withBoardFile: the file's detail replaces the log line, the body rides on the row; stale at 31 s, not at 29 s, measured from the last GOOD parse", () => {
  const read = { detail: "from the file", body: { progress: { value: 0.5 }, stats: [{ label: "rps", value: "40" }] }, mtimeMs: 100_000 };
  assert.deepEqual(withBoardFile(row, undefined, 100_000), row);
  const fresh = withBoardFile(row, read, 100_000 + 29_000);
  assert.equal(fresh.detail, "from the file"); assert.deepEqual(fresh.body, read.body); assert.equal(fresh.state, "working"); assert.equal(fresh.url, row.url);
  const stale = withBoardFile(row, read, 100_000 + 31_000);
  assert.equal(stale.detail, "from the file · stale 31s");
  assert.deepEqual(stale.body, { ...read.body, stale: true });
  assert.equal(withBoardFile(row, { ...read, detail: undefined }, 100_000 + 40_000).detail, "last log line · stale 40s");
  assert.equal(withBoardFile(row, read, 100_000 + 90_000).detail, "from the file · stale 1m30");
  assert.equal(withBoardFile(row, read, 100_000 - 5_000).detail, "from the file");     // an mtime in the future (clock skew) is not stale
  assert.equal(STALE_MS, 30_000);
  // the tie: exactly STALE_MS old is still fresh (a 1 s ticker over a 1 s writer lands here often); one ms past is stale
  assert.deepEqual(withBoardFile(row, read, 100_000 + STALE_MS), { ...row, detail: "from the file", body: read.body });
  assert.equal(withBoardFile(row, read, 100_000 + STALE_MS + 1).detail, "from the file · stale 30s");
});

test("clearBoardFile: bg_run removes a previous run's file so no ghost body shows; a missing file is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-board-"));
  try {
    const path = join(dir, "k6.board.json");
    writeFileSync(path, "{}");
    clearBoardFile(path); assert.equal(existsSync(path), false);
    clearBoardFile(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
