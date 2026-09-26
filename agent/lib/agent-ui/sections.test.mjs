import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { compose, boardOf, hostBoard, orderOf, ORDER, switchOff } from "./sections.ts";

const sec = (id) => ({ id, render: () => [id] });
const theme = { fg: (_t, s) => s, bold: (s) => s };
// the shape of pi.events: on() returns an unsubscribe
const bus = () => { const e = new EventEmitter(); return { events: { on: (n, f) => { e.on(n, f); return () => e.off(n, f); }, emit: (n, p) => e.emit(n, p) } }; };

test("compose renders sections in ORDER, whatever order they arrived or last repainted in", () => {
  const m = new Map();
  const put = (id) => m.set(id, sec(id));
  put("crew-board"); put("devin"); put("bg");           // crew arrives first
  assert.deepEqual(compose(m.values(), 80, theme), ["bg", "", "devin", "", "crew-board"]);
  m.delete("bg"); put("bg");                            // bg repaints — delete + re-insert is exactly what pi's setWidget does
  assert.deepEqual(compose(m.values(), 80, theme), ["bg", "", "devin", "", "crew-board"]);
});

test("an unlisted producer lands after the known ones; a throwing render drops itself, not the board", () => {
  assert.equal(orderOf("loadtest"), 50);
  assert.ok(orderOf("loadtest") > ORDER["crew-board"]);
  const s = [sec("loadtest"), { id: "bg", render: () => { throw new Error("boom"); } }, sec("crew")];
  assert.deepEqual(compose(s, 80, theme), ["crew", "", "loadtest"]);
});

test("sections are separated by one blank line so their gutters read as distinct blocks; an empty section adds no gap", () => {
  assert.deepEqual(compose([sec("bg"), { id: "devin", render: () => [] }, sec("crew-board")], 80, theme), ["bg", "", "crew-board"]);
  assert.deepEqual(compose([sec("bg")], 80, theme), ["bg"]);
});

test("a producer that published before the host loaded is seen once the host is ready", () => {
  const pi = bus();
  const board = boardOf(pi);
  board.section(sec("bg"));                             // host not listening yet
  let seen = [];
  const host = hostBoard(pi, (all) => { seen = all.map((s) => s.id); });
  assert.deepEqual(seen, []);
  host.ready();
  assert.deepEqual(seen, ["bg"]);
  board.section(sec("crew")); board.remove("bg");
  assert.deepEqual(seen, ["crew"]);
  host.dispose();
  board.section(sec("devin"));
  assert.deepEqual(seen, ["crew"]);                     // a disposed host hears nothing
});

// ── data sections, fold, per-section off ──
const dataSec = (id, rows = [{ name: "j", pane: "bg", state: "working", detail: "d", ageMs: 1000 }]) => ({ id, data: { title: id, noun: "job", hint: "x", rows } });

test("a data section renders through sectionLines with the host's folded flag; a render section still gets (width, theme)", () => {
  const seen = [];
  const s = [dataSec("bg"), { id: "crew-board", render: (w, t) => { seen.push([w, t]); return ["crew"]; } }];
  const out = compose(s, 80, theme, { folded: false });
  assert.deepEqual(out, ["┊ bg · 1 job", "┊ ● j bg · d · 1s", "", "crew"]);
  assert.deepEqual(seen, [[80, theme]]);
  assert.deepEqual(compose(s, 80, theme, { folded: true }), ["┊ ● bg · 1 job · 1 working", "", "crew"]);
});

test("hostBoard retains a data section (not only render) and drops on {id}", () => {
  const pi = bus();
  const board = boardOf(pi);
  let seen = [];
  const host = hostBoard(pi, (all) => { seen = all.map((s) => s.id); });
  host.ready();
  board.section(dataSec("bg"));
  assert.deepEqual(seen, ["bg"]);
  board.remove("bg");
  assert.deepEqual(seen, []);
  host.dispose();
});

test("off filters compose; the tell line appears only when off ∩ published ≠ ∅, last, naming the ids", () => {
  const s = [dataSec("bg"), dataSec("devin"), sec("crew-board")];
  assert.deepEqual(compose(s, 80, theme, { off: new Set(["todo"]) }).at(-1), "crew-board");            // off but unpublished → no tell
  const one = compose(s, 80, theme, { off: new Set(["bg"]) });
  assert.deepEqual(one, ["┊ devin · 1 job", "┊ ● j bg · d · 1s", "", "crew-board", "┊ off: bg — /board on bg"]);
  const two = compose(s, 80, theme, { off: new Set(["bg", "devin", "todo"]) });
  assert.deepEqual(two, ["crew-board", "┊ off: bg · devin — /board on <id>"]);
  assert.deepEqual(compose([], 80, theme, { off: new Set(["bg"]) }), []);                               // nothing published → nothing at all
  assert.ok(compose(s, 20, theme, { off: new Set(["bg", "devin"]) }).at(-1).length <= 20);
});

test("switchOff: on / off / only with exact-then-prefix ids over ORDER ∪ published; unknown id is refused", () => {
  const published = ["bg", "devin", "crew-board", "loadtest"];
  let off = new Set();
  let r = switchOff(off, "off", "crew", published);
  assert.deepEqual([...r.off], ["crew-board"]); assert.equal(r.ok, true);
  r = switchOff(r.off, "off", "load", published);
  assert.deepEqual([...r.off].sort(), ["crew-board", "loadtest"]);
  r = switchOff(r.off, "on", "crew-board", published);
  assert.deepEqual([...r.off], ["loadtest"]);
  r = switchOff(r.off, "only", "bg", published);
  assert.deepEqual([...r.off].sort(), ["compaction", "crew-board", "devin", "loadtest", "todo"]);   // every known-or-published id but bg
  r = switchOff(r.off, "on", undefined, published);
  assert.deepEqual([...r.off], []);                                                  // bare `on` = everything on
  r = switchOff(new Set(["bg"]), "off", "nope", published);
  assert.equal(r.ok, false); assert.deepEqual([...r.off], ["bg"]); assert.match(r.message, /nope/);
  assert.equal(switchOff(new Set(), "off", undefined, published).ok, false);           // off needs an id
  assert.equal(switchOff(new Set(), "off", "t", published).ok, true);                  // prefix of an ORDER id that is not published yet
});

test("compose: the compaction row is a section that stays put — before bg, after todo — however often it re-publishes", () => {
  const pal = { fg: (_t, s) => s, bold: (s) => s };
  const row = (id, txt) => ({ id, render: () => [txt] });
  const bg = { id: "bg", data: { title: "bg", noun: "job", hint: "bg_list", rows: [{ name: "job", pane: "bg", state: "working", detail: "x", ageMs: 1 }] } };
  const first = compose([bg, row("compaction", "⟳ compacting · 5s")], 80, pal);
  const later = compose([row("compaction", "⟳ compacting · 10s"), bg], 80, pal);   // re-published, arrives first this time
  assert.equal(first[0], "⟳ compacting · 5s");
  assert.equal(later[0], "⟳ compacting · 10s");
  assert.ok(orderOf("todo") < orderOf("compaction") && orderOf("compaction") < orderOf("bg"));
});
