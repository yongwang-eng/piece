import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadClassRows, mistakeShape } from "./consult-classes.ts";

const rows = loadClassRows(new URL("../../config/consult_classes.json", import.meta.url).pathname);
const req = (verb, target, detail, question = `${verb} ${target}`) => ({ action: { verb, target, detail }, question });

test("the shipped list loads and every row names its why", () => {
  assert.ok(rows.length >= 3);
  for (const r of rows) { assert.ok(r.verb, "verb pattern"); assert.ok(r.why, `why for ${r.verb}`); }
});

test("push to a crew branch in Yong's OWN repo is mistake-class; the same push in a shared repo is not (absence = incident)", () => {
  assert.ok(mistakeShape(req("push", "origin crew/x"), "own", rows));
  assert.equal(mistakeShape(req("push", "origin crew/x"), "shared", rows), undefined);
  assert.equal(mistakeShape(req("push", "origin crew/x"), "unknown", rows), undefined);
});

test("history-destroying pushes never qualify: force, -f, force-with-lease, + refspec, rebase, branch delete (Yong 2026-09-15: preserve git history)", () => {
  for (const detail of ["git push --force", "git push -f origin x", "git push --force-with-lease", "git push origin +crew/x", "after rebase onto main", "git push origin --delete crew/x", "git push origin :crew/x"]) {
    assert.equal(mistakeShape(req("push", "origin crew/x", detail), "own", rows), undefined, detail);
  }
  // the exclusion reads the QUESTION too — a worker cannot launder a force-push by leaving `detail` blank
  assert.equal(mistakeShape(req("push", "origin crew/x", undefined, "may I force push crew/x?"), "own", rows), undefined);
});

test("delete under /tmp or the worker's own worktree is mistake-class; delete anywhere else is not", () => {
  assert.ok(mistakeShape(req("delete", "/tmp/reload-probe-marker"), "own", rows, "/w/tree"));
  assert.ok(mistakeShape(req("rm", "/private/tmp/x"), "shared", rows, "/w/tree"));
  assert.ok(mistakeShape(req("delete", "/w/tree/scratch.txt"), "shared", rows, "/w/tree"));
  assert.equal(mistakeShape(req("delete", "/Users/me/notes.md"), "own", rows, "/w/tree"), undefined);
  assert.equal(mistakeShape(req("delete", "/w/tree/../elsewhere"), "own", rows, "/w/tree"), undefined);
});

test("an unlisted verb is never mistake-class, whatever the repo", () => {
  assert.equal(mistakeShape(req("deploy", "prod"), "own", rows), undefined);
  assert.equal(mistakeShape(req("merge", "main"), "own", rows), undefined);
  assert.equal(mistakeShape({ question: "may I proceed?" }, "own", rows), undefined, "no action → nothing to match");
});

test("a missing or malformed list is an EMPTY list (fail closed: everything reaches Yong)", () => {
  assert.deepEqual(loadClassRows("/nonexistent/consult_classes.json"), []);
  const bad = join(mkdtempSync(join(tmpdir(), "cc-")), "x.json"); writeFileSync(bad, "{ not json");
  assert.deepEqual(loadClassRows(bad), []);
  const noWhy = join(mkdtempSync(join(tmpdir(), "cc-")), "y.json"); writeFileSync(noWhy, JSON.stringify({ rows: [{ verb: "^push$" }] }));
  assert.deepEqual(loadClassRows(noWhy), [], "a row without a why is dropped — the reason is part of the rule");
});
