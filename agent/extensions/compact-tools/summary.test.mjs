import assert from "node:assert/strict";
import { firstLine, formatDuration, formatElapsed, lineCount, summarize } from "./summary.ts";

assert.equal(lineCount("one\ntwo\n"), 2);
assert.equal(firstLine("first\nsecond"), "first");
assert.deepEqual(summarize("read", { path: "notes.md" }, "a\nb\n"), "2 lines");
assert.deepEqual(summarize("bash", {}, "ok\n"), "done");
assert.deepEqual(summarize("edit", { edits: [{}, {}] }, ""), "2 edits applied");
assert.deepEqual(summarize("write", { content: "a\nb" }, ""), "2 lines written");
assert.equal(formatElapsed(0), "0s");
assert.equal(formatElapsed(12_900), "12s");
assert.equal(formatElapsed(65_000), "1m 05s");
assert.equal(formatDuration(340), "0.3s");
assert.equal(formatDuration(6_040), "6.0s");
assert.equal(formatDuration(12_400), "12s");
assert.equal(formatDuration(75_000), "1m 15s");

console.log("compact-tools summaries: PASS");
