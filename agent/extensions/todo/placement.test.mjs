import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as core from './core.ts';

test('todo renders below input and requests crew repaint after every update', async () => {
  const events = new Map(), calls = [];
  const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace('export default function todo', 'function todo');
  runInNewContext(`${source}\ntodo(pi);`, {
    ...core, Type: new Proxy({}, { get: () => () => ({}) }),
    pi: { on: (n, f) => events.set(n, f), registerTool() {}, registerCommand() {}, events: { emit: (name) => calls.push(name) } },
  });
  const ctx = { cwd: '/fixture', sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { tasks: [{ id: 1, text: 'Keep activity visible', status: 'pending', blockedBy: [] }], nextId: 2 } } }] }, ui: { setWidget: (key, lines, options) => calls.push({ key, lines, options }) } };
  for (const event of ['session_start', 'agent_start']) {
    calls.length = 0;
    await events.get(event)({}, ctx);
    assert.equal(calls[0].key, 'todo');
    assert.equal(calls[0].options?.placement, 'belowEditor');
    assert.equal(calls[1], 'todo:painted');
  }
});
