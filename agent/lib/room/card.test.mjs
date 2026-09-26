import { test } from "node:test";
import assert from "node:assert/strict";
import { card, renderPlain, kindLabel, shortRef, stamp } from "./card.ts";

const base = { id: "beta-8f0a46", run: "r", at: "2026-09-10T20:51:07Z", from: "beta", to: ["main"], kind: "inform", text: "Alpha answered both.\nCited §8, §9.", seq: 43 };

test("card: who · role ▸ kind on the left, #seq · hh:mm on the right; body verbatim; no ids, no run, no reply syntax, no expand hint", () => {
  const c = card({ env: base, senderRole: "reviewer", me: "main", width: 80 });
  assert.equal(c.header.left, "beta · reviewer ▸ inform");
  assert.match(c.header.right, /^#43 · \d\d:\d\d$/);
  assert.deepEqual(c.body, ["Alpha answered both.", "Cited §8, §9."]);
  assert.equal(c.guidance, undefined, "an inform asks nothing");
  const text = renderPlain(c, 80).join("\n");
  for (const forbidden of ["beta-8f0a46", "ctrl", "Ctrl", "expand", "replyTo", "intercom(", "→ main", "run"]) assert.ok(!text.includes(forbidden), `card must not contain "${forbidden}"`);
});

test("addressee shown only when it is not me; cites on their own dim line", () => {
  const c = card({ env: { ...base, to: ["alpha"], cc: ["main"], cites: ["design/x.md §8", "§9"] }, me: "main", width: 80 });
  assert.equal(c.header.left, "beta ▸ inform → alpha");
  assert.equal(c.cites, "cites design/x.md §8 · §9");
});

test("a request/query TO ME carries one guidance line naming the kind and the seq; a result carries `re`", () => {
  const q = card({ env: { ...base, kind: "query", to: ["main"] }, me: "main", width: 80 });
  assert.equal(q.header.tone, "ask");
  assert.equal(q.guidance, "reply `inform` re #43 (cite file:line) — or `refuse` if outside your responsibility");
  const r = card({ env: { ...base, kind: "result", re: "beta-8f0a46" }, me: "main", width: 80 });
  assert.equal(r.header.left, "beta ▸ result · re #8f0a46");
  assert.equal(r.header.tone, "closure");
  assert.equal(r.guidance, undefined);
  const qOther = card({ env: { ...base, kind: "query", to: ["alpha"], cc: ["main"] }, me: "main", width: 80 });
  assert.equal(qOther.guidance, undefined, "a query to someone else asks nothing of me");
});

test("end-of-turn report renders as ▸ done · N tools · elapsed; aborted is an error tone", () => {
  const d = card({ env: { ...base, report: "done", tools: 3, elapsedText: "41s" }, senderRole: "reviewer", me: "main", width: 80 });
  assert.equal(d.header.left, "beta · reviewer ▸ done · 3 tools · 41s");
  assert.equal(d.header.tone, "closure");
  const a = card({ env: { ...base, kind: "error", report: "aborted", tools: 7 }, me: "main", width: 80 });
  assert.equal(a.header.left, "beta ▸ aborted · 7 tools");
  assert.equal(a.header.tone, "error");
});

test("shortRef keeps consult ids and numbers, shortens uuid-ish ids", () => {
  assert.equal(shortRef("c-beta-2"), "c-beta-2");
  assert.equal(shortRef("47"), "47");
  assert.equal(shortRef("beta-8f0a46"), "8f0a46");
  assert.equal(kindLabel({ ...base, kind: "result", re: "c-probe-3" }), "result · re #c-probe-3");
});

test("outlined card: title cut into the top rule, body inset, every row exactly `width`, long lines wrap, dim border carries no meaning", () => {
  const c = card({ env: { ...base, text: "x ".repeat(60).trim(), cites: ["§8"] }, senderRole: "reviewer", me: "main", width: 0 });
  const lines = renderPlain(c, 60);
  assert.match(lines[0], /^╭ ✉ beta · reviewer ▸ inform · #43 · \d\d:\d\d ─+╮$/, lines[0]);
  assert.equal(lines.at(-1), "╰" + "─".repeat(58) + "╯");
  for (const l of lines) assert.equal([...l].length, 60, `row width: ${JSON.stringify(l)}`);
  assert.ok(lines.length > 4, "the 120-char body wrapped");
  assert.ok(lines.slice(1, -1).every((l) => l.startsWith("│  ") && l.endsWith(" │")), "rows are inset two spaces inside the border");
  assert.ok(lines.some((l) => l.includes("│  cites §8")));
});

test("worker-originated envelopes have no seq: caption shows the time alone, never '# · '", () => {
  const { seq, ...noSeq } = base;
  const c = card({ env: noSeq, me: "main", width: 0 });
  assert.match(c.header.right, /^\d\d:\d\d$/);
});

test("stamps: ❓ asks · ✉ tells · ✓ closes · ✗ refuses/errors · ✔ done", () => {
  assert.equal(stamp({ ...base, kind: "query" }), "❓");
  assert.equal(stamp({ ...base, kind: "request" }), "❓");
  assert.equal(stamp({ ...base, kind: "inform" }), "✉");
  assert.equal(stamp({ ...base, kind: "result" }), "✓");
  assert.equal(stamp({ ...base, kind: "refuse" }), "✗");
  assert.equal(stamp({ ...base, kind: "error", report: "aborted" }), "✗");
  assert.equal(stamp({ ...base, kind: "result", report: "done" }), "✔");
});

import { outlined, rosterRows, HEAVY, BOX } from "./card.ts";
const plainPaint = { border: (s) => s, stamp: (s) => s, sender: (s) => s, role: (s) => s, kind: (s) => s, dim: (s) => s };

test("card family: outlined() with HEAVY frame for consults/decisions, light for mail/roster; rows wrap; width exact", () => {
  const heavy = outlined("◆ consult · irreversible", 24, [{ text: "Action: commit — x" }, { text: "y ".repeat(50).trim() }], 60, plainPaint, HEAVY);
  assert.ok(heavy[0].startsWith("┏ ◆ consult · irreversible ━"), heavy[0]);
  assert.equal(heavy.at(-1), "┗" + "━".repeat(58) + "┛");
  for (const l of heavy) assert.equal([...l].length, 60, JSON.stringify(l));
  assert.ok(heavy.slice(1, -1).every((l) => l.startsWith("┃  ") && l.endsWith(" ┃")));
  const light = outlined("⌂ room · 2 members", 18, [{ text: "a" }], 40, plainPaint, BOX);
  assert.ok(light[0].startsWith("╭ ⌂ room") && light.at(-1).startsWith("╰"));
});

test("rosterRows: glyph · #N name · role (only if ≠ name) — owns…, truncated to width", () => {
  const rows = rosterRows([
    { name: "implementer", id: 11, role: "implementer", presence: "idle", responsibility: "Add a crew_list example to the description string of the crew_list tool in extensions/crew/index.ts and much more text here" },
    { name: "reviewer-2", id: 8, role: "reviewer", presence: "blocked", responsibility: "code review" },
  ], 80);
  assert.ok(rows[0].plain.startsWith("○ #11 implementer — Add a crew_list"), rows[0].plain);
  assert.ok(!rows[0].plain.includes("implementer · implementer"), "role = name said once");
  assert.ok(rows[0].plain.endsWith("…"), "long owns truncated");
  assert.equal(rows[1].plain, "◆ #8 reviewer-2 · reviewer — code review");
  for (const r of rows) assert.ok([...r.plain].length <= 80 - 6);
});
