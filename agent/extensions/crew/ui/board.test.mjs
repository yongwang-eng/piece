import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, stateOf, isStalled, rowOf, rowText, boardLines, withWait, STALL_MS } from "./board.ts";
import { elapsed } from "../../../lib/agent-ui/time.ts";

const t0 = 1_000_000;
const w = { name: "spies", pane: "%184", profile: "reviewer", spawnedAt: new Date(t0).toISOString() };

test("observe keeps `since` while status is unchanged, resets on change, clears when absent", () => {
  const a = observe(undefined, "thinking", t0);
  assert.deepEqual(a, { status: "thinking", since: t0 });
  assert.equal(observe(a, "thinking", t0 + 30_000), a);
  assert.deepEqual(observe(a, "tool:bash", t0 + 31_000), { status: "tool:bash", since: t0 + 31_000 });
  assert.equal(observe(a, undefined, t0 + 32_000), undefined);
});

test("stall = thinking unchanged for STALL_MS; tool time never counts as a stall", () => {
  const th = { status: "thinking", since: t0 };
  assert.equal(isStalled(th, t0 + STALL_MS - 1), false);
  assert.equal(isStalled(th, t0 + STALL_MS), true);
  assert.equal(isStalled({ status: "tool:bash", since: t0 }, t0 + 10 * STALL_MS), false);
  assert.equal(stateOf(th, t0, t0 + STALL_MS), "stalled");
  assert.equal(stateOf(th, t0, t0 + 1000), "working");
  assert.equal(stateOf({ status: "idle", since: t0 }, t0, t0), "idle");
  assert.equal(stateOf({ status: "tool:read", since: t0 }, t0, t0), "tool");
});

test("absent presence is `starting` for 45s after spawn, then `gone`", () => {
  assert.equal(stateOf(undefined, t0, t0 + 10_000), "starting");
  assert.equal(stateOf(undefined, t0, t0 + 50_000), "gone");
});

test("row text keeps identity, cuts detail, fits width", () => {
  const r = rowOf(w, { status: "thinking", since: t0 }, t0 + 2 * STALL_MS);
  assert.equal(r.state, "stalled");
  const line = rowText(r, 60);
  assert.ok(line.length <= 60, line);
  assert.ok(line.startsWith("◆ spies %184"));
  assert.ok(line.includes("reviewer"));
  const narrow = rowText(r, 24);
  assert.ok(narrow.length <= 24 && narrow.startsWith("◆ spies %184"), narrow);
});

test("board: stalled rows first, overflow counted never dropped, empty when no workers", () => {
  const rows = [
    rowOf({ ...w, name: "a" }, { status: "idle", since: t0 }, t0),
    rowOf({ ...w, name: "b" }, { status: "thinking", since: t0 }, t0 + STALL_MS),
    rowOf({ ...w, name: "c" }, { status: "tool:bash", since: t0 }, t0),
    rowOf({ ...w, name: "d" }, { status: "thinking", since: t0 }, t0 + 1000),
  ];
  const lines = boardLines(rows, 80, 3);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /crew · 4 workers · 1 stalled/);
  assert.ok(lines[1].startsWith("◆ b"));
  assert.match(lines[4], /\+1 more/);
  assert.deepEqual(boardLines([], 80), []);
});

test("age formatting comes from the shared lib (fleet rows and crew rows must agree)", () => {
  assert.equal(elapsed(5000), "5s");
  assert.equal(elapsed(65_000), "1m05");
});

test("row shows #N when the worker has one", () => {
  const r = rowOf({ ...w, id: 3 }, { status: "idle", since: t0 }, t0);
  assert.ok(rowText(r, 60).startsWith("○ #3 spies %184"));
});

test("compacting stays visible and never stalls even after the wedged interval", () => {
  const p = { status: "compacting", since: t0 };
  const now = t0 + 700_000;
  assert.equal(stateOf(p, t0, now), "compacting");
  assert.equal(isStalled(p, now), false);
  const row = rowOf(w, p, now);
  assert.equal(row.detail, "compacting");
  assert.match(rowText(row, 80), /^◐ spies/);
});

test("stall threshold uses each worker median with a 120s floor", () => {
  const thinking = { status: "thinking", since: t0 };
  assert.equal(isStalled(thinking, t0 + 120_000, 50_000), false);
  assert.equal(isStalled(thinking, t0 + 199_999, 50_000), false);
  assert.equal(isStalled(thinking, t0 + 200_000, 50_000), true);
  assert.equal(stateOf(thinking, t0, t0 + 120_000, 50_000), "working");
  assert.equal(rowOf(w, thinking, t0 + 200_000, 50_000).state, "stalled");
  for (const median of [undefined, 0, 10_000, -1, NaN, Infinity]) {
    assert.equal(isStalled(thinking, t0 + 119_999, median), false);
    assert.equal(isStalled(thinking, t0 + 120_000, median), true);
  }
});

