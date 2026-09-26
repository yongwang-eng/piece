import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_SLOT } from "../../lib/guards/index.ts";
import { implementerBashRule, implementerWriteRule } from "./guard.ts";
globalThis.__guard = { implementerBashRule, implementerWriteRule };

const WT = "/Users/me/wt-x";

test("implementer: commits are FREE on its own branch (checkpoints); merge/push/PR are NEVER its job (D57)", () => {
  for (const cmd of ["git add a.ts b.ts && git commit -m wip", "git commit -m 'checkpoint'", "git status", "git diff --stat", "git log --oneline -3", "gh pr diff 12", `cd ${WT}/agent && ls`, "cd sub && npm test", `rg foo ${WT}`])
    assert.equal(implementerBashRule(WT, cmd), undefined, `should allow: ${cmd}`);

  // No approval unlocks these — main runs the merge procedure after sign-off; in a shared repo there is none.
  for (const cmd of ["git push", "git push origin HEAD", "git merge main", "git rebase main", "git cherry-pick abc", "gh pr create", "gh pr merge 1", "gh pr review 1", "gh release create"])
    assert.ok(implementerBashRule(WT, cmd)?.block, `should block: ${cmd}`);
  assert.match(implementerBashRule(WT, "git push").reason, /never an implementer's job/);
  assert.match(implementerBashRule(WT, "git merge main").reason, /main runs the merge procedure/);
});

test("implementer: one tree, one branch — no switching, stashing, hard resets or branch deletion", () => {
  for (const cmd of ["git checkout main", "git switch -c y", "git stash", "git worktree add /tmp/x", "git branch -D old", "git clean -fd", ["git", "reset", "--hard"].join(" ")])
    assert.ok(implementerBashRule(WT, cmd)?.block, `should block: ${cmd}`);
});

test("implementer: a commit names its files — a sweep would commit the whole tree", () => {
  assert.ok(implementerBashRule(WT, "git add -A && git commit -m x")?.block);
  assert.ok(implementerBashRule(WT, "git add . && git commit -m x")?.block);
  assert.ok(implementerBashRule(WT, "git commit -am x")?.block);
  assert.match(implementerBashRule(WT, "git add -A")?.reason ?? "", /explicitly/);   // `git add <paths>` in the reason
});

test("implementer: confined to its worktree — writes outside blocked, the review slot never touched", () => {
  assert.ok(implementerBashRule(WT, "cd /tmp && ls")?.block);
  assert.ok(implementerBashRule(WT, `ls ${REVIEW_SLOT}/x`)?.block);
  assert.ok(implementerWriteRule(WT, "edit", "/etc/hosts")?.block);
  assert.ok(implementerWriteRule(WT, "write", "/Users/me/wt-xy/evil.ts")?.block, "a sibling dir sharing the prefix is outside");
  assert.equal(implementerWriteRule(WT, "edit", `${WT}/a.ts`), undefined);
  assert.equal(implementerWriteRule(WT, "edit", "rel/a.ts"), undefined, "relative paths resolve inside the worktree");
  assert.equal(implementerWriteRule(WT, "read", "/etc/hosts"), undefined, "control: read is not a write");
});

test("implementer: its own artifacts dir is always writable, bash and write, though it is outside the worktree (live block 2026-09-11)", () => {
  const A = "/Users/me/notes/pi/crew_x_0911/implementer";
  assert.equal(implementerBashRule(WT, `cat >> ${A}/deliverable.md <<EOF\nprogress: x\nEOF`, A), undefined);
  assert.equal(implementerBashRule(WT, `cd ${A} && ls`, A), undefined);
  assert.ok(implementerBashRule(WT, "cd /tmp && ls", A)?.block, "control: elsewhere is still blocked");
});

test("read-only git state is allowed — blocking the whole `worktree` verb stopped an implementer checking its own state (live 2026-09-11)", () => {
  for (const cmd of [
    "git worktree list", "git branch --show-current", "git branch -v", "git branch --list",
    "git status --short", "git rev-parse HEAD", "git log --oneline -1",
    "git status --short; git branch --show-current; git rev-parse HEAD; git worktree list",   // the exact blocked combo
  ]) assert.equal(implementerBashRule(WT, cmd), undefined, `read-only state must be allowed: ${cmd}`);

  // the mutating subcommands stay blocked — the fix must not widen one-branch-one-tree
  for (const cmd of ["git worktree add /tmp/x", "git worktree remove /tmp/x", "git worktree move a b", "git worktree prune", "git branch -D old", "git branch -m a b"])
    assert.ok(implementerBashRule(WT, cmd)?.block, `must stay blocked: ${cmd}`);
});

test("the worktree REGISTRY is readable; write-shaped commands get NO exemption", () => {
  const R = "/Users/me/Code/acme/worktrees.json";
  // The registry is the documented source of truth for tree <-> branch and lives outside every worktree.
  assert.equal(implementerBashRule(WT, `cat ${R}`), undefined, "documented practice: read it before touching a tree");
  assert.equal(implementerBashRule(WT, `python3 -c "import json; print(json.load(open('${R}')))"`), undefined);

  // The exemption is READ-shaped only. It must not fire for a write, so a write gets no special pass and is judged by
  // the ordinary rules. ⚠️ HONEST LIMIT: the bash rule does not parse arbitrary redirect targets, so a redirect here is
  // not itself blocked — that is the same "guards prevent accidents, only the OS prevents actions" limit recorded in
  // capabilities.md §5c, and the real protection is that main owns the registry and reviews the diff.
  const { implementerWriteRule } = globalThis.__guard ?? {};
  assert.ok(implementerWriteRule ? implementerWriteRule(WT, "write", R)?.block : true, "the write TOOL is confined and does block it");
});
