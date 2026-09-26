import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth, fit } from "./width.ts";

test("display width counts CJK/emoji as 2 columns and combining marks as 0", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("é\u0301"), 1);
  assert.equal(displayWidth("\u001b[31mred\u001b[0m"), 3, "ANSI escapes take no columns");
});

test("fit never exceeds the budget, for wide glyphs too", () => {
  assert.equal(displayWidth(fit("a".repeat(40), 10)), 10);
  assert.ok(displayWidth(fit("日本語日本語", 7)) <= 7);
  assert.equal(fit("short", 10), "short     ", "fit pads to exactly `width` — callers rely on fixed-width columns");
});

test("displayWidth: an OSC 8 hyperlink costs only its label", async () => {
  const { displayWidth } = await import("./width.ts");
  const link = "\x1b]8;;https://example.com/very/long/url\x1b\\label\x1b]8;;\x1b\\";
  assert.equal(displayWidth(link), 5);
  assert.equal(displayWidth("\x1b[31m" + link + "\x1b[39m"), 5);
});

test("cutStyled: keeps escapes intact, counts only glyphs, closes colour + link at the cut", async () => {
  const { cutStyled, displayWidth } = await import("./width.ts");
  const line = "\x1b[31mred \x1b]8;;https://x\x1b\\label\x1b]8;;\x1b\\ tail\x1b[39m";
  assert.equal(cutStyled(line, 40), line);                       // fits → untouched
  const c = cutStyled(line, 6);
  assert.equal(displayWidth(c), 6);
  assert.ok(c.startsWith("\x1b[31mred \x1b]8;;https://x\x1b\\l"), JSON.stringify(c));
  assert.ok(c.endsWith("…\x1b]8;;\x1b\\\x1b[0m"), JSON.stringify(c));  // link closed, style reset
  assert.doesNotMatch(c.replace(/\x1b\][^\x1b]*\x1b\\|\x1b\[[0-9;:]*m/g, ""), /[\[\]];/);  // no fragments
});

test("displayWidth: emoji-presentation glyphs outside the CJK/emoji blocks (⏳ ⌚ ⏩) are 2 columns", async () => {
  const { displayWidth } = await import("./width.ts");
  assert.equal(displayWidth("⏳"), 2);
  assert.equal(displayWidth("⌚⏩"), 4);
  assert.equal(displayWidth("◆ ○ ✓ ⚙"), 7);   // text-presentation symbols stay 1
});
