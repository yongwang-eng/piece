import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, mmdd, projectFromCwd, artifactHome, planScaffold, rosterRow, addRosterRow, rulingLine, appendRuling, decisionsScaffold, decisionEntry, prependDecision, VAULT } from "./artifacts.ts";

test("folder: proj_<x>/crew_<slug>_<mmdd> when in a project (explicit or inferred from cwd); crews/crew_<slug>_<mmdd> otherwise", () => {
  const d = new Date("2026-09-13T10:00:00");
  assert.equal(artifactHome({ slugText: "Consult id scope", project: "proj_pi_development", date: d }).dir, `${VAULT}/projects/proj_pi_development/crew_consult_id_scope_0913`);
  assert.equal(artifactHome({ slugText: "Consult id scope", cwd: `${VAULT}/projects/proj_pi_development/design`, date: d }).project, "proj_pi_development");
  assert.equal(artifactHome({ slugText: "sweep review", cwd: "/Users/me/Code/acme", date: d }).dir, `${VAULT}/crews/crew_sweep_review_0913`);
  assert.equal(artifactHome({ slugText: "x", cwd: `${VAULT}/resources`, date: d }).project, undefined, "vault but not under projects/ → generic");
  assert.equal(projectFromCwd(`${VAULT}/projects/proj_events_rearch`), "proj_events_rearch");
});

test("a folder is never reused by another crew: same slug + day → _2, _3 (the probe's plan.md became a real run's Purpose, 2026-09-11)", () => {
  const d = new Date("2026-09-13T10:00:00");
  const taken = new Set([`${VAULT}/crews/crew_reviewer_0913`, `${VAULT}/crews/crew_reviewer_0913_2`]);
  assert.equal(artifactHome({ slugText: "reviewer", date: d, exists: (x) => taken.has(x) }).name, "crew_reviewer_0913_3");
  assert.equal(artifactHome({ slugText: "reviewer", date: d, exists: () => false }).name, "crew_reviewer_0913");
});

test("slug + mmdd", () => {
  assert.equal(slug("Consult id scope!"), "consult_id_scope", "snake_case, never hyphens");
  assert.equal(slug("a-b-c"), "a_b_c");
  assert.equal(slug("a".repeat(40)), "a".repeat(24));
  assert.equal(slug("   "), "run");
  assert.equal(mmdd(new Date("2026-09-03T00:00:00")), "0903");
});

