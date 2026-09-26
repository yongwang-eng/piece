import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pi-browser-persistence-'));
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const config = fileURLToPath(new URL('../../config/browser.json', import.meta.url));
const live = new Set();
const run = (name, ...args) => execFileSync(process.execPath, [cli, `-s=${name}`, ...args], { cwd: root, encoding: 'utf8', timeout: 20_000 });
const open = (name) => { live.add(name); run(name, 'open', 'https://example.com', '--headed', '--config', config, '--profile', join(root, name)); };
const close = (name) => { run(name, 'close'); live.delete(name); };
try {
  open('probe_a');
  assert.match(run('probe_a', 'cookie-get', 'pi_profile_probe'), /not found/);
  run('probe_a', 'cookie-set', 'pi_profile_probe', 'harmless_test_value', '--domain', 'example.com', '--expires', String(Math.floor(Date.now() / 1000) + 86400));
  assert.match(run('probe_a', 'cookie-get', 'pi_profile_probe'), /pi_profile_probe=harmless_test_value/);
  close('probe_a');
  open('probe_a');
  assert.match(run('probe_a', 'cookie-get', 'pi_profile_probe'), /pi_profile_probe=harmless_test_value/);
  open('probe_b');
  assert.match(run('probe_b', 'cookie-get', 'pi_profile_probe'), /not found/);
  console.log('PASS: persistent cookie survives restart; second profile stays isolated.');
  console.log(`Disposable evidence/profile directory: ${root}`);
} finally {
  for (const name of live) close(name);
}
