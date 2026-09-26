import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, EMPTY, replay, renderLines, projectMarkdown, visibleTasks } from "./core.ts";

test("add/start/done/remove lifecycle with stable ids", () => {
  let s = apply(EMPTY, { action: "add", text: "write tests" });
  s = apply(s, { action: "add", text: "implement" });
  assert.deepEqual(s.tasks.map((t) => [t.id, t.status]), [[1, "pending"], [2, "pending"]]);
  s = apply(s, { action: "start", id: 1 });
  assert.equal(s.tasks[0].status, "in_progress");
  s = apply(s, { action: "done", id: 1 });
  assert.equal(s.tasks[0].status, "done");
  s = apply(s, { action: "remove", id: 2 });
  assert.deepEqual(s.tasks.map((t) => t.id), [1]);
  s = apply(s, { action: "add", text: "third" });
  assert.equal(s.tasks.at(-1).id, 3, "ids never reused");
});

test("errors are returned, not thrown; state unchanged", () => {
  const s = apply(EMPTY, { action: "add", text: "x" });
  const r = apply(s, { action: "done", id: 99 });
  assert.equal(r.error, "no task #99");
  assert.deepEqual(r.tasks, s.tasks);
  assert.equal(apply(EMPTY, { action: "add", text: "  " }).error, "text required");
});

test("blockedBy: cannot start a blocked task; cycle rejected", () => {
  let s = apply(EMPTY, { action: "add", text: "a" });
  s = apply(s, { action: "add", text: "b", blockedBy: [1] });
  assert.match(apply(s, { action: "start", id: 2 }).error, /blocked by #1/);
  s = apply(s, { action: "done", id: 1 });
  assert.equal(apply(s, { action: "start", id: 2 }).error, undefined);
  assert.match(apply(s, { action: "add", text: "c", blockedBy: [7] }).error, /no task #7/);
});

test("replay: last todo toolResult on the branch wins; others ignored", () => {
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, text: "old", status: "pending", blockedBy: [] }], nextId: 2 } } },
    { type: "message", message: { role: "toolResult", toolName: "bash", details: { tasks: "not ours" } } },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, text: "new", status: "done", blockedBy: [] }], nextId: 2 } } },
    { type: "compaction" },
  ];
  assert.equal(replay(branch).tasks[0].text, "new");
  assert.deepEqual(replay([]), EMPTY);
});

test("done rows leave the BOARD after a turn but never the STATE (history survives for handoff)", () => {
  let s = apply(EMPTY, { action: "add", text: "a" });
  s = apply(s, { action: "add", text: "b" });
  s = apply(s, { action: "done", id: 1 });
  assert.deepEqual(visibleTasks(s, 2).map((t) => t.id), [2], "old done hidden");
  assert.deepEqual(visibleTasks(s, 0).map((t) => t.id), [1, 2], "same turn: still shown");
  assert.equal(s.tasks.length, 2, "state intact");
  assert.match(projectMarkdown(s), /\[x\] #1 a/, "projection keeps history");
});

test("render: id order (glyph carries status), budget hides done rows first, +N more, empty → no lines", () => {
  let s = EMPTY;
  for (let i = 1; i <= 3; i++) s = apply(s, { action: "add", text: `task ${i}` });
  s = apply(s, { action: "done", id: 1 });
  s = apply(s, { action: "start", id: 2 });
  assert.deepEqual(renderLines(s, { maxLines: 8, plain: true }).slice(1), ["✓ #1 task 1", "◐ #2 task 2", "○ #3 task 3"], "id order, not status order");

  let big = EMPTY;
  for (let i = 1; i <= 6; i++) big = apply(big, { action: "add", text: `task ${i}` });
  big = apply(big, { action: "done", id: 1 });
  big = apply(big, { action: "start", id: 4 });
  const lines = renderLines(big, { maxLines: 4, plain: true });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /Todos 1\/6/, "heading counts ALL tasks");
  assert.deepEqual(lines.slice(1, 3), ["○ #2 task 2", "○ #3 task 3"], "over budget: open rows win, still id order");
  assert.match(lines.at(-1), /\+4 more/);
  assert.deepEqual(renderLines(EMPTY, { maxLines: 4, plain: true }), []);
});

test("projectMarkdown is a checklist a human/handoff can read", () => {
  let s = apply(EMPTY, { action: "add", text: "a" });
  s = apply(s, { action: "add", text: "b", blockedBy: [1] });
  s = apply(s, { action: "start", id: 1 });
  const md = projectMarkdown(s);
  assert.match(md, /- \[~\] #1 a/);
  assert.match(md, /- \[ \] #2 b \(blocked by #1\)/);
});
