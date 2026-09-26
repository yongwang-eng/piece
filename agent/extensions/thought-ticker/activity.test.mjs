import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as ticker from './ticker.ts';

function harness() {
  const events = new Map();
  let lines;
  const ctx = { hasUI: true, ui: { theme: { fg: (_, s) => s }, setWidget: (_key, value) => { lines = value; } } };
  const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace('export default function', 'function extension');
  runInNewContext(`${source}\nextension(pi);`, {
    ...ticker, process: { stdout: { columns: 100 } },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    pi: { on: (name, fn) => events.set(name, fn), registerEntryRenderer() {}, appendEntry() {} },
  });
  return { fire: (name, event = {}) => events.get(name)?.(event, ctx), text: () => lines?.join('\n') ?? '', lines: () => lines };
}

test('startup and settled idle are explicit; shutdown removes the widget', () => {
  const h = harness(); h.fire('session_start'); assert.match(h.text(), /Idle/);
  h.fire('agent_start'); assert.match(h.text(), /waiting for first token/);
  h.fire('agent_end'); h.fire('agent_settled'); assert.match(h.text(), /Idle/);
  h.fire('session_shutdown'); assert.equal(h.lines(), undefined);
});

test('writing and argument streaming retain activity; tool and reasoning controls still render', () => {
  const h = harness(); h.fire('agent_start');
  h.fire('message_update', { assistantMessageEvent: { type: 'text_start' } });
  assert.match(h.text(), /Writing/);
  h.fire('message_update', { assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', name: 'bash' }] } } });
  assert.match(h.text(), /Calling bash/);
  h.fire('tool_execution_start', { toolName: 'bash', args: { command: 'pwd' } });
  assert.match(h.text(), /⚙ bash pwd/);
  h.fire('tool_execution_end'); assert.match(h.text(), /waiting for first token/);
  h.fire('message_update', { assistantMessageEvent: { type: 'thinking_start' } });
  assert.match(h.text(), /Reasoning/);
});
