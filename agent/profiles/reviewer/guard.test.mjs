import assert from "node:assert/strict";
import test from "node:test";
import { reviewerBashRule } from "./guard.ts";

test("reviewer: blind to PR comments/reviews, read-only on git", () => {
  for (const cmd of ["gh pr view 1", "gh pr comment 1", "gh api repos/x/y/pulls/1/comments", "git push", "git commit -m x", "git checkout -b z", "git reset --hard"])
    assert.ok(reviewerBashRule(cmd)?.block, `should block: ${cmd}`);
  for (const cmd of ["gh pr diff 12", "git diff main...HEAD", "rg -n foo src", "git checkout -- file"])
    assert.equal(reviewerBashRule(cmd), undefined, `should allow: ${cmd}`);
});

