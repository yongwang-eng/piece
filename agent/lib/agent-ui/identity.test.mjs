import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, paneTitle, footerParts, paneBorderStyle, paneBorderFormat, handle, PALETTE, ATTENTION, INK_DARK } from "./identity.ts";

test("colour is stable per #N and never red; falls back to a name hash before an id exists", () => {
  assert.equal(colorFor(1), PALETTE[0]);
  assert.equal(colorFor(7), PALETTE[0], "wraps");
  assert.equal(colorFor(2), colorFor(2));
  assert.notEqual(colorFor(2), colorFor(3));
  assert.ok(!PALETTE.includes(ATTENTION), "red is reserved for attention");
  assert.equal(colorFor(undefined, "spies"), colorFor(undefined, "spies"));
});

test("pane title leads with glyph + handle; shows presence only when it is news", () => {
  assert.equal(paneTitle({ id: 2, name: "beta", role: "reviewer", presence: "working" }), "● #2 beta · reviewer");
  assert.equal(paneTitle({ id: 1, name: "implementer", role: "implementer", presence: "working" }), "● #1 implementer", "role = name → said once (D45)");
  assert.equal(paneTitle({ id: 3, name: "doc-owner", role: "doc owner", presence: "idle" }), "○ #3 doc-owner", "role that slugs to the name → said once");
  assert.equal(paneTitle({ id: 2, name: "beta", role: "reviewer", presence: "blocked" }), "◆ #2 beta · reviewer · blocked");
  assert.equal(paneTitle({ name: "w1", presence: "idle" }), "○ w1");
  assert.equal(handle({ id: 3, name: "spies" }), "#3 spies");
});

test("footer parts: main's footer shape — handle · model(short) · context · cost · turns · uptime; empties dropped; no role/run/tools", () => {
  assert.deepEqual(footerParts({ id: 2, name: "beta", role: "reviewer", run: "crew-x", model: "openai-codex/gpt-6-astra", tools: 3, elapsedText: "4m02", contextText: "▓░ 18% (181k/1M)", costText: "$1.20", turns: 7 }),
    ["#2 beta", "gpt-6-astra", "▓░ 18% (181k/1M)", "$1.20", "7 turns", "↑ 4m02"]);
  assert.deepEqual(footerParts({ name: "w1", turns: 1 }), ["w1", "1 turn"]);
});

test("border format: the worker's TAB is a highlighted block in its colour, red when it needs attention", () => {
  assert.equal(paneBorderFormat({ id: 1, name: "a", presence: "working" }), `#[fg=${INK_DARK},bg=${PALETTE[0]},bold] #{pane_title} #[default]`);
  assert.equal(paneBorderFormat({ id: 1, name: "a", presence: "blocked" }), `#[fg=${INK_DARK},bg=${ATTENTION},bold] #{pane_title} #[default]`);
});

test("border style: worker colour normally, attention red when blocked/stalled", () => {
  assert.equal(paneBorderStyle({ id: 1, name: "a", presence: "working" }), `fg=${PALETTE[0]}`);
  assert.equal(paneBorderStyle({ id: 1, name: "a", presence: "stalled" }), `fg=${ATTENTION}`);
  assert.equal(paneBorderStyle({ id: 1, name: "a", presence: "blocked" }), `fg=${ATTENTION}`);
});

test("themeVars reads the active theme once and resolves tone→var→hex; decorations derive from it, not from numbers", async () => {
  const { themeVars, mix, linkUnderline, hexFg } = await import("./identity.ts");
  const v = themeVars();
  assert.match(v.canvas, /^#[0-9a-f]{6}$/i); assert.match(v.quiet, /^#[0-9a-f]{6}$/i); assert.match(v.accent, /^#[0-9a-f]{6}$/i);
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#14191e", "#14191e", 0.3), "#14191e");
  // the underline sits between the canvas and the quiet/accent midpoint: visible, never louder than dim text
  assert.equal(linkUnderline(), mix(v.canvas, mix(v.quiet, v.accent, 0.5), 0.5));
  assert.equal(hexFg("x", "#ff0000"), "\x1b[38;2;255;0;0mx\x1b[39m");
});

test("every hard-coded colour our extensions paint lives in identity.ts — a hex anywhere else is a defect", async () => {
  const { execSync } = await import("node:child_process");
  const out = execSync(`rg -n "#[0-9a-fA-F]{6}\\\\b|58;2;|38;2;" extensions lib --type ts -g '!*.test.*' -g '!lib/agent-ui/identity.ts' || true`, { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" });
  const offenders = out.split("\n").filter((l) => l && !/:\s*(\/\/|\*|\/\*\*)/.test(l) && !/\/\/.*#[0-9a-fA-F]{6}\b/.test(l.split(/[:]\d+:/)[1] ?? l));
  assert.deepEqual(offenders, [], out);
});
