import test from "node:test";
import assert from "node:assert/strict";
import { boardStyled, boardSummary } from "./board.ts";
import { displayWidth } from "./width.ts";
import { bar, fmtNum, quietFold, sectionLines, sparkline } from "./section.ts";

// Two palettes: `plain` for width math (displayWidth ignores nothing it cannot see), `tagged` for tone assertions.
const plain = { fg: (_t, s) => s, bold: (s) => s };
const tagged = { fg: (t, s) => `<${t}>${s}</${t}>`, bold: (s) => s };
const osc8 = (label, url) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;   // pi-tui's hyperlink, verbatim
const gutter = (pal) => (l) => `${pal.fg("dim", "┊ ")}${l}`;
const strip = (s) => s.replace(/<\/?[a-z]+>/g, "");

const now = 0;
const row = (name, over = {}) => ({ name, pane: "bg", state: "working", detail: "running", ageMs: 65_000, url: `file:///tmp/pi-bg/${name}.log`, ...over });
const body = {
  progress: { value: 0.42, label: "4m12 / 10m · ~5m48" },
  stats: [{ label: "rps", value: "298" }, { label: "p95", value: "412ms" }, { label: "fail", value: "0.8%" }, { label: "VUs", value: "610/1200" }, { label: "429s", value: "24" }, { label: "dropped", value: "0", tone: "quiet" }],
  series: { label: "rps", points: Array.from({ length: 60 }, (_, i) => 280 + (i % 7) * 4), unit: "/s" },
  links: [{ label: "log", url: "file:///tmp/k6.log" }, { label: "dashboard", url: "https://app.datadoghq.com/dashboard/X" }, { label: "events", url: "https://app.datadoghq.com/logs?query=k6" }, { label: "k6-20260918T222100Z", url: "file:///tmp/k6.json" }],
};
const bgData = (rows) => ({ title: "bg", noun: "job", hint: "bg_list", rows });
const devinData = (rows) => ({ title: "devin", noun: "session", hint: "/devin", rows });

// ── the regression bar: rows without bodies render byte-identically to what bg and devin paint today ──
test("data rows-only === boardStyled/boardSummary + gutter (bg and devin fixtures)", () => {
  const bgRows = [row("pr73061_ci", { detail: "00:45Z 73061=OPEN checks=pending", ageMs: 600_000 }), row("wt_suite", { detail: "# pass 467" })];
  const devinRows = [
    { name: "sqs-kept-causes-spec", pane: "devin", state: "working", detail: "PR #73061 open · working · 12 ACU", ageMs: 1_800_000, url: "https://app.devin.ai/s/1", prUrl: "https://github.com/acme/app/pull/73061" },
    { name: "monitors-production", pane: "devin", state: "idle", detail: "paused · All five replies posted verbatim · 4 ACU", ageMs: 7_200_000, url: "https://app.devin.ai/s/2" },
    { name: "stuck", pane: "devin", state: "waiting", detail: "waiting on YOU · q", ageMs: 9_000, waiting: { on: "you", why: "q", sinceMs: 9_000 } },
    { name: "b", pane: "devin", state: "gone", detail: "died", ageMs: 9_000 }, { name: "c", pane: "devin", state: "stalled", detail: "stuck", ageMs: 9_000 },
  ];   // ONE quiet row: byte-identity holds; two or more fold (D97, next test)
  for (const pal of [plain, tagged, { ...tagged, link: osc8 }]) {
    for (const w of [170, 100, 60, 34]) {
      assert.deepEqual(sectionLines(bgData(bgRows), w, pal, false), boardStyled(bgRows, w - 2, 4, "bg", pal, { noun: "job", hint: "bg_list" }).map(gutter(pal)), `bg expanded w=${w}`);
      assert.deepEqual(sectionLines(bgData(bgRows), w, pal, true), boardSummary(bgRows, w - 2, "bg", pal, { noun: "job", hint: "bg_list" }).map(gutter(pal)), `bg folded w=${w}`);
      assert.deepEqual(sectionLines(devinData(devinRows), w, pal, false), boardStyled(devinRows, w - 2, 4, "devin", pal, { noun: "session", hint: "/devin" }).map(gutter(pal)), `devin expanded w=${w} (5 rows → +1 more)`);
      assert.deepEqual(sectionLines(devinData(devinRows), w, pal, true), boardSummary(devinRows, w - 2, "devin", pal, { noun: "session", hint: "/devin" }).map(gutter(pal)), `devin folded w=${w}`);
    }
  }
  assert.deepEqual(sectionLines(bgData([]), 80, plain, false), []);
  assert.deepEqual(sectionLines(bgData([]), 80, plain, true), []);
});

