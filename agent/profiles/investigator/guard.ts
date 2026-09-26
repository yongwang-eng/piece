// investigator: read-only on the world. Reading a PR is fine (the fix PR is evidence); posting anywhere is not.
import type { Block, RoleRules } from "../../lib/guards/index.ts";

export function investigatorBashRule(cmd: string): Block {
  if (/\bgit\s+(push|commit|checkout\s+-b|reset\s+--hard|clean|stash\s+drop|rebase|merge|cherry-pick|am)\b|\bgh\s+(release|repo\s+delete)/.test(cmd))
    return { block: true, reason: "BLOCKED by governance: investigators are read-only. Inspect, do not mutate." };
  if (/\bgh\s+(pr|issue)\s+(comment|review|merge|edit|close|ready|create)\b|\bgh\s+api\b.*-X\s*(POST|PATCH|PUT|DELETE)|-X\s*(POST|PATCH|PUT|DELETE)\b.*(slack\.com|incident\.io|datadoghq\.com\/api\/v1\/notebooks)|chat\.postMessage/i.test(cmd))
    return { block: true, reason: "BLOCKED by governance: investigators read; nothing is posted to GitHub, Slack, incident.io or a Datadog notebook. Put it in your deliverable for main." };
  return undefined;
}

export const rules: RoleRules = { bash: (cmd) => investigatorBashRule(cmd) };
