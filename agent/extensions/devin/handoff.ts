// Handing a plan to Devin: the rules footers, the plan-shape and freshness stops, the 30k message cap. Pure — the REST
// call and the row write live in index.ts. (Moved from lab/agent_scripts/devin_handoff/handoff.py, 2026-09-22.)

import { readFileSync } from "node:fs";

export const DEVIN_MSG_MAX = 30_000;   // Devin rejects longer messages with HTTP 400
/** Who Devin's commits must be authored as and the branch prefix for a build — `config/devin.json`, never a constant. */
export type Author = { authorEmail: string; branchPrefix: string };
export function loadAuthor(path = `${process.env.HOME}/.pi/agent/config/devin.json`): Author {
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (typeof j.authorEmail !== "string" || typeof j.branchPrefix !== "string") throw new Error(`config/devin.json needs authorEmail and branchPrefix`);
  return { authorEmail: j.authorEmail, branchPrefix: j.branchPrefix };
}

export const ASK_FOOTER = `
--- Rules for this session ---
This is a question, not a task. Answer in this conversation only. Do NOT open a pull request, push a branch, edit any
repository, or post anywhere. Cite file paths, PR numbers, sessions or dashboards you relied on so the answer can be checked.
If the answer needs a change to be made, describe it and stop.
`;

export const DESIGN_FOOTER = `
--- Rules for this session (design review, not a task) ---
You are reviewing a plan BEFORE anyone implements it. Do NOT create a branch, push, open a pull request, edit any
repository, or post anywhere. Read the files the plan names at origin/main (the commit it states) and check every claim.
Post ONE message with exactly these sections, then STOP and wait:
1. CLAIMS — for each numbered claim under "Claims to verify": \`CONFIRMED\` with the line you read, or \`WRONG\` with what
   the code actually does. Do not skip one because it looks obvious.
2. DESIGN CHOICES — for each lettered choice under "Design choices": \`AGREE\`, or \`COUNTER: <alternative> because <reason>\`.
   A counter is welcome; a counter without a mechanism is not.
3. WHAT WOULD MAKE THIS WRONG — anything the author did not see: a caller the change disturbs, a runtime behaviour that
   breaks an assumption, a number that would not mean what the plan says, a convention in this repo the plan violates.
4. QUESTIONS — what must be decided before you could build it. Prefer none.
5. Last line: VERDICT: agree | amend | disagree
The author replies in this session and may send a revised plan; answer each revision with the same five sections.
VERDICT: agree means you could build the plan as written with no design choice left to you. Nothing is branched or
pushed until the author sends the final plan with its build rules.
`;

// Devin will not infer these; the repo's PR rule (CLAUDE.md §8) is the source for the body shape.
const FOOTER = `
--- Handoff rules (do not skip) ---
1. Open the pull request as a DRAFT. Do not mark it ready for review; a human does that.
2. Branch name: {prefix}/{slug}
3. PR body follows the repository's CLAUDE.md PR-description rule exactly — three headings and nothing else:
   \`## Why\` (one line on why now, then behaviour-change bullets), \`## Not covered by CI\` (only what CI cannot check,
   red-first evidence), \`## Proof\` (evidence the reviewer cannot get from the diff or CI), then the Linear line on its
   own line if one is given. Keep the template's \`- [ ] I have QA'd the changes\` line at the top, unticked. First person,
   author's voice, about 15 lines. Never walk the changed files or restate the diff; implementation rationale is NOT for
   the body (the author posts it as inline review comments). No tables, callouts, Non-goals lists, PR citations or
   rebase narration. \`rush build\`, \`rush tidy\` and \`rushx test\` runs never appear in the body — CI runs them.
4. End the PR body with: Link to Devin session: <this session's URL>
5. Before every push, run the TypeScript build for each touched package (jest does not type-check; a
   red/green that never ran the build can hide a TS error CI will catch). Report the result in this session, not in
   the PR body.
6. Implement the plan as written. If the plan is wrong or underspecified, stop and say so in the session
   instead of choosing a design.
`;

// An existing PR: Devin pushes to its branch. Every human-facing act on the thread stays with the author.
const PR_FOOTER = `
--- Handoff rules (do not skip) ---
1. Push to the existing branch \`{branch}\` of pull request {pr}. Do not open a new pull request, do not force-push,
   do not rebase.
2. Do not comment on the pull request, reply to or resolve any review thread, request reviewers, or change its
   draft/ready state. The author posts every reply. Report in this session instead.
3. Do not run any \`atlantis\` command; reading the plan comment Atlantis posts on push is fine.
4. Before every push, run the TypeScript build for each touched package (jest does not type-check; a
   red/green that never ran the build can hide a TS error CI will catch). Report the result in this session, not in
   the PR body.
5. Implement the plan as written. If the plan is wrong or underspecified, stop and say so in the session
   instead of choosing a design.
`;

