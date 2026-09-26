import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as core from './core.ts';

function harness() {
  let command, panel, resolveModel, rejectModel, request, donePanel, renders = 0;
  const events = new Map(), notices = [];
  const history = [{ role: 'user', content: 'We are building a harness', timestamp: 1 }];
  const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace('export default function btw', 'function btw');
  runInNewContext(`${source}\nbtw(pi);`, {
    ...core, randomUUID: () => 'isolated-request', AbortController, setTimeout, clearTimeout,
    buildSessionContext: (entries) => ({ messages: entries }), convertToLlm: (m) => m,
    getMarkdownTheme: () => ({}), matchesKey: (key, expected) => key === expected,
    truncateToWidth: (s, width) => s.slice(0, width), visibleWidth: (s) => s.length,
    Markdown: class { constructor(text) { this.text = text; } render() { return this.text.split('\n'); } invalidate() {} },
    BorderedLoader: class { render() { return ['answering']; } dispose() {} invalidate() {} },
    // No transcript mutation, tool execution, or main-agent messaging API is provided.
    pi: { registerCommand: (_, c) => { command = c; }, on: (name, fn) => events.set(name, fn) },
  });
  const ctx = {
    mode: 'tui', model: { id: 'session-model', provider: 'session-provider' },
    sessionManager: { getEntries: () => history, getLeafId: () => 'leaf' },
    modelRegistry: { complete(model, context, options) { request = { model, context, options }; return new Promise((resolve, reject) => { resolveModel = resolve; rejectModel = reject; }); } },
    ui: { notify: (text) => notices.push(text), custom: (factory) => new Promise((resolve) => {
      donePanel = resolve;
      panel = factory({ terminal: { rows: 30 }, requestRender: () => { renders++; } }, { fg: (_, s) => s, bg: (_, s) => s }, {}, () => { panel.dispose(); resolve(); });
    }) },
  };
  return { ctx, history, notices, events, run: (q = 'What are we building?') => command.handler(q, ctx), request: () => request,
    panel: () => panel, resolve: (text) => resolveModel({ stopReason: 'stop', content: [{ type: 'text', text }] }),
    reject: (e) => rejectModel(e), renders: () => renders, shutdown: () => { events.get('session_shutdown')(); donePanel?.(); } };
}
const flush = () => new Promise(setImmediate);

test('side answer uses session model with no tools and leaves main history unchanged', async () => {
  const h = harness(), before = structuredClone(h.history);
  const run = h.run();
  assert.equal(h.request().model, h.ctx.model);
  assert.equal(h.request().context.tools, undefined);
  assert.match(h.request().context.messages[0].content, /We are building a harness/);
  h.resolve('A harness'); await flush();
  assert.match(h.panel().render(80).join('\n'), /A harness/);
  h.panel().handleInput('enter'); await run;
  assert.deepEqual(h.history, before);
});

test('Escape aborts and dismisses immediately; late completion cannot repaint', async () => {
  const h = harness(); const run = h.run();
  h.panel().handleInput('escape'); await run;
  assert.equal(h.request().options.signal.aborted, true);
  h.resolve('late answer'); await flush();
  assert.equal(h.renders(), 0);
});

test('provider failure is visible, and reload aborts outstanding request', async () => {
  const h = harness(); const run = h.run();
  h.reject(new Error('provider offline')); await flush();
  assert.match(h.panel().render(80).join('\n'), /provider offline/);
  h.panel().handleInput('escape'); await run;
  const next = h.run(); h.shutdown(); await next;
  assert.equal(h.request().options.signal.aborted, true);
});

test('empty input never calls the model', async () => {
  const h = harness(); await h.run('  ');
  assert.equal(h.request(), undefined);
  assert.match(h.notices[0], /Usage/);
});

test('loading and answer occupy a bordered, full-width opaque rectangle', async () => {
  const h = harness(); const run = h.run();
  try {
    for (const phase of ['loading', 'answer']) {
      if (phase === 'answer') { h.resolve('Short answer\n\nSecond line'); await flush(); }
      const rows = h.panel().render(60);
      assert.ok(rows[0].startsWith('╭'), `${phase}: top border missing`);
      assert.ok(rows.at(-1).startsWith('╰'), `${phase}: bottom border missing`);
      assert.ok(rows.every((line) => line.length === 60), `${phase}: unfilled rows let transcript show through`);
    }
  } finally { h.panel().handleInput('escape'); await run; }
});