// ── D97: quiet rows fold into ONE dim line — visible, never loud, never dropped ──
test("quiet fold: ≥2 idle/done rows become one line `○ N idle · name age · …`, after the loud rows, names still clickable; 1 quiet row stays a row", () => {
  const q = (name, state, ageMs, url) => ({ name, pane: "devin", state, detail: `${state} · x`, ageMs, url });
  const loud = [row("live", { pane: "devin" }), { ...q("owed", "waiting", 5_000), waiting: { on: "you", why: "q", sinceMs: 5_000 } }];
  const quiet = [q("boot-phase-emit", "idle", 3 * 3_600_000, "https://app.devin.ai/s/1"), q("pr-72812", "idle", 2 * 86_400_000, "https://app.devin.ai/s/2"), q("sqs-kept", "idle", 4 * 86_400_000)];
  const lines = sectionLines(devinData([...quiet, ...loud]), 120, plain, false);
  assert.equal(lines.length, 4, "header · owed · live · fold");
  assert.match(lines[1], /^┊ ⏳ owed /); assert.match(lines[2], /^┊ ● live /);
  assert.equal(lines[3], "┊ ○ 3 idle · boot-phase-emit 3h00 · pr-72812 2d · sqs-kept 4d");
  assert.match(lines[0], / · 5 sessions · you owe 1$/, "the header still counts every row");
  // mixed idle + done says `quiet`; all done says `done` with ✓
  assert.match(quietFold([q("a", "idle", 1000), q("b", "done", 1000)], 80, plain), /^○ 2 quiet · a /);
  assert.match(quietFold([q("a", "done", 1000), q("b", "done", 1000)], 80, plain), /^✓ 2 done · a /);
  // tones: glyph + count dim, names muted and OSC 8-wrapped AFTER the cut, ages dim
  const t = sectionLines(devinData([...quiet, ...loud]), 120, { ...tagged, link: osc8 }, false)[3];
  assert.match(t, /<dim>○ 3 idle<\/dim>/);
  assert.ok(t.includes(osc8("boot-phase-emit", "https://app.devin.ai/s/1")) || /boot-phase-emit/.test(t));
  assert.match(t, /<muted>[^<]*sqs-kept[^<]*<\/muted>/, "a quiet name without a url is plain muted");
  // width: whole items drop from the right with ' …'; the count survives
  const narrow = sectionLines(devinData([...quiet, ...loud]), 40, plain, false)[3];
  assert.match(narrow, /^┊ ○ 3 idle · boot-phase-emit 3h00 …$/);
  // one quiet row → an ordinary dim row, byte-identical to boardStyled
  const one = [...loud, quiet[0]];
  assert.deepEqual(sectionLines(devinData(one), 120, plain, false), boardStyled(one, 118, 4, "devin", plain, { noun: "session", hint: "/devin" }).map(gutter(plain)));
  // folded (ctrl+]) is unchanged: boardSummary tallies states
  assert.deepEqual(sectionLines(devinData([...quiet, ...loud]), 120, plain, true), boardSummary([...quiet, ...loud], 118, "devin", plain, { noun: "session", hint: "/devin" }).map(gutter(plain)));
  // the fold takes one of the four row slots: 5 loud + 2 quiet → 3 loud, fold, "+2 more"
  const many = [...Array.from({ length: 5 }, (_, i) => row(`w${i}`, { pane: "devin" })), quiet[0], quiet[1]];
  const m = sectionLines(devinData(many), 120, plain, false);
  assert.equal(m.length, 6); assert.match(m[4], /^┊ ○ 2 idle/); assert.match(m[5], /\+2 more \(\/devin\)/);
});

