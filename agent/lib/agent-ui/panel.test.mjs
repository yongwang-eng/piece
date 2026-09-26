import { test } from "node:test";
import assert from "node:assert/strict";
import { pageOf, frame } from "./panel.ts";

const fg = (_t, x) => x;
const strip = (s) => s.replace(/\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

test("pageOf: box = content height up to the cap; past the cap it scrolls at a constant height", () => {
  const all = Array.from({ length: 10 }, (_, i) => `l${i}`);
  assert.deepEqual(pageOf(all, 0, 4), { slice: ["l0", "l1", "l2", "l3"], offset: 0, pos: " 1–4/10" });
  assert.equal(pageOf(all, 99, 4).offset, 6);                 // clamp to last page
  assert.equal(pageOf(all, -5, 4).offset, 0);
  assert.deepEqual(pageOf(all, 8, 4).slice, ["l6", "l7", "l8", "l9"]);
  const short = pageOf(["a", "b"], 0, 4);
  assert.deepEqual(short.slice, ["a", "b"]);                    // 2 lines → a 2-line box, not a 4-line one
  assert.equal(short.pos, "");                                  // nothing to scroll → no position
  assert.equal(pageOf(all, 3, 4).slice.length, 4);              // scrolling: height stays 4 at every offset
  assert.equal(pageOf(all, 6, 4).slice.length, 4);
});

test("frame: constant width, right border aligned even with ANSI in the line, footer names the keys", () => {
  const lines = frame(["\x1b[31mred\x1b[0m", "plain"], " 1–2/9", 20, fg);
  assert.equal(lines[0], "╭" + "─".repeat(18) + "╮");
  assert.equal(lines.at(-2), "╰" + "─".repeat(18) + "╯");
  for (const l of lines.slice(1, -2)) assert.equal(strip(l).length, 20, strip(l));
  assert.match(lines.at(-1), /↑↓ scroll 1–2\/9 · esc\/q close/);
  assert.equal(strip(lines[1]), "│ red" + " ".repeat(14) + "│");
});

test("frame truncates a line wider than the box instead of breaking the border — styled lines too", () => {
  const lines = frame(["x".repeat(50), "\x1b[31m" + "y".repeat(50) + "\x1b[39m"], "", 20, fg);
  assert.equal(strip(lines[1]).length, 20);
  assert.equal(strip(lines[2]).length, 20);
  assert.doesNotMatch(strip(lines[2]), /\[/);                    // no escape fragments leaked as text
});
