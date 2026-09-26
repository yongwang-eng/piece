import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, extractDetail, skillFromPrompt } from "./detail.ts";

test("redacts before send", () => {
  assert.equal(redact('export TOKEN=abc123; curl -H "Authorization: Bearer sk_test_abcdefghijklmnopqrstuvwxyz0123"'),
    'export TOKEN=[REDACTED]; curl -H "Authorization: Bearer [REDACTED]"');
  assert.equal(redact("export K=$(op read op://Employee/x/credential)"), "export K=$(op read op://Employee/x/credential)");
  assert.equal(redact("cd /x; gh pr view 1"), "cd /x; gh pr view 1");
});
test("detail is small and shaped like the Claude hook", () => {
  assert.deepEqual(extractDetail("bash", { command: "ls -la" }), { command: "ls -la" });
  assert.deepEqual(extractDetail("read", { path: "/a/b.ts" }), { file_path: "/a/b.ts" });
  assert.equal(extractDetail("bash", { command: "x".repeat(2000) }).command.length, 601);
  const mcp = extractDetail("mcp__slack", { tool: "read", args: { token: "xoxb-1234567890-abcdefghij" } });
  assert.ok(!JSON.stringify(mcp).includes("xoxb-1234"));
});
test("skill detection", () => {
  assert.equal(skillFromPrompt("/pr-review 70992 high"), "pr-review");
  assert.equal(skillFromPrompt("  /sweep"), "sweep");
  assert.equal(skillFromPrompt("please review 70992"), null);
  assert.equal(skillFromPrompt("a/b path"), null);
});
