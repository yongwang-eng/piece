import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ProfilePool, PROFILES, inferProfile } from './pool.ts';

// fixture registry: leasing logic must not depend on this machine's config/browser_profiles.json
const FIX = [
  { name: 'github', identities: ['github'], hosts: ['github.com'] },
  { name: 'a-okta', identities: ['a', 'okta'], hosts: ['a.example'] },
  { name: 'b-okta', identities: ['b', 'okta'], hosts: ['b.example'] },
  { name: 'scratch', identities: [], hosts: [], pool: true },
];
const fresh = () => new ProfilePool(mkdtempSync(join(tmpdir(), 'browser-lease-')), FIX);
const github = FIX.find(p => p.name === 'github');

test('unknown/ambiguous identities and host-name lookalikes never choose a logged-in profile', () => {
  assert.throws(() => inferProfile('https://github.com', ['unlisted'], FIX), /Unknown|unknown/);
  assert.throws(() => inferProfile('', ['okta'], FIX), /ambiguous/i);
  assert.equal(inferProfile('https://github.com.attacker.example', undefined, FIX).name, 'scratch');
  assert.equal(inferProfile('https://example.com/github.com', undefined, FIX).name, 'scratch');
  assert.equal(inferProfile('https://github.com/acme', undefined, FIX).name, 'github');
});

test('a stale lease token cannot release another lifetime even in the same process', () => {
  const pool = fresh();
  const lease = pool.lease(github, 'main', 'task_a');
  pool.release({ ...lease, token: 'wrong-lifetime' });
  assert.equal(pool.holder('github')?.run, 'main');
  pool.release(lease);
  assert.equal(pool.holder('github'), undefined);
});

test('a live Chrome without a lease still prevents profile takeover', () => {
  const pool = fresh();
  mkdirSync(pool.dirFor('github'), { recursive: true });
  symlinkSync(`${hostname()}-${process.pid}`, join(pool.dirFor('github'), 'SingletonLock'));
  assert.throws(() => pool.lease(github, 'main', 'task_a'), /Chrome|browser/i);
});
