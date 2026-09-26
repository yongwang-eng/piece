// reviewer: read-only, structurally blind to PR comments/reviews (independence is enforced, not asked).
import type { Block, RoleRules } from "../../lib/guards/index.ts";

export function reviewerBashRule(cmd: string): Block {
  if (/gh\s+pr\s+(view|review|comment|merge|edit|close|ready)|gh\s+api\s+\S*(comments|reviews)|gh\s+pr\s+diff\s+--web/.test(cmd) && !/gh\s+pr\s+diff\b/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: reviewers are blind to PR comments/reviews and never post. Use the description + diff paths in your brief." };
  if (/\bgit\s+(push|commit|checkout\s+-b|reset\s+--hard|clean|stash\s+drop|rebase|merge|cherry-pick|am)\b|\bgh\s+(release|repo\s+delete)/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: reviewers are read-only. Inspect, do not mutate." };
  return undefined;
}

export const rules: RoleRules = { bash: (cmd) => reviewerBashRule(cmd) };
