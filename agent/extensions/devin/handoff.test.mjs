import test from "node:test";
import assert from "node:assert/strict";
import { askSlug, buildRules, designShape, expectOf, freshness, goMessage, DEVIN_MSG_MAX, DESIGN_FOOTER, ASK_FOOTER } from "./handoff.ts";

const plan = "# Plan\nRepository: acme/app\norigin/main abc1234def\n\n## Claims to verify\n1. x `apps/api/src/a.ts`\n## Design choices\nA. y\n";

const WHO = { authorEmail: "jane@acme.example", branchPrefix: "yong" };

test("designShape: names the missing headings; a plan with both passes", () => {
  assert.deepEqual(designShape(plan), []);
  assert.deepEqual(designShape("# Plan\n## Claims to verify\n"), ["## Design choices"]);
  assert.deepEqual(designShape("nothing"), ["## Claims to verify", "## Design choices"]);
  assert.deepEqual(designShape("## Claims to verifying\n## Design choices"), ["## Claims to verify"], "heading must end at a word boundary");
});

test("buildRules: a new PR gets the draft-PR footer with the branch; an existing PR gets the push-only footer", () => {
  const fresh = buildRules({ slug: "boot-timing" }, WHO);
  assert.match(fresh, /Open the pull request as a DRAFT/); assert.match(fresh, /Branch name: yong\/boot-timing/);
  const existing = buildRules({ pr: "https://github.com/acme/app/pull/1", branch: "yong/x" }, WHO);
  assert.match(existing, /Push to the existing branch `yong\/x` of pull request https:\/\/github.com\/acme\/acme\/pull\/1/);
  assert.match(existing, /Do not comment on the pull request/); assert.doesNotMatch(existing, /DRAFT/);
  assert.throws(() => buildRules({ pr: "u" }, WHO), /--pr needs --branch|branch/);
  assert.throws(() => buildRules({}, WHO), /slug/);
});

test("expectOf: branch defaults to yong/<slug>, author always, filesMatch only when given; empty keys dropped", () => {
  assert.deepEqual(expectOf({ slug: "s" }, WHO), { branch: "yong/s", authorEmail: "jane@acme.example" });
  assert.deepEqual(expectOf({ branch: "b", filesMatch: "\\.spec\\.ts$" }, WHO), { branch: "b", authorEmail: "jane@acme.example", filesMatch: "\\.spec\\.ts$" });
});

test("goMessage: FINAL plan + rules; over Devin's 30k cap it sends the in-session reference instead, with the note", () => {
  const rules = buildRules({ slug: "s" }, WHO);
  const small = goMessage(plan, rules);
  assert.match(small.message, /^The design review is closed; this is the FINAL plan/); assert.ok(small.message.includes(plan.trim())); assert.equal(small.note, undefined);
  const big = goMessage("x".repeat(DEVIN_MSG_MAX), rules);
  assert.ok(big.message.length < DEVIN_MSG_MAX); assert.match(big.message, /first message.*as amended by every later message/s); assert.match(big.note, /> 30000/);
});

test("askSlug: ask-<title words>, lowercase, bounded", () => {
  assert.equal(askSlug("pi-ask: Why does the SQS consumer restart twice?"), "ask-why-does-the-sqs-consu");
});

test("freshness: no Repository line → fine; repo without base sha → refuse; head at base → fine; named file changed after base → refuse; unchanged → note", async () => {
  assert.equal(await freshness("no repo here", async () => ({})), undefined);
  await assert.rejects(freshness("Repository: acme/app\n", async () => ({})), /names a repository but not the origin\/main commit/);
  const gh = (answers) => async (path) => { for (const [k, v] of Object.entries(answers)) if (path.includes(k)) return v; throw new Error(`unexpected gh ${path}`); };
  assert.equal(await freshness(plan, gh({ "commits/main": { sha: "abc1234def999" } })), undefined);
  const moved = { "commits/main": { sha: "fff" }, "compare/abc1234def...fff": { ahead_by: 3 }, "commits?sha=fff&path=apps/api/src/a.ts": [{ sha: "eee" }], "compare/abc1234def...eee": { status: "ahead" } };
  await assert.rejects(freshness(plan, gh(moved)), /3 commits past the plan's base abc1234def and changed files the plan names:\n {2}apps\/api\/src\/a\.ts/);
  const same = { ...moved, "compare/abc1234def...eee": { status: "identical" } };
  assert.match(await freshness(plan, gh(same)), /origin\/main is 3 commits past the plan's base abc1234def; none of the 1 paths the plan names changed/);
  // a path that is not on main (a label, a file the plan creates) is skipped, not a refusal
  const missing = { "commits/main": { sha: "fff" }, "compare/abc1234def...fff": { ahead_by: 1 }, "commits?sha=fff&path=apps/api/src/a.ts": [] };
  assert.match(await freshness(plan, gh(missing)), /none of the 1 paths/);
});

test("footers exist and forbid repo writes where they must", () => {
  assert.match(DESIGN_FOOTER, /Do NOT create a branch, push, open a pull request/); assert.match(ASK_FOOTER, /Do NOT open a pull request/);
});