export type Target = { slug?: string; pr?: string; branch?: string; filesMatch?: string };

/** The build rules for a target: a new draft PR on `<branchPrefix>/<slug>`, or pushes to an existing PR's branch. */
export function buildRules(t: Target, who: Author = loadAuthor()): string {
  if (t.pr) { if (!t.branch) throw new Error("pr needs branch"); return PR_FOOTER.replace("{branch}", t.branch).replace("{pr}", t.pr); }
  if (!t.slug) throw new Error(`a new PR needs slug (branch = ${who.branchPrefix}/<slug>)`);
  return FOOTER.replace("{slug}", t.slug).replace("{prefix}", who.branchPrefix);
}

export function expectOf(t: Target, who: Author = loadAuthor()): { branch?: string; authorEmail: string; filesMatch?: string } {
  const branch = t.branch ?? (t.slug ? `${who.branchPrefix}/${t.slug}` : undefined);
  return { ...(branch ? { branch } : {}), authorEmail: who.authorEmail, ...(t.filesMatch ? { filesMatch: t.filesMatch } : {}) };
}

const PLAN_SECTIONS = ["## Claims to verify", "## Design choices"];
/** The review is only as sharp as the plan's own checklist: numbered claims Devin can CONFIRM/WRONG and lettered choices it
 *  can AGREE/COUNTER. Returns the headings a plan lacks. */
export function designShape(plan: string): string[] {
  return PLAN_SECTIONS.filter((h) => !new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(plan));
}

/** `go`: the FINAL plan plus build rules in one message; past the API cap, a pointer to the plan the session already holds. */
export function goMessage(plan: string, rules: string): { message: string; note?: string } {
  const full = `The design review is closed; this is the FINAL plan, agreed by both sides. Build it now.\n\n${plan.trim()}\n${rules}`;
  if (full.length <= DEVIN_MSG_MAX) return { message: full };
  return {
    note: `plan + rules = ${full.length} chars > ${DEVIN_MSG_MAX}; sending the in-session plan reference instead`,
    message: "The design review is closed. Build the FINAL plan now. The FINAL plan is the plan in this session's first message "
      + "as amended by every later message titled 'Design review — ROUND …' (an amended section replaces the original; "
      + `a section not shown there is unchanged). Do not re-open design questions you already marked AGREE.\n\n${rules}`,
  };
}

export const askSlug = (title: string) => "ask-" + title.slice(8, 30).trim().replace(/\s+/g, "-").toLowerCase();

export type GhApi = (path: string) => Promise<any>;
/** Devin reads origin/main, never this machine — so the check is the PLAN's declared base against the remote, per named
 *  file. Resolves to a note (or undefined when nothing to check); rejects with the refusal when a named file moved. */
export async function freshness(plan: string, gh: GhApi): Promise<string | undefined> {
  const repo = /^Repository:\s*([\w.-]+\/[\w.-]+)/m.exec(plan)?.[1];
  if (!repo) return undefined;
  const base = /origin\/main\W{0,6}([0-9a-f]{7,40})\b/.exec(plan)?.[1];
  if (!base) throw new Error("refusing: the plan names a repository but not the origin/main commit it was written against — state `origin/main <sha>` near the top (Devin is told to read at that commit). allow_stale to send anyway.");
  const head: string = (await gh(`repos/${repo}/commits/main`)).sha;
  if (head.startsWith(base)) return undefined;
  const ahead = (await gh(`repos/${repo}/compare/${base}...${head}`)).ahead_by ?? "?";
  const named = [...new Set([...plan.matchAll(/`((?:\.?[\w-]+\/)+[\w.-]+)`/g)].map((m) => m[1]))].sort();
  const stale: string[] = [];
  for (const f of named) {
    const latest = await gh(`repos/${repo}/commits?sha=${head}&path=${f}&per_page=1`);
    if (!Array.isArray(latest) || !latest.length) continue;   // not a path on main (a label, a branch, a file the plan creates)
    const status = (await gh(`repos/${repo}/compare/${base}...${latest[0].sha}`)).status;
    if (status === "ahead" || status === "diverged") stale.push(f);
  }
  if (stale.length) throw new Error(`refusing: origin/main is ${ahead} commits past the plan's base ${base.slice(0, 11)} and changed files the plan names:\n  ${stale.join("\n  ")}\nRe-read those with \`git show origin/main:<path>\`, restate the base commit, rerun. allow_stale to override.`);
  return `freshness: origin/main is ${ahead} commits past the plan's base ${base.slice(0, 11)}; none of the ${named.length} paths the plan names changed.`;
}
