import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(readFileSync(new URL('./tool.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\s*$/gm, '').replace('export function registerBrowserTool', 'function registerBrowserTool');
const load = new Function('runBrowser', 'Type', source + '\nreturn registerBrowserTool;');
const Type = new Proxy({}, { get: () => (...args) => args });

test('actual registrar binds main/worker ownership to the same runner; only worker shutdown closes', async () => {
  const oldName = process.env.PI_CREW_NAME, oldRun = process.env.PI_CREW_RUN;
  const calls = [];
  const register = load(async (...args) => { calls.push(args); return 'OK'; }, Type);
  function host() {
    let tool;
    const events = {};
    register({ registerTool(t) { tool = t; }, on(e, fn) { events[e] = fn; } });
    return { events, execute: params => tool.execute('id', params, undefined, undefined, { sessionManager: { getSessionId: () => 'test-main' } }) };
  }
  try {
    delete process.env.PI_CREW_NAME;
    const main = host();
    await main.execute({ session: 'task', command: 'open' });
    assert.match(calls.at(-1)[1].owner, /^main:/);
    await main.events.session_shutdown();
    assert.equal(calls.length, 1);
    process.env.PI_CREW_NAME = 'test_browser'; process.env.PI_CREW_RUN = 'test_run';
    const worker = host();
    await worker.execute({ session: 'task', command: 'open' });
    assert.equal(calls.at(-1)[1].owner, 'crew:test_run:test_browser');
    await worker.events.session_shutdown();
    assert.deepEqual(calls.at(-1)[0], { session: 'task', command: 'close' });
  } finally {
    if (oldName === undefined) delete process.env.PI_CREW_NAME; else process.env.PI_CREW_NAME = oldName;
    if (oldRun === undefined) delete process.env.PI_CREW_RUN; else process.env.PI_CREW_RUN = oldRun;
  }
});
