// reviewer-solo: read-only. May READ the PR thread (gh pr view, gh api …comments GET) — it is the one lane of a
// quick review, so there is nothing to stay blind for. Still never posts, approves, or mutates git.
import type { Block, RoleRules } from "../../lib/guards/index.ts";

export function reviewerSoloBashRule(cmd: string): Block {
  if (/gh\s+pr\s+(review|comment|merge|edit|close|ready|checkout)\b|gh\s+api\s+(-X\s*(POST|PATCH|PUT|DELETE)|--method\s*(POST|PATCH|PUT|DELETE))|gh\s+api\s+\S+\s+-f\b/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: reviewer-solo never posts, approves, or mutates the PR. Draft the comment in deliverable.md; Yong posts." };
  if (/\bgit\s+(push|commit|checkout\s+-b|reset\s+--hard|clean|stash\s+drop|rebase|merge|cherry-pick|am)\b|\bgh\s+(release|repo\s+delete)/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: reviewer-solo is read-only. Inspect, do not mutate." };
  return undefined;
}

export const rules: RoleRules = { bash: (cmd) => reviewerSoloBashRule(cmd) };