// ── the body ──
test("body order progress · stats · series · links under its row, indent 2; absent parts leave no blank line", () => {
  const rows = [row("pr73061_ci", { detail: "00:45Z 73061=OPEN" }), row("k6_burst", { detail: "k6-20260918T222100Z · 300/s vs staging_key", body })];
  const lines = sectionLines(bgData(rows), 120, plain, false);
  assert.equal(lines.length, 1 + 2 + 4, lines.join("\n"));
  assert.equal(lines[0], "┊ bg · 2 jobs");
  assert.match(lines[1], /^┊ ● pr73061_ci bg · /);
  assert.match(lines[2], /^┊ ● k6_burst bg · k6-20260918T222100Z · 300\/s vs staging_key · 1m05$/);
  assert.equal(lines[3], "┊   ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 42% · 4m12 / 10m · ~5m48");
  assert.equal(lines[4], "┊   rps 298 · p95 412ms · fail 0.8% · VUs 610/1200 · 429s 24 · dropped 0");
  assert.match(lines[5], /^┊   rps [▁▂▃▄▅▆▇█]{60} 292\/s$/);
  assert.equal(lines[6], "┊   log · dashboard · events · k6-20260918T222100Z");
  assert.ok(lines.every((l) => displayWidth(l) <= 120));
  // partial bodies: only the parts given, in order, nothing blank
  const partial = sectionLines(bgData([row("j", { body: { links: body.links, stats: body.stats.slice(0, 2) } })]), 120, plain, false);
  assert.deepEqual(partial.slice(2), ["┊   rps 298 · p95 412ms", "┊   log · dashboard · events · k6-20260918T222100Z"]);
  assert.deepEqual(sectionLines(bgData([row("j", { body: {} })]), 120, plain, false).length, 2);
  // the "+N more" line stays last, after the fourth row's body
  const five = sectionLines(bgData([1, 2, 3, 4, 5].map((i) => row(`j${i}`, { body: { stats: [{ label: "n", value: String(i) }] } }))), 120, plain, false);
  assert.equal(five.at(-1), "┊ … +1 more (bg_list)");
  assert.equal(five.at(-2), "┊   n 4");
});

test("ranking: a body follows its row into the board's order (owed → stalled → working → done); the array order is not the screen order, in the fold appendix too", () => {
  const owed = { ...row("owed"), state: "waiting", waiting: { on: "you", why: "q", sinceMs: 1000 }, detail: "waiting on YOU · q" };
  const stat = (v) => ({ body: { stats: [{ label: "n", value: v }] } });
  const rows = [row("done", { state: "done", ...stat("d") }), row("k6", stat("k")), owed, row("stalled", { state: "stalled", ...stat("s") })];
  const lines = sectionLines(bgData(rows), 120, plain, false);
  assert.deepEqual(lines.slice(1).map((l) => l.replace(/^┊ \S (\S+) .*$/, "$1")), ["owed", "stalled", "┊   n s", "k6", "┊   n k", "done", "┊   n d"]);
  // folded: the appendix walks the same order, so the first stat named is the highest-ranked bodied row
  assert.match(sectionLines(bgData(rows), 200, plain, true)[0], / · stalled · n s · k6 · n k · done · n d$/);
});

