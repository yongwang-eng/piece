import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { bundlePath, patchSource, verified } from './cli_patch.mjs';

const skip = !existsSync(bundlePath) && 'browser deps not installed (npm ci in agent/npm/browser)';
const installed = skip ? '' : readFileSync(bundlePath, 'utf8');
const original = installed.replace('let piBrowserExitStarted = false;\n', '').replace('  if (piBrowserExitStarted) return;\n  piBrowserExitStarted = true;\n', '');

test('patch accepts only pinned bytes, is idempotent, and runtime recognizes it', { skip }, () => {
  assert.equal(verified(original), false);
  const patched = patchSource(original);
  assert.equal(verified(patched), true);
  assert.equal(patchSource(patched), patched);
  assert.throws(() => patchSource(original + '\n'), /Unknown Playwright bundle/);
});

async function closeCount(source, reenter) {
  let calls = 0, ack = 0;
  const exits = [];
  const start = source.indexOf('function gracefullyProcessExitDoNotHang(');
  const end = source.indexOf('function exitHandler()', start);
  const sandbox = { setTimeout() {}, process: { exit: (code) => exits.push(code) },
    gracefullyCloseAll() {
      calls++;
      if (reenter && calls === 1) sandbox.close(0);
      return Promise.resolve();
    },
  };
  runInNewContext('let piBrowserExitStarted = false;\n' + source.slice(start, end) + '\nthis.close = gracefullyProcessExitDoNotHang;', sandbox);
  sandbox.close(0, async () => { ack++; });
  await new Promise(setImmediate);
  return { calls, ack, exits };
}

test('production shutdown function: re-entry closes once; ordinary close and acknowledgement hold', { skip }, async () => {
  const patched = patchSource(original);
  assert.equal((await closeCount(original, true)).calls, 2, 'original must reproduce re-entry');
  assert.deepEqual(await closeCount(patched, true), { calls: 1, ack: 1, exits: [0] });
  assert.deepEqual(await closeCount(patched, false), await closeCount(original, false));
});
