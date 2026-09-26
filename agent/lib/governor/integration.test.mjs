import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lifecycle from './lifecycle.ts';
import * as prompts from './prompt.ts';
import { makeRequest, decisionCard, decisionOptions } from '../room/consult.ts';

const sdkDir = join(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')).href);
const source = stripTypeScriptTypes(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, '')
  .replace(/^export \{.*\} from .*;$/gm, '')
  .replace(/^export /gm, '');
const req = makeRequest({ id: 'c-demo', run: 'demo', worker: 'researcher', kind: 'clarify',
  question: 'Which did you select: the two-sentence summary (faster to scan, omits individual checkpoints) or the five-item checklist (shows individual checkpoints, longer)?' });
const briefing = { question: req.question, context: 'The presentation preference is unsettled.', checked: [], options: [
  { key: 'summary', label: 'Two-sentence summary', action: 'Use a two-sentence summary.', consequence: 'Faster to scan; omits individual checkpoints.' },
  { key: 'checklist', label: 'Five-item checklist', action: 'Use a five-item checklist.', consequence: 'Shows individual checkpoints; longer.' },
], recommendedOption: 'summary', why: 'For a short demo, scanning speed matters.' };

// Only SDK creation/configuration and provider output are supplied. Governor's actual
// creation, queue, ask/packet prompts and parsing execute against the installed AgentSession and Agent loop.
function harness(replies = ['ESCALATE: Which format?', JSON.stringify(briefing)]) {
  const requests = [], errors = [], sessions = [], loaders = [];
  const deps = { ...lifecycle, ...prompts, readFileSync: () => '{}', join,
    process: { cwd: () => '/fixture' }, getAgentDir: () => '/fixture',
    SessionManager: sdk.SessionManager,
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options) {
        super({ ...options, settingsManager: sdk.SettingsManager.inMemory() });
        this.options = options; loaders.push(this);
      }
      async reload() {} // No resource discovery or disk settings in this deterministic test.
      getSystemPrompt() { return this.options.systemPrompt; }
    },
    async createAgentSession(options) {
      assert.deepEqual(options.tools, []);
      const model = { id: 'fixture', provider: 'fixture', api: 'fixture', name: 'Fixture',
        reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const modelRuntime = {
        getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
        streamSimple: async (_model, context) => {
          requests.push(context);
          const reply = await (replies.shift() ?? '');
          const text = typeof reply === 'string' ? reply : reply.text;
          const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: reply.stopReason ?? 'stop', timestamp: 0,
            api: 'fixture', provider: 'fixture', model: 'fixture',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          return { async *[Symbol.asyncIterator]() { yield { type: 'done' }; }, result: async () => message };
        },
      };
      const result = await sdk.createAgentSession({ ...options, model, modelRuntime,
        settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
      const prompt = result.session.prompt.bind(result.session);
      result.session.prompt = async text => { try { await prompt(text); } catch (e) { errors.push(e.message); throw e; } };
      sessions.push(result.session);
      return result;
    },
  };
  const Governor = new Function(...Object.keys(deps), source + '\nreturn Governor;')(...Object.values(deps));
  return { governor: new Governor(), requests, errors, sessions, loaders };
}

test('production ask followed immediately by packet reaches a second installed Agent turn', async () => {
  const h = harness();
  assert.equal((await h.governor.ask(req, 'No format ruling.')).kind, 'escalate');
  const packet = await h.governor.packet(req, 'No format ruling.');
  assert.deepEqual(h.errors, [], 'packet must not be rejected as already processing');
  assert.equal(h.requests.length, 2, 'packet must actually reach provider boundary');
  assert.match(h.requests[0].messages[0].content[0].text, /# CONSULT/);
  assert.match(h.requests[1].messages.at(-1).content[0].text, /PACKET/);
  assert.match(h.requests[1].systemPrompt, /PACKET.*JSON/);
  assert.deepEqual(decisionOptions('clarify', packet, req).slice(0, 2).map(o => o.label), ['Two-sentence summary', 'Five-item checklist']);
  assert.equal(packet.recommendedOption, 'summary');
});

test('system prompt explicitly permits packet JSON without changing consult or advisory modes', async () => {
  const h = harness();
  await h.governor.warm();
  const system = h.loaders[0].options.systemPrompt;
  assert.match(system, /PACKET.*JSON/);
  assert.match(system, /ANSWER:.*ESCALATE:/);
  assert.match(system, /AGREE:.*CONCERN:.*OPINION:/);
  assert.match(system, /cannot authorize/);
});

test('malformed packet after an escalation leaves conservative controls', async () => {
  for (const raw of ['', 'ESCALATE: Choose a format.', '{broken']) {
    const h = harness(['ESCALATE: Which format?', raw]);
    await h.governor.ask(req, '');
    const packet = await h.governor.packet(req, '');
    assert.equal(packet.options, undefined);
    assert.deepEqual(decisionOptions('clarify', packet, req).map(o => o.key), ['answer', 'show', 'reject']);
  }
});

test('even structured provider output cannot replace human-class or explicit-act controls', async () => {
  const h = harness([JSON.stringify(briefing)]);
  const packet = await h.governor.packet(req, '');
  for (const kind of ['auth', 'irreversible', 'notify', 'money', 'policy', 'scope']) {
    const humanReq = makeRequest({ ...req, kind });
    assert.ok(decisionOptions(kind, packet, humanReq).every(o => !o.key.startsWith('choice:')));
  }
  const explicit = makeRequest({ ...req, action: { verb: 'format', target: 'demo', detail: 'Use the summary.' } });
  assert.ok(decisionOptions('clarify', packet, explicit).every(o => !o.key.startsWith('choice:')));
});


test('packet prompt rejection and provider abort remain empty conservative briefings', async () => {
  const h = harness();
  const session = await h.governor.warm();
  session.prompt = async () => { throw new Error('fixture preflight failure'); };
  assert.deepEqual(await h.governor.packet(req, ''), { checked: [] });
  assert.equal(h.requests.length, 0);
  const aborted = harness([{ text: '', stopReason: 'aborted' }]);
  const packet = await aborted.governor.packet(req, '');
  assert.deepEqual(packet, { checked: [] });
  assert.deepEqual(decisionOptions('clarify', packet, req).map(o => o.key), ['answer', 'show', 'reject']);
});

test('production crew packet SLA shows conservative card and ignores a late briefing', async () => {
  let release;
  const h = harness([new Promise(resolve => { release = resolve; })]);
  const crew = readFileSync(new URL('../../extensions/crew/index.ts', import.meta.url), 'utf8');
  const flow = stripTypeScriptTypes(crew.slice(crew.indexOf('  const decide = async'), crew.indexOf('  const onConsult = async')));
  const cards = [], timers = [];
  const deps = {
    governorFor: () => h.governor, governorContext: () => '', PACKET_SLA_MS: 20000,
    setTimeout: (fn, ms) => { assert.equal(ms, 20000); timers.push(fn); }, log() {},
    homes: new Map(), runDir: () => '', planTextOf: () => '', selectRulings: () => ({ human: [], rulings: [] }),
    openConsults: new Map([[req.id, req]]), decisionCard, decisionOptions,
    pi: { sendMessage: card => cards.push(card) }, ui: { hasUI: false },
  };
  const decide = new Function(...Object.keys(deps), flow + '\nreturn decide;')(...Object.values(deps));
  const pending = decide('demo', req, 'Unsettled preference');
  timers[0](); // Fire the production race's deadline without wall-clock waiting.
  await pending;
  assert.equal(cards.length, 1);
  assert.doesNotMatch(cards[0].content, /Option .*summary|Option .*checklist/);
  const before = cards[0].content;
  assert.ok(deps.openConsults.has(req.id), 'timeout never answers');
  release(JSON.stringify(briefing));
  await h.governor.turn('drain', 'demo');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].content, before, 'late packet cannot replace the timed-out card');
  assert.ok(deps.openConsults.has(req.id));
});