test("tones: bar filled = row glyph tone, empty dim, pct text, label dim; stats label dim / value text or its tone; series glyphs text; links via linkText", () => {
  const rows = [row("k6", { body: { progress: { value: 0.5, label: "L" }, stats: [{ label: "rps", value: "1" }, { label: "fail", value: "9%", tone: "alert" }, { label: "dropped", value: "0", tone: "quiet" }], series: { label: "rps", points: [1, 2, 3, 4, 5, 6, 7, 8], unit: "/s" }, links: [{ label: "log", url: "file:///l" }] } })];
  const pal = { ...tagged, link: osc8 };
  const [, , bar, stats, series, links] = sectionLines(bgData(rows), 120, pal, false);
  assert.equal(bar, "<dim>┊ </dim>  <success>▰▰▰▰▰▰▰▰▰▰</success><dim>▱▱▱▱▱▱▱▱▱▱</dim> <text>50%</text><dim> · L</dim>");
  assert.equal(stats, "<dim>┊ </dim>  <dim>rps </dim><text>1</text><dim> · </dim><dim>fail </dim><error>9%</error><dim> · </dim><dim>dropped </dim><dim>0</dim>");
  assert.equal(series, "<dim>┊ </dim>  <dim>rps </dim><text>▂▂▃▄▅▆▇█</text><text> 8/s</text>");
  assert.match(links, /^<dim>┊ <\/dim>  <accent>\x1b\]8;;file:\/\/\/l\x1b\\\x1b\[4:4m\x1b\[58;2;\d+;\d+;\d+mlog\x1b\[59m\x1b\[24m\x1b\]8;;\x1b\\<\/accent>$/);
  // a stalled row's bar is red; a stale body is dim throughout
  const [, , redBar] = sectionLines(bgData([row("k6", { state: "stalled", body: { progress: { value: 0.5 } } })]), 120, tagged, false);
  assert.equal(redBar, "<dim>┊ </dim>  <error>▰▰▰▰▰▰▰▰▰▰</error><dim>▱▱▱▱▱▱▱▱▱▱</dim> <text>50%</text>");
  const stale = sectionLines(bgData([row("k6", { body: { stale: true, progress: { value: 0.5, label: "L" }, stats: [{ label: "rps", value: "1", tone: "alert" }], series: { label: "rps", points: [1, 2, 3, 4, 5, 6, 7, 8] } } })]), 120, tagged, false);
  for (const l of stale.slice(2)) assert.equal(strip(l), l.replace(/<\/?dim>/g, ""), `stale body is dim only: ${l}`);
});

// ── width ──
test("width: W<30 → no body, the row survives; stats drop from the right with ' …'; series drops from the left; links whole-or-nothing", () => {
  const rows = [row("k6_burst", { detail: "k6-20260918T222100Z · 300/s vs staging_key", body })];
  for (const width of [33, 30, 20]) {
    const lines = sectionLines(bgData(rows), width, plain, false);
    assert.equal(lines.length, 2, `w=${width}: ${lines.join("|")}`);
    assert.ok(lines.every((l) => displayWidth(l) <= width));
  }
  // W = 60 - 4 = 56: the 20-bar + label (45) still fits, stats lose the last two pairs, sparkline keeps 46, links keep all four
  const at60 = sectionLines(bgData(rows), 60, plain, false);
  assert.ok(at60.every((l) => displayWidth(l) <= 60), at60.join("\n"));
  assert.equal(at60[2], "┊   ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱ 42% · 4m12 / 10m · ~5m48");
  assert.equal(at60[3], "┊   rps 298 · p95 412ms · fail 0.8% · VUs 610/1200 …");
  assert.match(at60[4], /^┊   rps [▁▂▃▄▅▆▇█]{46} 292\/s$/);
  // W = 44: bar 20 + label (45) does not fit → bar 10 + whole label
  assert.equal(sectionLines(bgData(rows), 48, plain, false)[2], "┊   ▰▰▰▰▱▱▱▱▱▱ 42% · 4m12 / 10m · ~5m48");
  assert.equal(at60[5], "┊   log · dashboard · events · k6-20260918T222100Z");
  // the series keeps the NEWEST points: the last glyph is the last point's cell
  const rising = sectionLines(bgData([row("r", { body: { series: { label: "s", points: Array.from({ length: 100 }, (_, i) => i) } } })]), 60, plain, false);
  assert.match(rising[2], /█ 99$/);
  assert.equal(rising[2].match(/[▁▂▃▄▅▆▇█]/g).length, 51);
  // fewer than 8 glyphs would fit or exist → the series line is dropped, the others stay
  const few = sectionLines(bgData([row("f", { body: { series: { label: "s", points: [1, 2, 3, 4, 5] }, links: [{ label: "log", url: "file:///l" }] } })]), 80, plain, false);
  assert.deepEqual(few.slice(2), ["┊   log"]);
  const squeezed = sectionLines(bgData([row("f", { body: { series: { label: "a label this long leaves fewer than eight cells for the glyphs", points: body.series.points } } })]), 60, plain, false);
  assert.equal(squeezed.length, 2);
  // a value is never cut mid-digit: at W=34 only pairs that fit whole stay, then " …"
  const stats = sectionLines(bgData([row("s", { body: { stats: body.stats } })]), 38, plain, false);
  assert.equal(stats[2], "┊   rps 298 · p95 412ms · fail 0.8% …");
  // links: drop whole links from the right; a label is never truncated
  const links = sectionLines(bgData([row("l", { body: { links: body.links } })]), 44, plain, false);
  assert.equal(links[2], "┊   log · dashboard · events …");
  // progress: the label is cut with … (fit semantics) once even the 10-bar cannot hold it whole; the 10-bar + pct never drops
  const cutLabel = sectionLines(bgData([row("p", { body: { progress: { value: 0.42, label: "a very long label that cannot fit in the room left" } } })]), 40, plain, false);
  assert.equal(cutLabel[2], "┊   ▰▰▰▰▱▱▱▱▱▱ 42% · a very long label …");
  const minW = sectionLines(bgData([row("p", { body: { progress: { value: 0.42, label: "a very long label that cannot fit" } } })]), 34, plain, false);
  assert.equal(minW[2], "┊   ▰▰▰▰▱▱▱▱▱▱ 42% · a very long …");
  assert.equal(displayWidth(minW[2]), 34);
});

test("OSC 8 wrapped after the cut: a links line that dropped links still wraps every kept label whole, never splits an escape", () => {
  const pal = { ...plain, link: osc8 };
  const [, , line] = sectionLines(bgData([row("l", { body: { links: body.links } })]), 44, pal, false);
  const wrapped = [...line.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\(.*?)\x1b\]8;;\x1b\\/g)];
  assert.deepEqual(wrapped.map((m) => m[1]), body.links.slice(0, 3).map((l) => l.url));
  assert.deepEqual(wrapped.map((m) => m[2].replace(/\x1b\[[0-9:;]*m/g, "")), ["log", "dashboard", "events"]);
  assert.equal(line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9:;]*m/g, ""), "┊   log · dashboard · events …");
});