test('peer counters fit without displacing original row content', () => {
  const r = rowOf(w, {status:'idle',since:t0},t0);
  const communication = {status:'complete',counts:{sent:8,addressed:5}};
  assert.equal(rowText({...r,communication},100), rowText(r,100)+' · peer ↑8 ↓5');
  for (const width of [12,20,30]) assert.equal(rowText({...r,communication},width),rowText(r,width));
  assert.ok(rowText({...r,communication:{status:'unknown'}},100).endsWith(' · peer ?'));
});

test('a worker adopted after main reloads reads alive, never gone (Yong 2026-09-15: ✕ "not on intercom" on 4 live workers)', () => {
  const now = Date.now();
  const spawnedLongAgo = new Date(now - 12 * 3600_000).toISOString();
  const noStatus = rowOf({ name: 'historian', pane: '%362', spawnedAt: spawnedLongAgo }, undefined, now);
  assert.equal(noStatus.state, 'gone'); assert.equal(noStatus.detail, 'not in the room');
  const adopted = rowOf({ name: 'historian', pane: '%362', spawnedAt: spawnedLongAgo }, observe(undefined, 'reattached', now), now);
  assert.equal(adopted.state, 'idle'); assert.match(adopted.detail, /alive .* reattached/);
});

test("workflow board: rows sort by who is owed — you › governor › main › peer › stalled › working › done › idle", () => {
  const mk = (name, p, wait) => withWait(rowOf({ ...w, name }, p, t0 + 1000), wait);
  const rows = [
    mk("idle", { status: "idle", since: t0 }),
    mk("done", { status: "idle", since: t0 }, { on: undefined, why: "reported ✓", sinceMs: 5000, done: true }),
    mk("peer", { status: "idle", since: t0 }, { on: "reviewer", why: "query #12", sinceMs: 9000 }),
    mk("working", { status: "thinking", since: t0 }),
    mk("gov", { status: "idle", since: t0 }, { on: "governor", why: "c-gov-1-1", sinceMs: 1000 }),
    mk("stalled", { status: "thinking", since: t0 - 2 * STALL_MS }),
    mk("you", { status: "idle", since: t0 }, { on: "you", why: "c-you-2-1 commit", sinceMs: 4000 }),
    mk("main", { status: "idle", since: t0 }, { on: "main", why: "query #7", sinceMs: 2000 }),
  ];
  const lines = boardLines(rows, 100, 10, "crew_14");
  assert.equal(lines[0], "crew_14 · 8 workers · you owe 1 · 1 stalled");
  assert.deepEqual(lines.slice(1).map((l) => l.split(" ")[1]), ["you", "gov", "main", "peer", "stalled", "working", "done", "idle"]);
  assert.ok(lines[1].startsWith("⏳ you %184 · waiting on YOU · c-you-2-1 commit"), lines[1]);
  assert.ok(lines[2].startsWith("⚖ gov %184 · waiting on governor"), lines[2]);
  assert.ok(lines[4].startsWith("↩ peer %184 · waiting on reviewer · query #12 · 9s"), lines[4]);
  assert.ok(lines[7].startsWith("✓ done %184 · reported ✓"), lines[7]);
});

test("header without a run name stays `crew`; `you owe` only when someone waits on you", () => {
  const rows = [rowOf({ ...w, name: "a" }, { status: "idle", since: t0 }, t0)];
  assert.equal(boardLines(rows, 80)[0], "crew · 1 worker");
});

test("a `done` wait over a WORKING row is ignored: main steered it again and it is busy, not finished", () => {
  const r = withWait(rowOf({ ...w, name: "a" }, { status: "thinking", since: t0 }, t0), { on: undefined, why: "reported ✓", sinceMs: 1, done: true });
  assert.equal(r.state, "working");
});

