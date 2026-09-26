import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantsFor, isGateway, loadMcpInventory, mcpNameViolations } from "./mcp-grants.ts";

const inv = { notion: { read: ["notion-search", "notion-fetch"] }, slack: { read: ["slack_read_channel"] }, granola: { read: ["get_meetings"] } };

test("<server>:read grants exactly the listed read tools, prefixed the way the adapter names them", () => {
  const g = grantsFor(["notion:read"], inv);
  assert.deepEqual(g.tools, ["notion_notion-search", "notion_notion-fetch"]);
  assert.deepEqual(g.servers, ["notion"]);
  const two = grantsFor(["notion:read", "granola:read"], inv);
  assert.deepEqual(two.tools, ["notion_notion-search", "notion_notion-fetch", "granola_get_meetings"]);
});

test("a write is unlisted, so it is absent — and no token spells 'the whole server'", () => {
  const g = grantsFor(["notion:read"], inv);
  assert.ok(!g.tools.some((t) => /update|create/.test(t)));
  assert.throws(() => grantsFor(["notion"], inv), /name the level/);
  assert.throws(() => grantsFor(["notion:write"], inv), /never a bundle/);
  assert.throws(() => grantsFor(["notion:read:all"], inv), /name the level/);
  assert.throws(() => grantsFor(["jira:read"], inv), /unknown MCP server/);
});

test("the gateways are never granted — by needs, by name, or by prefix", () => {
  for (const n of ["mcp", "mcpScript", "mcp__notion", "mcp__hubmcp"]) assert.ok(isGateway(n), n);
  assert.ok(!isGateway("notion_notion-fetch"));
  assert.ok(!grantsFor(["notion:read", "slack:read"], inv).tools.some(isGateway));
});

test("an explicit tools string cannot smuggle a write or a gateway past the list", () => {
  assert.deepEqual(mcpNameViolations(["read", "bash", "notion_notion-fetch"], inv), []);
  assert.deepEqual(mcpNameViolations(["read", "notion_notion-update-page"], inv), ["notion_notion-update-page"]);
  assert.deepEqual(mcpNameViolations(["slack_slack_send_message", "mcp"], inv), ["slack_slack_send_message", "mcp"]);
  assert.deepEqual(mcpNameViolations(["mcp__slack", "mcpScript"], inv), ["mcp__slack", "mcpScript"]);
  assert.deepEqual(mcpNameViolations(["browser", "consult", "room_send"], inv), [], "non-MCP tools are not this file's business");
});

test("the shipped config loads; the fixture inventory classifies the incident-class tools as absent", () => {
  loadMcpInventory(new URL("../../../config/mcp_tools.json", import.meta.url).pathname);   // per machine: must parse, contents are the owner's
  const real = loadMcpInventory(new URL("./mcp_tools.fixture.json", import.meta.url).pathname);
  const all = Object.values(real).flatMap((s) => s.read);
  for (const w of ["notion-create-pages", "notion-update-page", "notion-create-comment", "notion-move-pages", "slack_send_message", "slack_add_reaction",
    "memory_save", "memory_forget", "browser_use", "call_integration_api", "post_project_channel_message", "call_incidentio_mcp"]) {
    assert.ok(!all.includes(w), `${w} must not be a read`);
  }
  for (const r of ["notion-search", "notion-fetch", "slack_read_channel", "query_snowflake", "get_sentry_issue", "get_meeting_transcript"]) {
    assert.ok(all.includes(r), `${r} is a read a researcher needs`);
  }
  assert.deepEqual(all.filter((t) => /^call_/.test(t)), ["call_data_guides_mcp"], "hubmcp call_* are dispatchers to other servers — gateways; data_guides (two docs tools) is the single verified exception");
  assert.ok(!all.includes("call_integration_api"), "call_integration_api reaches Slack sends and Notion creates through one tool");
});

test("a missing or malformed config is an empty inventory: every grant is refused, nothing is silently widened", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpg-"));
  assert.deepEqual(loadMcpInventory(join(dir, "absent.json")), {});
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.deepEqual(loadMcpInventory(join(dir, "bad.json")), {});
  assert.throws(() => grantsFor(["notion:read"], {}), /unknown MCP server/);
});
