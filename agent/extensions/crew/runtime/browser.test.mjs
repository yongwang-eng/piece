import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { workerExtensions } from './tmux.ts';
import { grantsFor, loadMcpInventory, mcpNameViolations } from './mcp-grants.ts';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const mcpGrants ='), source.indexOf('const consultClasses ='));
const grant = new Function('AGENT_DIR', 'loadMcpInventory', 'grantsFor', 'mcpNameViolations', stripTypeScriptTypes(helper) + '\nreturn mcpGrants;')(new URL('../../..', import.meta.url).pathname.replace(/\/$/, ''), loadFixtureInventory, grantsFor, mcpNameViolations);
// the inventory under test is the fixture, not this machine's config/mcp_tools.json — grants logic is what is being checked
function loadFixtureInventory() { return loadMcpInventory(new URL('./mcp_tools.fixture.json', import.meta.url).pathname); }

test('browser capability exposes shared browser tool, never an MCP gateway; needs generates reads only', () => {
  assert.equal(grant('read', undefined, 'browser').tools, 'read,browser');
  const g = grant('read,bash', ['notion:read'], undefined);
  assert.ok(g.tools.startsWith('read,bash,notion_notion-search'), g.tools);
  const names = g.tools.split(',');
  for (const w of ['notion_notion-update-page', 'notion_notion-create-pages', 'notion_notion-create-comment', 'mcp', 'mcpScript', 'mcp__notion']) assert.ok(!names.includes(w), w);
  assert.ok(!names.some((n) => n.startsWith('slack_')), 'no other server');
  assert.deepEqual(g.servers, ['notion']);
  assert.throws(() => grant(undefined, ['notion:read'], undefined), /requires an explicit tools allowlist/);
  assert.throws(() => grant('read,notion_notion-update-page', undefined, undefined), /does not permit/);
  assert.throws(() => grant('read,mcp', ['notion:read'], undefined), /does not permit/);
  assert.equal(grant(undefined, undefined, undefined).tools, undefined, 'control: no needs, no tools ⇒ unchanged (everything, no adapter loaded)');
  const extensions = workerExtensions('/agent', 'browser');
  assert.ok(extensions.includes('/agent/extensions/crew/runtime/browser.ts'));
  assert.ok(!extensions.some(path => /mcp-browser|mcp-adapter/.test(path)));
});