// ── styled rows: three attention levels from a list, segments toned separately, name clickable when the row has a URL ──
const palette = { fg: (tone, s) => `<${tone}>${s}</${tone}>`, bold: (s) => `<b>${s}</b>`, link: (label, url) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` };

test("attentionOf: owed-to-you and stalled are alert; working and asked-main are live; idle/paused/done are quiet", async () => {
  const { attentionOf } = await import("./board.ts");
  const r = (state, waiting) => ({ name: "a", pane: "%1", state, detail: "", ageMs: 0, waiting });
  assert.equal(attentionOf(r("waiting", { on: "you", why: "", sinceMs: 0 })), "alert");
  assert.equal(attentionOf(r("stalled")), "alert");
  assert.equal(attentionOf(r("gone")), "alert");
  assert.equal(attentionOf(r("working")), "live");
  assert.equal(attentionOf(r("waiting", { on: "main", why: "", sinceMs: 0 })), "live");
  assert.equal(attentionOf(r("idle")), "quiet");
  assert.equal(attentionOf(r("done")), "quiet");
});

test("styledRow: a quiet row is all dim; a live row has a bold name and text detail; the glyph carries the state tone", async () => {
  const { styledRow } = await import("./board.ts");
  const idle = styledRow({ name: "historian", pane: "%3", state: "idle", detail: "idle", ageMs: 60_000 }, 80, palette);
  assert.ok(!idle.includes("<b>"), idle);
  assert.ok(idle.includes("<dim>○</dim>") && idle.includes("<muted>historian"), idle);
  const busy = styledRow({ name: "impl", pane: "%4", state: "working", detail: "thinking", ageMs: 5_000 }, 80, palette);
  assert.ok(busy.includes("<success>●</success>") && !busy.includes("<b>") && busy.includes("<text>thinking</text>"), busy);   // colour, not weight
  const owed = styledRow({ name: "rev", pane: "%5", state: "waiting", detail: "waiting on YOU · merge?", ageMs: 5_000, waiting: { on: "you", why: "merge?", sinceMs: 1000 } }, 80, palette);
  assert.ok(owed.includes("<error>⏳</error>") && owed.includes("<error>waiting on YOU · merge?</error>"), owed);
});

test("styledRow: the name becomes an OSC 8 link when the row has a url; a `#N` PR token links when prUrl is set; plain text is unchanged", async () => {
  const { styledRow, rowText } = await import("./board.ts");
  const r = { name: "sqs-kept", pane: "devin", state: "idle", detail: "paused · ok · PR #73061", ageMs: 1000, url: "https://app.devin.ai/sessions/abc", prUrl: "https://github.com/acme/app/pull/73061" };
  const s = styledRow(r, 120, palette);
  const { linkMark } = await import("./board.ts");
  assert.ok(s.includes(`\x1b]8;;https://app.devin.ai/sessions/abc\x1b\\${linkMark("sqs-kept")}\x1b]8;;\x1b\\`), s);   // the label carries our quiet dotted underline
  assert.ok(s.includes(`\x1b]8;;https://github.com/acme/app/pull/73061\x1b\\${linkMark("#73061")}\x1b]8;;\x1b\\`), s);
  assert.equal(rowText(r, 120).includes("\x1b"), false);
  const noLink = styledRow(r, 120, { fg: palette.fg, bold: palette.bold });   // no link() in the palette → plain label
  assert.equal(noLink.includes("\x1b]8"), false);
});

test("styledRow: truncation happens on the plain text first, so the escapes never count against the width", async () => {
  const { styledRow, rowText } = await import("./board.ts");
  const r = { name: "sqs-kept", pane: "devin", state: "working", detail: "x".repeat(200), ageMs: 1000, url: "https://app.devin.ai/sessions/abc" };
  const plain = rowText(r, 60);
  const styled = styledRow(r, 60, palette).replace(/<\/?[a-z]+>/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-?]*m/g, "");
  assert.equal(styled, plain);
});

test("boardStyled: header has a bold section name and dim count; rows keep the plain order", async () => {
  const { boardStyled } = await import("./board.ts");
  const rows = [{ name: "a", pane: "%1", state: "idle", detail: "idle", ageMs: 0 }, { name: "b", pane: "%2", state: "working", detail: "thinking", ageMs: 0 }];
  const lines = boardStyled(rows, 80, 3, "devin", palette);
  assert.ok(lines[0].startsWith("<dim>devin</dim><text> · 2 workers</text>"), lines[0]);   // the title is a label; the count is the information
  assert.ok(lines[1].includes("●") && lines[2].includes("○"));
});

test("boardSummary: a section folds to ONE row in the grammar — glyph of its loudest row, counts by state; owed rows stay listed under it", async () => {
  const { boardSummary } = await import("./board.ts");
  const rows = [
    { name: "a", pane: "%1", state: "idle", detail: "idle", ageMs: 0 },
    { name: "b", pane: "%2", state: "working", detail: "thinking", ageMs: 0 },
    { name: "c", pane: "%3", state: "working", detail: "thinking", ageMs: 0 },
  ];
  const plain = boardSummary(rows, 80, "devin", undefined, { noun: "session" });
  assert.deepEqual(plain, ["● devin · 3 sessions · 2 working · 1 idle"]);
  const owed = [...rows, { name: "d", pane: "%4", state: "waiting", detail: "waiting on YOU · merge?", ageMs: 0, waiting: { on: "you", why: "merge?", sinceMs: 1000 } }];
  const lines = boardSummary(owed, 80, "crew", undefined);
  assert.equal(lines.length, 2, lines.join("|"));
  assert.ok(lines[0].startsWith("⏳ crew · 4 workers · you owe 1 · "), lines[0]);
  assert.ok(lines[1].startsWith("⏳ d %4 · waiting on YOU · merge?"), lines[1]);
  const styled = boardSummary(rows, 80, "devin", palette, { noun: "session" });
  assert.ok(styled[0].startsWith("<success>●</success> <dim>devin</dim><text> · 3 sessions"), styled[0]);
  assert.deepEqual(boardSummary([], 80, "bg", undefined), []);
});
