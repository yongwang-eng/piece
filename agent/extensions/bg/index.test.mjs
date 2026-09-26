import assert from "node:assert/strict";
import test from "node:test";
import { doneMessage, fmtDur, listText, tail, widgetLines } from "./format.ts";

test("tail keeps the last N lines and drops trailing newlines", () => {
  assert.equal(tail("a\nb\nc\n\n", 2), "b\nc");
  assert.equal(tail("only", 5), "only");
});

test("fmtDur reads like a person wrote it", () => {
  assert.equal(fmtDur(7_000), "7s");
  assert.equal(fmtDur(432_000), "7m12s");
  assert.equal(fmtDur(-5), "0s");
});

const job = { name: "ci", command: "x", pid: 42, log: "/tmp/pi-bg/ci.log", started: Date.now() - 125_000, notify: true };

test("doneMessage names the job, the outcome and the log, then the tail in a fence", () => {
  const m = doneMessage({ ...job, exit: 0 }, "l1\nl2\n", job.started + 125_000);
  assert.match(m, /^\[bg ci\] exit 0 · 2m05s · \/tmp\/pi-bg\/ci\.log\n```\nl1\nl2\n```$/);
  assert.match(doneMessage({ ...job, exit: null, signal: "SIGTERM" }, ""), /killed \(SIGTERM\)[\s\S]*\(no output\)/);
  assert.match(doneMessage({ ...job, timedOut: true, exit: null, signal: "SIGTERM" }, ""), /^\[bg ci\] timed out/);
});

test("listText shows running vs finished", () => {
  const t = listText([{ ...job }, { ...job, name: "build", exit: 1 }]);
  assert.match(t, /ci\s+42\s+running 2m05s/);
  assert.match(t, /build\s+42\s+exit 1/);
  assert.equal(listText([]), "no bg jobs this session");
});

test("rowFor: a job speaks the board grammar — running is live with the last log line, exit 0 is done, a failure is alert; the log is the link", async () => {
  const { rowFor } = await import("./format.ts");
  const now = Date.now();
  const live = rowFor({ ...job }, "00:45Z 71255=OPEN\n", now);
  assert.equal(live.state, "working"); assert.equal(live.name, "ci"); assert.equal(live.pane, "bg"); assert.equal(live.detail, "00:45Z 71255=OPEN");
  assert.equal(live.url, `file://${job.log}`); assert.equal(live.ageMs, now - job.started);
  assert.equal(rowFor({ ...job, exit: 0 }, "", now).state, "done");
  const failed = rowFor({ ...job, exit: 1 }, "boom", now);
  assert.equal(failed.state, "gone"); assert.match(failed.detail, /exit 1/);
  assert.match(rowFor({ ...job, timedOut: true, signal: "SIGTERM" }, "", now).detail, /timed out/);
});

test("widgetLines shows only running jobs, with the last log line, fitted to width", () => {
  const now = Date.now();
  const lines = widgetLines([{ ...job }, { ...job, name: "done", exit: 0 }], (j) => (j.name === "ci" ? "00:45Z 71255=OPEN\n" : ""), 60, now);
  assert.equal(lines.length, 2, lines.join("|"));
  assert.equal(lines[0], "bg · 1 job");
  assert.equal(lines[1], "● ci bg · 00:45Z 71255=OPEN · 2m05");
  assert.ok(widgetLines([{ ...job }], () => "x".repeat(100), 30, now).every((l) => l.length <= 30));
  assert.deepEqual(widgetLines([{ ...job, exit: 0 }], () => "", 80, now), []);
});
