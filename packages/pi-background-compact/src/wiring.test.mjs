/**
 * Asserts that service.ts actually WIRES `snapshotMessages` into the background service — an
 * invariant no unit test can hold, because background.test.mjs injects that dep itself and stays
 * green when the wiring is deleted. Requires a real pi install; run via `npm run test:integration`,
 * which fails rather than skips when pi cannot be resolved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/** A skip here means the wiring was NOT verified. `npm test` tolerates that; the integration
 *  command sets REQUIRE=1 so a release gate cannot read "green" as "protected". */
function locatePi() {
  const req = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(dirname(req.resolve('@earendil-works/pi-coding-agent'))); } catch { /* not linked here */ }
  candidates.push(resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent'));
  for (const c of candidates) {
    const root = c.endsWith('/dist') ? dirname(c) : c;
    if (existsSync(join(root, 'dist/index.js')) && existsSync(join(root, 'dist/core/session-manager.js'))
        && existsSync(join(root, 'node_modules/jiti/lib/jiti.mjs'))) return root;
  }
  return undefined;
}

const piRoot = locatePi();
const required = process.env.PI_BGC_REQUIRE_INTEGRATION === '1';
if (required && !piRoot) {
  throw new Error('PI_BGC_REQUIRE_INTEGRATION=1 but pi-coding-agent is not resolvable: the wiring assertion cannot run.');
}
const user = (text) => ({ role: 'user', content: text, timestamp: 1 });

test('the shipped service snapshots the branch before auth, so a mid-auth switch cannot swap it',
  { skip: piRoot ? false : 'pi-coding-agent not resolvable (unverified wiring)' }, async (t) => {
  t.after(() => { delete globalThis.__testCompletion; delete process.env.PI_CODING_AGENT_DIR; });
  const { createJiti } = await import(join(piRoot, 'node_modules/jiti/lib/jiti.mjs'));
  const { SessionManager } = await import(join(piRoot, 'dist/core/session-manager.js'));

  const agentDir = mkdtempSync(join(tmpdir(), 'pi-bgc-wiring-'));
  const stub = join(agentDir, 'provider-stub.mjs');
  writeFileSync(stub, `export async function completeSimple(m, c, o) {
    if (typeof globalThis.__testCompletion !== 'function') throw new Error('network forbidden');
    return globalThis.__testCompletion(m, c, o); }\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
    [join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js')]: stub,
  }});
  const { setupService } = await jiti.import(join(packageRoot, 'src/service.ts'));

  const handlers = {}, listeners = {};
  const pi = {
    on: (n, f) => (handlers[n] ??= []).push(f),
    registerCommand: () => {},
    getAllTools: () => [], getActiveTools: () => [],
    events: { on: (n, f) => (listeners[n] ??= []).push(f), emit: (n, d) => { for (const f of listeners[n] ?? []) f(d); } },
  };
  await setupService(pi);
  const svc = globalThis[Symbol.for('pi.agent.backgroundCompaction')];
  assert.ok(svc, 'service published');

  // Two real branches that share a root, each large enough to be worth compacting.
  const sm = SessionManager.inMemory();
  const root = sm.appendMessage(user('common context'));
  sm.appendMessage(user('BRANCH A: mandatory constraint ' + 'A'.repeat(100_000)));
  const tipA = sm.appendMessage(user('A latest tail ' + 'a'.repeat(100_000)));
  sm.branch(root);
  sm.appendMessage(user('BRANCH B: unrelated task ' + 'B'.repeat(100_000)));
  const tipB = sm.appendMessage(user('B latest tail ' + 'b'.repeat(100_000)));
  sm.branch(tipA);

  let projectionReads = 0;
  const build = sm.buildContextEntries.bind(sm);
  sm.buildContextEntries = () => { projectionReads++; return build(); };

  let releaseAuth, releaseSummary, providerInput;
  globalThis.__testCompletion = async (_m, context) => {
    providerInput = JSON.stringify(context.messages);
    return new Promise(r => { releaseSummary = () => r({
      stopReason: 'stop',
      content: [{ type: 'text', text: providerInput.includes('BRANCH A:') ? 'SUMMARY A' : 'SUMMARY B' }],
      usage: { input: 1, output: 100, cacheRead: 20_000, cacheWrite: 0, cost: { total: 0.7 } } }); });
  };

  let splicedOpts;
  const ctx = {
    sessionManager: sm, thinkingLevel: 'off',
    model: { id: 'test', api: 'test-no-network', provider: 'test', maxTokens: 20_000 },
    modelRegistry: { getApiKeyAndHeaders: () => new Promise(r => { releaseAuth = () => r({ ok: true, apiKey: 'fake' }); }) },
    getSystemPrompt: () => '', getContextUsage: () => ({ tokens: 50_000 }), isIdle: () => false,
    ui: { notify: () => {} }, compact: (o) => { splicedOpts = o; },
  };
  for (const f of handlers.session_start ?? []) await f({ reason: 'startup' }, ctx);

  const pending = svc.summarize(ctx, { label: 'A→B→A', autoApply: true });
  assert.equal(projectionReads, 1, 'the branch is projected once, before auth resolves');

  sm.branch(tipB);            // the user switches branches while auth is in flight
  releaseAuth();
  assert.equal(await pending, 'started');
  assert.equal(projectionReads, 1, 'the summarizer must not re-read the live branch after auth');
  assert.ok(providerInput.includes('BRANCH A:'), 'summarized the branch it fingerprinted');
  assert.ok(!providerInput.includes('BRANCH B:'), 'branch B never reached the summarizer');

  sm.branch(tipA);
  releaseSummary();
  await new Promise(r => setImmediate(r));
  assert.equal(svc.apply(ctx), 'applying');
  let spliced;
  for (const f of handlers.session_before_compact ?? []) {
    const out = await f({ reason: 'manual', branchEntries: sm.getBranch() }, ctx);
    if (out?.compaction) spliced = out.compaction;
  }
  assert.equal(spliced.summary, 'SUMMARY A', 'branch A received branch A\'s summary');
  splicedOpts.onComplete({ estimatedTokensAfter: 25_000 });

  // Blocker 2's other half: the advertised log exists on a dir that started empty.
  assert.match(readFileSync(join(agentDir, 'state/compaction.log'), 'utf8'), /applied A→B→A/);
});
