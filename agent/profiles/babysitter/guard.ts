// babysitter: watches a PR, never touches it — posting, re-running CI, merging are human clicks (never-notify rule).
import type { Block, RoleRules } from "../../lib/guards/index.ts";

export function babysitterBashRule(cmd: string): Block {
  if (/\bgh\s+pr\s+(review|comment|merge|edit|close|ready|reopen|checkout|create)\b|\bgh\s+api\b[^|]*\s-(X|-method)\s*(POST|PATCH|PUT|DELETE)|\bgh\s+run\s+(rerun|cancel)|\bgh\s+workflow\s+run|\bgit\s+(push|commit|checkout|switch|reset|rebase|merge)\b/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: babysitters only watch. Posting, re-running CI, merging, or changing the PR are human clicks — put it under NEEDS HUMAN." };
  return undefined;
}

export const rules: RoleRules = { bash: (cmd) => babysitterBashRule(cmd) };
