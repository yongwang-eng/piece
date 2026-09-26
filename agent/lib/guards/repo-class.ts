/**
 * Repo class — the axis that decides what a crew may do with git (D57).
 *
 *   own      Yong's alone. No other humans, no PR process. A merge to main with the full approval set is PRE-AUTHORIZED
 *            by his standing ruling, so the governor may approve it on his behalf.
 *   shared   other people work here (acme/*). **Nothing merges or pushes from a crew, ever** — review and merge happen
 *            on GitHub, by teammates. The crew's output is commits on a local branch.
 *   unknown  NOT a guess. Main asks Yong and the answer is added to the registry; if asking is impossible (a worker
 *            mid-run, headless), it is treated exactly as `shared`.
 *
 * DETERMINISTIC by registry (`config/repos.json`), not by heuristic (Yong, 2026-09-11): an org-name guess was always one new
 * repo away from being wrong, and the cost of being wrong is a push, a merge or a ping that was Yong's to make.
 *
 * WORKTREES need no special handling for the common case: `git remote get-url origin` returns the SAME remote inside a
 * worktree, so a worktree inherits its source repo's class for free. `path` rules exist only for repos with no remote,
 * and there a worktree resolves back to its source via `git rev-parse --git-common-dir`.
 */
export type RepoClass = "own" | "shared" | "unknown";

/** One registry entry. `remote` is `org/name` with `*` allowed in either half; `path` is a prefix with `~` expanded. */
export interface RepoEntry {
  remote?: string;
  path?: string;
  class: "own" | "shared";
  why?: string;
  merge?: "crew_merge" | "aviator" | "never";
  autoReviewers?: string[];
  draftBlocksReview?: boolean;
  worktrees?: string;
  conventions?: string;
}

/** `org/name` from any remote form. Lowercased; `.git` stripped. */
export function slugOf(remoteUrl: string): string | undefined {
  const m = /^[\w.+-]+@[^:]+:(.+?)(?:\.git)?$|^(?:https?|ssh|git):\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(remoteUrl.trim());
  const slug = (m?.[1] ?? m?.[2])?.toLowerCase();
  return slug && slug.includes("/") ? slug.split("/").slice(-2).join("/") : undefined;
}

const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");

/** A `*` in either half is a wildcard: `acme/*` matches every Acme repo, and a star-org form matches any org's `pi-config`. Exact match otherwise. */
export function remoteMatches(pattern: string, slug: string): boolean {
  const [po, pn] = pattern.toLowerCase().split("/");
  const [so, sn] = slug.toLowerCase().split("/");
  return (po === "*" || po === so) && (pn === "*" || pn === sn);
}

/**
 * Classify from the registry. `remote` wins over `path` because it is the signal that survives a worktree.
 * Returns the full entry so callers get merge policy, worktree home and conventions from the same decision.
 */
export function lookupRepo(repos: RepoEntry[], p: { remote?: string; sourcePath?: string }): RepoEntry | undefined {
  const slug = p.remote ? slugOf(p.remote) : undefined;
  if (slug) { const hit = repos.find((r) => r.remote && remoteMatches(r.remote, slug)); if (hit) return hit; }
  if (p.sourcePath) {
    const abs = expand(p.sourcePath);
    const hit = repos.find((r) => r.path && (abs === expand(r.path) || abs.startsWith(expand(r.path).replace(/\/$/, "") + "/")));
    if (hit) return hit;
  }
  return undefined;   // unknown → ASK; never a guess
}

/** Orgs whose repos are Yong's alone — retained for callers that predate the registry. */
export const OWN_ORGS = ["me"];

/** `git@github.com:org/repo.git` · `https://github.com/org/repo` · `ssh://git@host/org/repo.git` → org */
export function orgOf(remoteUrl: string): string | undefined {
  const u = remoteUrl.trim();
  const m = /^[\w.+-]+@[^:]+:([^/]+)\/|^(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\//.exec(u);
  return (m?.[1] ?? m?.[2])?.toLowerCase() || undefined;
}

/**
 * Registry-first classification. A remote that is not in the registry is **unknown**, not shared-by-default: the caller
 * asks Yong and adds the answer. Only a repo with NO remote at all and no matching path stays `own` (a scratch repo
 * nobody else can reach).
 */
export function classifyRepo(remoteUrl: string | undefined, repos: RepoEntry[] = [], sourcePath?: string): RepoClass {
  const hit = lookupRepo(repos, { remote: remoteUrl, sourcePath });
  if (hit) return hit.class;
  if (!remoteUrl || !remoteUrl.trim()) return sourcePath ? "unknown" : "own";
  return "unknown";
}

/**
 * What the RUN may do — i.e. what MAIN's merge procedure may do. The implementer never merges, pushes or opens a PR in any
 * class (D57): its job ends at commits on its own branch.
 *   own     main may merge to main and push, once every reviewer has signed off — authorized by the GOVERNOR on Yong's
 *           standing ruling. Yong is not in this loop; it is his own config repo.
 *   shared  nothing merges or pushes from a crew. Ever. Review and merge are teammates' work on GitHub.
 */
export function runPolicy(cls: RepoClass): { merge: "governor" | "never"; push: "governor" | "never"; pr: "human-only" } {
  return cls === "own" ? { merge: "governor", push: "governor", pr: "human-only" } : { merge: "never", push: "never", pr: "human-only" };
}

/** The refusal a WORKER sees for an act that is never its job. Names why and what its job actually is. */
export function workerRefusal(act: "merge" | "push" | "pr"): string {
  return `BLOCKED by governance: ${act === "pr" ? "opening or merging a PR" : `\`git ${act}\``} is never an implementer's job — yours ends at commits on your own branch. When the reviewers have signed off, say so; main runs the merge procedure (and in a shared repo there is none: PRs and merges happen on GitHub, by teammates).`;
}

/** The refusal MAIN gets when it tries to merge in a repo that has no crew merge path. */
export function runRefusal(cls: RepoClass): string {
  return `refusing to merge: ${cls === "shared" ? "this is a SHARED repo — review and merge happen on GitHub, by teammates" : "this repo is NOT IN config/repos.json, so its class is unknown — ask Yong which it is and add the entry; an unlisted repo is never assumed"}. The crew's output is commits on the branch; hand Yong the branch name.`;
}