// ── the pure pieces ──
test("bar: value 0 · 0.42 · 1 · NaN · −1 · 2 → 0 / 8-of-20 / 20 / dropped / clamped", () => {
  assert.equal(bar(0, 20), "▱".repeat(20));
  assert.equal(bar(0.42, 20), "▰".repeat(8) + "▱".repeat(12));
  assert.equal(bar(1, 20), "▰".repeat(20));
  assert.equal(bar(-1, 20), "▱".repeat(20));
  assert.equal(bar(2, 20), "▰".repeat(20));
  assert.equal(bar(0.42, 10), "▰▰▰▰▱▱▱▱▱▱");
  assert.equal(bar(0.43, 20), "▰".repeat(9) + "▱".repeat(11));   // nearest cell, not floor
  const nan = sectionLines(bgData([row("p", { body: { progress: { value: NaN, label: "x" }, stats: [{ label: "a", value: "1" }] } })]), 80, plain, false);
  assert.deepEqual(nan.slice(2), ["┊   a 1"]);
  const inf = sectionLines(bgData([row("p", { body: { progress: { value: Infinity } } })]), 80, plain, false);
  assert.equal(inf.length, 2);
  assert.equal(sectionLines(bgData([row("p", { body: { progress: { value: -1 } } })]), 80, plain, false)[2], `┊   ${"▱".repeat(20)} 0%`);
  assert.equal(sectionLines(bgData([row("p", { body: { progress: { value: 2 } } })]), 80, plain, false)[2], `┊   ${"▰".repeat(20)} 100%`);
});

test("sparkline (§1.2 revised): lo = max(0, 0.9·min) · hi = max — jitter has shape, a held rate is not a solid bar; flat → all █ (all ▁ at 0); a negative point → plain min…max; ▁ stays reserved for 0", () => {
  assert.equal(sparkline([5], 60), "█");
  assert.equal(sparkline([0, 50, 100], 60), "▁▅█");
  assert.equal(sparkline(Array.from({ length: 60 }, (_, i) => i), 60).length, 60);
  const two = sparkline(Array.from({ length: 200 }, (_, i) => i), 60);
  assert.equal(two.length, 60);
  assert.equal(two[0], sparkline([140, 199], 60)[0]);        // the oldest kept point is #140 → same cell as in a 140..199 series
  assert.equal(sparkline([42, 42, 42], 60), "███");           // flat-high, never a division by zero
  assert.equal(sparkline([0, 0, 0], 60), "▁▁▁");              // max = 0 → all ▁
  assert.equal(sparkline([0.001, 100], 60), "▂█");            // a live rate never looks dead
  assert.equal(sparkline([-10, 0, 10], 60), "▁▅█");           // a negative point → min…max
  assert.equal(sparkline([-5, -5], 60), "██");                 // flat is held, whatever the sign; only a flat 0 is ▁
  assert.equal(sparkline([], 60), "");
  assert.equal(sparkline([1, 2, 3, 4, 5], 3), "▂▅█");          // n caps the glyphs, newest kept
  // a held rate with ±3 % jitter is NOT one solid cell (the tester saw 60×█ under the ▰▱ bar and read a second progress bar)
  const jitter = sparkline(Array.from({ length: 60 }, (_, i) => 290 + Math.round(10 * Math.sin(i / 3))), 60);
  assert.ok(new Set(jitter).size >= 3, jitter);
  assert.equal(sparkline([300, 300, 240, 300], 60), "██▃█");   // a 20 % dip drops to about a third
  const collapse = sparkline([...Array(59).fill(300), 0], 60);
  assert.equal(collapse.at(-1), "▁"); assert.equal(collapse.slice(0, 59), "█".repeat(59));   // a collapse to 0 pulls lo to 0
});

