import { test } from "node:test";
import assert from "node:assert/strict";
const { reviewerSoloBashRule: r } = await import("./guard.ts");
test("reads the thread", () => {
  assert.equal(r("gh pr view 71255 --json comments,reviews"), undefined);
  assert.equal(r("gh api repos/acme/app/pulls/71255/comments"), undefined);
  assert.equal(r("gh pr diff 71255"), undefined);
});
test("never posts or mutates", () => {
  assert.ok(r("gh pr review 71255 --approve")?.block);
  assert.ok(r("gh pr comment 71255 -b hi")?.block);
  assert.ok(r("gh api -X POST repos/acme/app/pulls/71255/reviews")?.block);
  assert.ok(r("gh api repos/acme/app/issues/71255/comments -f body=hi")?.block);
  assert.ok(r("git push origin main")?.block);
  assert.ok(r("git commit -m x")?.block);
});
