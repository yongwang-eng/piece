import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfilePool } from './pool.ts';
import { runBrowser, guardTyping, validateRequest } from './session.ts';

const fixtures = () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-session-'));
  const calls = [];
  const base = { pool: new ProfilePool(join(root, 'profiles')), runtimeRoot: join(root, 'tasks'), invoke: async (args) => {
    calls.push(args);
    return args[0] === 'open' ? `### Browser opened with pid ${process.pid}.` : 'OK';
  } };
  return { base, calls };
};
const request = (session, command, args = [], identity) => ({ session, command, args, identity });

test('main and worker contend for the same identity, then hand over the same directory', async () => {
  const { base, calls } = fixtures();
  const main = { ...base, owner: 'main:a' }, worker = { ...base, owner: 'crew:r:b' };
  await runBrowser(request('first', 'open', ['https://example.com'], 'github'), main);
  const dir = calls[0].at(-1);
  await assert.rejects(runBrowser(request('second', 'open', ['https://example.com'], 'github'), worker), /in use/);
  await runBrowser(request('first', 'close'), main);
  await runBrowser(request('second', 'open', ['https://example.com'], 'github'), worker);
  assert.equal(calls.at(-1).at(-1), dir);
  await assert.rejects(runBrowser(request('first', 'snapshot'), main), /Open this task/);
  await runBrowser(request('second', 'close'), worker);
});

test('two anonymous owners get separate profile dirs even with identical task names', async () => {
  const { base, calls } = fixtures();
  for (const owner of ['main:a', 'crew:r:b']) await runBrowser(request('same', 'open', ['https://example.com']), { ...base, owner });
  assert.notEqual(calls[0].at(-1), calls[1].at(-1));
});

test('typing uses a fresh snapshot and blocks auth before dispatch; public field is held-fixed control', async () => {
  const { base } = fixtures();
  let url = 'https://acme.okta.com/login';
  let inline = false;
  const actions = [];
  const options = { ...base, owner: 'main:a', invoke: async (args, cwd) => {
    actions.push(args[0]);
    if (args[0] === 'open') return `opened with pid ${process.pid}`;
    if (args[0] === 'snapshot') {
      writeFileSync(join(cwd, 'snapshot.yml'), '- textbox "Search" [ref=e1]');
      return inline ? `Page URL: ${url}\n\`\`\`yaml\n- textbox "Search" [ref=e1]\n\`\`\`` : `Page URL: ${url}\n[Snapshot](snapshot.yml)`;
    }
    return 'OK';
  } };
  await runBrowser(request('auth_check', 'open', ['https://example.com']), options);
  await assert.rejects(runBrowser(request('auth_check', 'fill', ['e1', 'value']), options), /authentication surface/);
  assert.equal(actions.includes('fill'), false);
  url = 'https://example.com';
  await runBrowser(request('auth_check', 'fill', ['e1', 'value']), options);
  assert.deepEqual(actions.slice(-2), ['snapshot', 'fill']);
  inline = true;
  await runBrowser(request('auth_check', 'fill', ['e1', 'value']), options);
  assert.deepEqual(actions.slice(-2), ['snapshot', 'fill']);
  url = 'https://acme.okta.com/login';
  await assert.rejects(runBrowser(request('auth_check', 'fill', ['e1', 'value']), options), /authentication surface/);
  assert.equal(actions.at(-1), 'snapshot');
  await runBrowser(request('auth_check', 'close'), options);
});

test('credential descriptors, unknown evidence, flags and file escapes fail closed', () => {
  assert.throws(() => guardTyping('fill', ['e1', 'x'], 'Page URL: https://example.com', '- textbox "Password" [ref=e1]'), /authentication/);
  assert.throws(() => guardTyping('press', ['Enter'], 'missing URL', 'textbox'), /unknown/);
  assert.throws(() => guardTyping('fill', ['e9', 'x'], 'Page URL: https://example.com', 'textbox [ref=e1]'), /Target is absent/);
  for (const r of [request('../escape', 'open'), request('a', 'run-code'), request('a', 'open', ['--profile=/other']), request('a', 'screenshot', ['../escape.png']), request('a', 'goto', ['file:///tmp/a'])]) assert.throws(() => validateRequest(r));
});