test("fmtNum: |v| ≥ 100 rounds, else one decimal with .0 stripped", () => {
  assert.equal(fmtNum(298.4), "298"); assert.equal(fmtNum(412), "412"); assert.equal(fmtNum(99.96), "100");
  assert.equal(fmtNum(39.96), "40"); assert.equal(fmtNum(0.84), "0.8"); assert.equal(fmtNum(0), "0"); assert.equal(fmtNum(5.0), "5"); assert.equal(fmtNum(-3.26), "-3.3");
});

// ── fold ──
test("fold line gains `name 42% · first stat` per bodied row in rank order and cuts at width; series/links fold to nothing", () => {
  const rows = [row("pr73061_ci"), row("k6_burst", { body }), row("del", { body: { stats: [{ label: "ok", value: "1,190" }, { label: "404", value: "9" }] } }), row("quiet", { body: { links: body.links } })];
  const [line, ...rest] = sectionLines(bgData(rows), 120, plain, true);
  assert.equal(line, "┊ ● bg · 4 jobs · 4 working · k6_burst 42% · rps 298 · del · ok 1,190");
  assert.deepEqual(rest, []);
  const [tagged1] = sectionLines(bgData(rows.slice(0, 2)), 120, tagged, true);
  assert.equal(tagged1, `<dim>┊ </dim><success>●</success> <dim>bg</dim><text> · 2 jobs</text><dim> · 2 working</dim><dim> · </dim><text>k6_burst 42%</text><dim> · rps </dim><text>298</text>`);
  const narrow = sectionLines(bgData(rows), 50, plain, true);
  assert.equal(narrow.length, 1);
  assert.equal(displayWidth(narrow[0]), 50);
  assert.ok(narrow[0].endsWith("…"), narrow[0]);
  // an owed row still gets its own line under the summary (existing rule); its body does not
  const owed = { ...row("owed", { body }), state: "waiting", waiting: { on: "you", why: "merge?", sinceMs: 95_000 }, detail: "waiting on YOU · merge?" };
  const withOwed = sectionLines(bgData([owed, row("k6", { body })]), 120, plain, true);
  assert.equal(withOwed.length, 2);
  assert.match(withOwed[0], /^┊ ⏳ bg · 2 jobs · you owe 1 · 1 waiting on YOU · 1 working · owed 42% · rps 298 · k6 42% · rps 298$/);
  assert.match(withOwed[1], /^┊ ⏳ owed bg · waiting on YOU/);
});

test("fold keeps stale visible: a stale body's numbers go dim and the appendix says ` · stale`; a fresh one is byte-different (reviewer: a dead writer must not fold into live-looking numbers)", () => {
  const live = { progress: { value: 0.5, label: "L" }, stats: [{ label: "rps", value: "40" }] };
  const fresh = row("k6", { body: live }), stale = row("k6", { body: { ...live, stale: true }, detail: "running · stale 45s" });
  assert.equal(sectionLines(bgData([fresh]), 120, plain, true)[0], "┊ ● bg · 1 job · 1 working · k6 50% · rps 40");
  assert.equal(sectionLines(bgData([stale]), 120, plain, true)[0], "┊ ● bg · 1 job · 1 working · k6 50% · rps 40 · stale");
  const [t] = sectionLines(bgData([stale]), 120, tagged, true);
  assert.equal(t, `<dim>┊ </dim><success>●</success> <dim>bg</dim><text> · 1 job</text><dim> · 1 working</dim><dim> · </dim><dim>k6 50%</dim><dim> · rps </dim><dim>40</dim><dim> · </dim><text>stale</text>`);
  // only the stale row's appendix changes; a fresh neighbour keeps text tone, and the marker sits on the stale one
  const [mixed] = sectionLines(bgData([row("a", { body: live }), { ...stale, name: "b" }]), 200, tagged, true);   // 200: the fixture's tags count as width
  assert.ok(mixed.includes("<text>a 50%</text><dim> · rps </dim><text>40</text><dim> · </dim><dim>b 50%</dim><dim> · rps </dim><dim>40</dim><dim> · </dim><text>stale</text>"), mixed);
  // the marker is part of the appendix: it is cut with the rest at width, never overflows
  const narrow = sectionLines(bgData([stale]), 40, plain, true)[0];
  assert.equal(displayWidth(narrow), 40); assert.ok(narrow.endsWith("…"), narrow);
});
