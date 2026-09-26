import test from "node:test";
import assert from "node:assert/strict";
import { paneForPid, whereLabel } from "./where.ts";

// Jane's tmux: windows are named and numbered (`0:11 harness`); that pair is what he recognizes, never a pid or a session id.
const panes = [{ pane: "%28", pid: 18147 }, { pane: "%3", pid: 7521 }];
const parents = { 34668: 18147, 18147: 1, 99: 7521, 7521: 1, 5: 1 };
const parentOf = (pid) => parents[pid];

test("a pid resolves to the pane whose shell is its ancestor", () => {
  assert.equal(paneForPid(34668, panes, parentOf), "%28");
  assert.equal(paneForPid(99, panes, parentOf), "%3");
  assert.equal(paneForPid(18147, panes, parentOf), "%28", "the pane shell itself");
});

test("a pid outside every pane resolves to nothing, and a parent walk cannot loop forever", () => {
  assert.equal(paneForPid(5, panes, parentOf), undefined);
  assert.equal(paneForPid(7, panes, () => 7), undefined, "self-parent: bounded walk");
});

test("the label is '<index> <name>' resolved live, pid in parentheses, tmux session never shown; no tmux ⇒ cwd basename", () => {
  const run = (pane) => (pane === "%28" ? "0:11 harness\n" : "");
  assert.equal(whereLabel({ pane: "%28", pid: 34668 }, run), "11 harness (pid 34668)");
  assert.equal(whereLabel({ pane: "%28" }, run), "11 harness");
  assert.equal(whereLabel({ pane: "%404", pid: 1, cwd: "/Users/me/x/proj_events" }, run), "proj_events (pid 1)", "a gone pane falls back like no pane");
  assert.equal(whereLabel({ pid: 7, cwd: "/tmp/leasetest" }, run), "leasetest (pid 7)");
  assert.equal(whereLabel({ pid: 7 }, run), "pid 7");
});
