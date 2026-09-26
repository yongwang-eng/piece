import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfilePool } from './pool.ts';
import { runBrowser } from './session.ts';

const root = mkdtempSync(join(tmpdir(), 'pi-browser-handover-'));
const pool = new ProfilePool(join(root, 'profiles'));
const options = owner => ({ owner, pool, runtimeRoot: join(root, 'tasks') });
const main = options('main:smoke'), worker = options('crew:smoke:browser');
const session = `handover_${process.pid}`;
const live = new Set();
async function open(owner, identity) {
  live.add(owner);
  return runBrowser({ session, command: 'open', args: ['https://example.com'], identity }, owner);
}
async function close(owner) {
  await runBrowser({ session, command: 'close' }, owner);
  live.delete(owner);
}
const raw = (opened, ...args) => execFileSync(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), `-s=${session}`, ...args], { cwd: /Evidence: (.+)/.exec(opened)[1], encoding: 'utf8', timeout: 20_000 });
try {
  const a = await open(main, 'github');
  const screenshot = await runBrowser({ session, command: 'screenshot', args: ['proof.png'] }, main);
  assert.match(screenshot, /proof\.png/);
  await runBrowser({ session, command: 'goto', args: ['https://demo.playwright.dev/todomvc/'] }, main);
  const before = await runBrowser({ session, command: 'snapshot' }, main);
  const ref = /textbox "What needs to be done\?"[^\n]*\[ref=([^\]]+)\]/.exec(before)?.[1];
  assert.ok(ref, 'demo input must be present');
  await runBrowser({ session, command: 'fill', args: [ref, 'shared browser typing check'] }, main);
  const after = await runBrowser({ session, command: 'snapshot' }, main);
  assert.match(after, /shared browser typing check/);
  assert.ok(before.includes('heading "todos"') && after.includes('heading "todos"'));
  await runBrowser({ session, command: 'goto', args: ['https://example.com'] }, main);
  await assert.rejects(open(worker, 'github'), /in use/);
  live.delete(worker);
  raw(a, 'cookie-set', 'pi_profile_probe', 'harmless_test_value', '--domain', 'example.com', '--expires', String(Math.floor(Date.now() / 1000) + 86400));
  await close(main);
  const b = await open(worker, 'github');
  assert.match(raw(b, 'cookie-get', 'pi_profile_probe'), /pi_profile_probe=harmless_test_value/);
  await close(worker);
  console.log('PASS: occupied identity refused; new owner reuses directory and retains cookie.');

  await open(main, 'scratch');
  await open(worker, 'scratch');
  assert.ok(pool.browserAlive('scratch-1') && pool.browserAlive('scratch-2'), 'same task name under different owners must keep two independent browsers alive');
  console.log('PASS: identical task names under main/worker owners have independent CLI daemons.');
  console.log(`Only disposable profiles used: ${root}`);
} finally {
  for (const owner of live) { try { await close(owner); } catch (error) { console.error(error.message); } }
}
