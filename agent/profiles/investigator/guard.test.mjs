import assert from "node:assert/strict";
import test from "node:test";
import { investigatorBashRule } from "./guard.ts";

test("investigator: read-only on git, never posts to Slack/incident.io/notebooks", () => {
  for (const cmd of ["git push", "git commit -m x", "gh pr comment 1", "curl -X POST https://slack.com/api/chat.postMessage", "curl -X PATCH https://api.incident.io/v2/incidents/1", "curl -X POST https://api.datadoghq.com/api/v1/notebooks/1"])
    assert.ok(investigatorBashRule(cmd)?.block, `should block: ${cmd}`);
  for (const cmd of ["git show origin/main:packages/api/src/webhooks/webhook-deliverer.ts", "git log -S findById --since=2026-09-01", "rg -n datadogAttemptsExhausted packages", "curl -s https://api.datadoghq.com/api/v1/query?query=x", "gh pr view 72855"])
    assert.equal(investigatorBashRule(cmd), undefined, `should allow: ${cmd}`);
});
