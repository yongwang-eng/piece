/**
 * Repo classification is DETERMINISTIC by registry, not guessed (Yong, 2026-09-11). An org-name heuristic was always one
 * new repo away from being wrong, and being wrong means a push, a merge, or a ping that was Yong's to make.
 *
 * The property that matters most: an UNLISTED repo is `unknown`, never silently `shared` or `own`. Main asks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classifyRepo, lookupRepo, remoteMatches, slugOf } from "./repo-class.ts";

const REGISTRY = JSON.parse(readFileSync(new URL("../../config/repos.json", import.meta.url), "utf8")).repos;

test("slugOf normalizes every remote form to org/name", () => {
  for (const [url, want] of [
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["ssh://git@github.com/me/pi-config.git", "me/pi-config"],
    ["git@github.com:Me/Pi-Config.git", "me/pi-config"],
  ]) assert.equal(slugOf(url), want, url);
  assert.equal(slugOf("not-a-remote"), undefined);
});

test("wildcards match in either half, and nothing else does", () => {
  assert.ok(remoteMatches("acme/*", "acme/app"));
  assert.ok(remoteMatches("acme/*", "acme/infra"));
  assert.ok(!remoteMatches("acme/*", "notacme/app"), "a prefix is not an org");
  assert.ok(remoteMatches("*/pi-config", "anyone/pi-config"));
  assert.ok(!remoteMatches("acme/app", "acme/infra"));
});

test("the real registry classifies the repos in play", () => {
  assert.equal(classifyRepo("git@github.com:acme/app.git", REGISTRY), "shared");
  assert.equal(classifyRepo("git@github.com:acme/infra.git", REGISTRY), "shared", "the wildcard covers every Acme repo");
  assert.equal(classifyRepo("git@github.com:me/pi-config.git", REGISTRY), "own");
});

test("A WORKTREE inherits its source class for free — the remote is identical inside one", () => {
  // ~/git_repos/wt-pi-caps is a worktree of ~/.pi/agent; `git remote get-url origin` there returns the SAME remote.
  assert.equal(classifyRepo("git@github.com:me/pi-config.git", REGISTRY, "/Users/me/git_repos/wt-pi-caps"), "own",
    "no path rule needed: the remote decides, and a worktree shares it");
  // And a shared-repo worktree stays shared even though its path is nowhere near ~/Code/acme.
  assert.equal(classifyRepo("git@github.com:acme/app.git", REGISTRY, "/tmp/some-wt"), "shared");
});

test("an UNLISTED repo is unknown — never guessed in either direction", () => {
  assert.equal(classifyRepo("git@github.com:someorg/newthing.git", REGISTRY), "unknown");
  assert.equal(classifyRepo("https://gitlab.com/acme/thing.git", REGISTRY), "unknown");
  assert.notEqual(classifyRepo("git@github.com:someorg/newthing.git", REGISTRY), "shared", "not a silent fallback");
  assert.notEqual(classifyRepo("git@github.com:someorg/newthing.git", REGISTRY), "own", "and certainly not own");
});

test("path rules cover no-remote repos; remote wins when both could match", () => {
  assert.equal(classifyRepo(undefined, REGISTRY, "/Users/me/Code/acme/scratch"), "shared", "under the Acme checkout");
  assert.equal(classifyRepo(undefined, REGISTRY, "/Users/me/workspace/lab/x"), "own");
  assert.equal(classifyRepo(undefined, REGISTRY, "/Users/me/.pi/agent"), "own");
  assert.equal(classifyRepo(undefined, REGISTRY, "/Users/me/Code/acme-other"), "unknown",
    "a sibling directory sharing the prefix is NOT under it");
  // remote beats path: a Acme clone parked in the vault is still shared.
  assert.equal(classifyRepo("git@github.com:acme/app.git", REGISTRY, "/Users/me/workspace/tmp"), "shared");
});

test("no remote and no path at all = own (a scratch repo nobody else can reach)", () => {
  assert.equal(classifyRepo(undefined, REGISTRY), "own");
  assert.equal(classifyRepo("", REGISTRY), "own");
});

test("lookupRepo returns the whole entry, so merge policy and worktree home come from one decision", () => {
  const acme = lookupRepo(REGISTRY, { remote: "git@github.com:acme/app.git" });
  assert.equal(acme.class, "shared");
  assert.equal(acme.merge, "aviator");
  assert.equal(acme.draftBlocksReview, true, "drafts get no Greptile/Devin — the crew's reviewer is the gauntlet");
  assert.deepEqual(acme.autoReviewers, ["greptile", "devin"]);

  const own = lookupRepo(REGISTRY, { remote: "git@github.com:me/pi-config.git" });
  assert.equal(own.merge, "crew_merge");
  assert.equal(own.draftBlocksReview, false);
  assert.equal(lookupRepo(REGISTRY, { remote: "git@github.com:someorg/x.git" }), undefined);
});
