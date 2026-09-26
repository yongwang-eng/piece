// implementer: the one role with write authority, confined to ONE worktree (its cwd); never commits/pushes — main integrates.
import { join } from "node:path";
import { REVIEW_SLOT, type Block, type RoleRules } from "../../lib/guards/index.ts";
import { workerRefusal } from "../../lib/guards/repo-class.ts";

export function implementerWriteRule(wt: string, tool: string, path: string | undefined): Block {
  if ((tool !== "edit" && tool !== "write") || !path) return undefined;
  const abs = path.startsWith("/") ? path : join(wt, path);
  const inside = abs === wt || abs.startsWith(wt.replace(/\/$/, "") + "/");
  if (!inside) return { block: true, reason: `BLOCKED by governance: writes are confined to your worktree ${wt}. Path ${path} is outside it.` };
  return undefined;
}

/**
 * The Acme worktree registry — the documented source of truth for tree ↔ branch, which the worktree rules explicitly
 * tell a worker to read before touching any tree. It lives outside every worktree, so plain confinement blocked it
 * (live, 2026-09-11: an implementer could not check its own initial state). Read-only access only: any redirection or
 * in-place edit still falls through to the confinement rule below.
 */
const WORKTREE_REGISTRY = "/Users/me/Code/acme/worktrees.json";

export function implementerBashRule(wt: string, cmd: string, artifactsDir?: string): Block {
  if (artifactsDir && cmd.includes(artifactsDir)) return undefined;   // writing its own deliverable/evidence via bash is always fine
  if (cmd.includes(WORKTREE_REGISTRY) && !/[>]|tee\b|sed\s+-i|\bmv\b|\brm\b/.test(cmd)) return undefined;   // reading the registry is documented practice
  // NEVER, in any repo class (D57): merging, pushing and PRs are not an implementer's job. No approval unlocks them —
  // main runs the merge procedure after sign-off (own repos, governor-authorized), and in a shared repo there is none.
  if (/\bgit\s+push\b/.test(cmd)) return { block: true, reason: workerRefusal("push") };
  if (/\bgit\s+(merge|rebase|cherry-pick|am)\b/.test(cmd)) return { block: true, reason: workerRefusal("merge") };
  if (/\bgh\s+pr\s+(create|merge|close|edit|ready|review|comment|reopen)\b|\bgh\s+release\b/.test(cmd)) return { block: true, reason: workerRefusal("pr") };
  // COMMIT IS FREE on your own branch — a commit is a reversible checkpoint and the gate lives at the merge (D57). It must
  // never be silent (the shim announces every one to the room), and it must name its files: a sweep would commit the tree.
  if (/\bgit\s+(add|commit)\b/.test(cmd)) {
    if (/\bgit\s+add\s+(-A|--all|-u)\b|\bgit\s+add\s+\.(\s|$|&|;)|\bgit\s+commit\s+(-a|--all|-am)\b/.test(cmd))
      return { block: true, reason: "BLOCKED by governance: commit the files you changed explicitly (`git add <paths>`); -A / . / -a would sweep in whatever else is in the tree." };
    return undefined;
  }
  // `git worktree list` and `git branch --show-current` are READS and stay allowed — blocking the whole `worktree` verb
  // stopped an implementer checking its own initial state (live, 2026-09-11). Only mutating subcommands violate
  // one-branch-one-tree. Mistake-class: a false positive here is a defect, not an accepted cost.
  if (/\bgit\s+(checkout|switch|stash|reset\s+--hard|clean|branch\s+-[dDm]|worktree\s+(add|remove|move|prune|repair|lock|unlock))\b/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: one branch, one worktree — never switch, stash, reset --hard or delete branches. Your tree is yours for the whole run." };
  if (/(^|[;&|]\s*)cd\s+(\/|~)/.test(cmd) && !new RegExp(`cd\\s+${wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(cmd))
    return { block: true, reason: `BLOCKED by governance: stay inside ${wt}. Use relative paths.` };
  if (new RegExp(`${REVIEW_SLOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\/|\\s|$)`).test(cmd) && !cmd.includes(wt))
    return { block: true, reason: `BLOCKED by governance: ${REVIEW_SLOT} is the review slot; never operate there.` };
  return undefined;
}

export const rules: RoleRules = {
  bash: (cmd, ctx) => implementerBashRule(ctx.worktree, cmd, ctx.artifactsDir),
  write: (tool, path, ctx) => implementerWriteRule(ctx.worktree, tool, path),
};
