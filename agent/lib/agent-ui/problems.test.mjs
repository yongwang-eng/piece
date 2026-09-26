import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problems, resetProblems } from './problems.ts';

function ui() {
  const calls = { notify: [], status: [] };
  const ctx = { hasUI: true, ui: { notify: (m, l) => calls.notify.push([m, l]), setStatus: (k, t) => calls.status.push([k, t]) } };
  return { ctx, calls };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'problems-'));
  t.after(() => { resetProblems(); rmSync(dir, { recursive: true, force: true }); });
  const hooks = new Map();
  const p = problems({ on: (n, fn) => hooks.set(n, fn) }, join(dir, 'problems.log'));
  const start = (ctx) => hooks.get('session_start')({}, ctx);
  return { dir, p, start };
}

test('the same key reported 50 times is ONE toast and a footer count, not 50 lines', t => {
  const { p, start } = fixture(t);
  const { ctx, calls } = ui();
  start(ctx);
  for (let i = 0; i < 50; i++) p.report('usage.capture', 'capture failed: stale or invalid owner');
  assert.equal(calls.notify.length, 2, 'first sight + ×10');   // 1, 10 — 100 not reached
  assert.match(calls.notify[0][0], /capture failed/);
  assert.equal(calls.notify[0][1], 'warning');
  assert.match(calls.notify[1][0], /×10/);
  assert.deepEqual(calls.status.at(-1), ['problems', '⚠ 1 problem ×50 · /problems']);
  assert.equal(p.list().length, 1);
  assert.equal(p.list()[0].count, 50);
});

test('every occurrence lands in the log file, coalescing is for the screen only', t => {
  const { dir, p, start } = fixture(t);
  start(ui().ctx);
  p.report('a', 'first');
  p.report('a', 'second wording, same key');
  p.report('b', 'other', { hint: 'run /reload' });
  const lines = readFileSync(join(dir, 'problems.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /a ×2 .*second wording/);
  assert.match(lines[2], /b ×1 .*other .*hint: run \/reload/);
  assert.equal(p.list().find((x) => x.key === 'a').message, 'second wording, same key', 'latest wording wins');
});

test('two keys → the footer counts problems, the toast names the new one', t => {
  const { p, start } = fixture(t);
  const { ctx, calls } = ui();
  start(ctx);
  p.report('a', 'A broke');
  p.report('b', 'B broke');
  assert.equal(calls.notify.length, 2);
  assert.deepEqual(calls.status.at(-1), ['problems', '⚠ 2 problems ×2 · /problems']);
});

test('no UI attached yet (headless, or before session_start) → stderr once per key, never lost', t => {
  const { p } = fixture(t);
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  t.after(() => { console.error = orig; });
  p.report('x', 'X broke');
  p.report('x', 'X broke');
  assert.equal(errs.length, 1, 'stderr is the fallback, still coalesced');
  assert.match(errs[0], /X broke/);
});

test('clear() empties the list and the footer', t => {
  const { p, start } = fixture(t);
  const { ctx, calls } = ui();
  start(ctx);
  p.report('a', 'A');
  p.clear();
  assert.equal(p.list().length, 0);
  assert.deepEqual(calls.status.at(-1), ['problems', undefined]);
});

test('the reporter is process-wide: two module instances share one ledger', async t => {
  const { dir, p, start } = fixture(t);
  start(ui().ctx);
  const other = (await import(`./problems.ts?graph=${Date.now()}`)).problems({ on: () => {} }, join(dir, 'problems.log'));
  other.report('shared', 'from another extension');
  assert.equal(p.list().length, 1);
  assert.equal(p.list()[0].key, 'shared');
  assert.ok(existsSync(join(dir, 'problems.log')));
});