test("plan.md: BLUF callout · purpose · §Intake · exit rule · roster table · rulings; roster rows idempotent; rulings append", () => {
  const home = artifactHome({ slugText: "x", project: "proj_p", date: new Date("2026-09-13T10:00:00") });
  let plan = planScaffold({ run: "crew-2026-09-13", home, purpose: "Fix the thing.", intake: "D50 decided; draft on branch." });
  assert.match(plan, /^# Plan — crew_x_0913/);
  assert.match(plan, /> \[!info\] The contract every worker reads first/);
  assert.match(plan, /## §Intake[\s\S]*D50 decided/);
  assert.match(plan, /## Exit rule/);
  plan = addRosterRow(plan, rosterRow({ id: 1, name: "implementer", role: "implementer", responsibility: "fix it" }), "implementer");
  plan = addRosterRow(plan, rosterRow({ id: 1, name: "implementer", role: "implementer", responsibility: "fix it" }), "implementer");
  assert.equal((plan.match(/\| `implementer` \|/g) ?? []).length, 1, "same worker added twice → one row");
  assert.match(plan, /\|---\|---\|---\|---\|\n\| 1 \| `implementer` \| implementer \| fix it \|/);
  plan = appendRuling(plan, rulingLine({ id: "c-implementer-1-2", by: "Yong", what: "approved commit, amended message", at: new Date("2026-09-13T20:07:00Z") }));
  assert.match(plan, /\*\*c-implementer-1-2\*\* · Yong — approved commit, amended message\n$/);
});

test("decisions.md: scaffold + reverse-chron entries with why / instead-of / evidence", () => {
  let f = decisionsScaffold("implementer", "implementer");
  assert.match(f, /^# implementer — decisions/, "role = name said once");
  f = prependDecision(f, decisionEntry({ what: "UUID for consult ids", why: "unique across restarts", at: new Date("2026-09-13T10:00:00Z") }));
  f = prependDecision(f, decisionEntry({ what: "c-<name>-<#N>-<n> instead", why: "D50 pinned readable ids", alternatives: "UUID (rejected by amended D50)", evidence: ["worker.test.mjs:51"], at: new Date("2026-09-13T11:00:00Z") }));
  const i1 = f.indexOf("c-<name>-<#N>-<n>"), i2 = f.indexOf("UUID for consult ids");
  assert.ok(i1 < i2, "newest first");
  assert.match(f, /\*\*Instead of:\*\* UUID \(rejected by amended D50\)/);
  assert.match(f, /\*\*Evidence:\*\* `worker.test.mjs:51`/);
  assert.ok(f.indexOf("> [!info]") < i1, "entries land after the scaffold callout");
});

// ── lifetimes (D55) ───────────────────────────────────────────────────────────────────────────────────────────────────
import { readPredecessor, resumeBlock, missingAtClose } from "./artifacts.ts";
import { mkdtempSync, mkdirSync as mkd, writeFileSync as wf, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("resumeBlock: built from the predecessor's folder alone — files with sizes, progress line, latest decision, last messages, and the order 'read first · continue · own folder'", () => {
  const dir = mkdtempSync(`${tmpdir()}/pred-`);
  wf(`${dir}/deliverable.md`, "progress: §1–4 done · §5 in flight\n# Ledger\n" + "row\n".repeat(200));
  wf(`${dir}/decisions.md`, "# historian — decisions\n\n> [!info] x\n\n### 2026-09-11 04:49 — Split the ledger rows\n\n**Why:** y\n\n### 2026-09-11 03:50 — earlier\n\n**Why:** z\n");
  mkd(`${dir}/evidence`); wf(`${dir}/evidence/a.json`, "{}"); wf(`${dir}/evidence/b.json`, "{}");
  const p = readPredecessor(dir, { name: "historian", id: 15, diedAt: "2026-09-11T03:55:04Z", reason: "request dead ×3", tools: 42, roomTail: ["inform: Alex stance superseded…"] });
  assert.equal(p.progress, "§1–4 done · §5 in flight");
  assert.equal(p.decisions, 2); assert.match(p.lastDecision, /^2026-09-11 04:49 — Split/);
  assert.ok(p.files.some((f) => f.name === "deliverable.md" && f.lines === 203));
  assert.ok(p.files.some((f) => f.name === "evidence/" && f.head === "2 files"));
  const block = resumeBlock(p, "historian_2").join("\n");
  assert.match(block, /^RESUME — you are `historian_2`, the successor of `historian` \(#15\), which died: request dead ×3 at 03:55 after 42 tool calls\./);
  assert.match(block, /Its last recorded progress: §1–4 done · §5 in flight/);
  assert.match(block, /decisions\.md has 2 entries; the latest: 2026-09-11 04:49 — Split/);
  assert.match(block, /> inform: Alex stance superseded/);
  assert.match(block, /READ ITS deliverable\.md FIRST\. Continue from its progress line\. Write your own work into YOUR folder/);
  const noProg = resumeBlock(readPredecessor(dir + "/nope", { name: "x" }), "x_2").join("\n");
  assert.match(noProg, /left no `progress:` line — read deliverable\.md end-to-end/);
});

test("closing artifacts must be files, not merely existing paths", () => {
  const dir = mkdtempSync(`${tmpdir()}/crew-artifact-files-`);
  const home = { dir, name: "fixture" };
  try {
    assert.deepEqual(missingAtClose(home), ["final_report.md", "wrap.md"]);
    mkd(`${dir}/final_report.md`);
    wf(`${dir}/wrap.md`, "real wrap");
    assert.deepEqual(missingAtClose(home), ["final_report.md"]);
    rmSync(`${dir}/final_report.md`, { recursive: true });
    wf(`${dir}/final_report.md`, "real report");
    assert.deepEqual(missingAtClose(home), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
