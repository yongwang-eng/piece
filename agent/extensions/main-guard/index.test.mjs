import assert from "node:assert/strict";
import test from "node:test";

import { MAIN_BASH_MAX_SECONDS, mainBashPolicy } from "./index.ts";
import { blockReasonFor } from "../guard/index.ts";

const blocked = (cmd, timeout) => {
  const r = mainBashPolicy({ command: cmd, timeout });
  assert.ok(r.block, `expected BLOCKED on main: ${cmd}`);
  assert.match(r.reason, /delegate|detach|end (the|your) turn/i, "reason must name the async alternative");
  return r;
};
const allowed = (cmd, timeout) => {
  const r = mainBashPolicy({ command: cmd, timeout });
  assert.equal(r.block, undefined, `expected ALLOWED on main: ${cmd}`);
  return r;
};

test("main's foreground bash is bounded to 60s: missing or oversized timeouts are clamped", () => {
  assert.equal(MAIN_BASH_MAX_SECONDS, 60);
  assert.equal(allowed("rush build --to api").timeout, 60);
  assert.equal(allowed("npx jest packages/api", 600).timeout, 60);
  assert.equal(allowed("git status", 5).timeout, 5, "a shorter explicit timeout is kept");
});

test("explicit waits are rejected with an actionable async alternative", () => {
  blocked("sleep 30");
  blocked("sleep 120 && cat /tmp/out.md");
  blocked("while [ ! -f /tmp/report.md ]; do sleep 2; done");
  blocked("until curl -s localhost:9300/health; do sleep 1; done");
  blocked("gh run watch 12345");
  blocked("gh pr checks 70892 --watch");
  blocked("tail -f /tmp/run.log");
  blocked("watch -n 5 ls /tmp/reports");
  blocked("node grader.mjs & wait");
  blocked("waitfor /tmp/report.md");
});

test("held-fixed: ordinary short commands on main are untouched", () => {
  for (const cmd of [
    "git status", "rg 'sleep' packages/api/src", "ls -la /tmp/reports", "cat /tmp/report.md",
    "sleep 1 && ls", "grep -n waitfor docs/*.md", "node --test agent/extensions/fleet/lanes.test.mjs",
    "caffeinate -ims -t 3600 &", "nohup node grader.mjs > /tmp/grader.log 2>&1 &",
  ]) allowed(cmd);
});

test("held-fixed: delegated workers keep legitimate backoff — the child guard has no wait rule", () => {
  assert.equal(blockReasonFor("sleep 30"), undefined);
  assert.equal(blockReasonFor("until curl -s localhost:9300/health; do sleep 5; done"), undefined);
  assert.equal(blockReasonFor("gh run watch 12345"), undefined);
});

test("non-bash and unparseable inputs pass through", () => {
  assert.deepEqual(mainBashPolicy({ command: "" }), {});
  assert.deepEqual(mainBashPolicy({}), {});
});
