import assert from "node:assert/strict";
import test from "node:test";
import { babysitterBashRule } from "./guard.ts";

test("babysitter: watches only — any PR/CI mutation or git write is a human click", () => {
  for (const cmd of ["gh pr comment 1 -b hi", "gh pr review 1 --approve", "gh api repos/x/y/issues -X POST", "gh run rerun 5", "gh workflow run ci", "git push"])
    assert.ok(babysitterBashRule(cmd)?.block, `should block: ${cmd}`);
  for (const cmd of ["gh pr checks 1", "gh pr view 1 --json state", "gh api repos/x/y/pulls/1", "gh run view 5", "git log -3"])
    assert.equal(babysitterBashRule(cmd), undefined, `should allow: ${cmd}`);
});

