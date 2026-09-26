import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { makeRequest, decisionCard, decisionOptions, explicitDecision, needsYouLine, withTurn, operationDoneText } from '../../../lib/room/consult.ts';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const flow = stripTypeScriptTypes(source.slice(source.indexOf('  const decide = async'), source.indexOf('  const onConsult = async')));
const request = makeRequest({ id: 'c-example', run: 'test', worker: 'worker', kind: 'clarify', question: 'Resolve the failed row or retain it?' });
const packet = { question: 'Keep the failed job for inspection?', context: 'Retries must stop.', checked: [], options: [
  { key: 'keep', label: 'Keep the row', action: 'Retain the failed row without retrying.', consequence: 'Operators can inspect it.' },
  { key: 'resolve', label: 'Resolve the row', action: 'Resolve the failed row.', consequence: 'The queue no longer retains it.' },
] };

async function trial(picks, { stale = false, input = '', briefing = packet } = {}) {
  const openConsults = new Map([[request.id, request]]);
  const answers = [], cards = [], packets = [], humanHops = [];
  const deps = {
    governorFor: () => ({ packet: async () => briefing }), requestAssessment: async () => undefined, halo() {}, governorContext: () => '',
    PACKET_SLA_MS: 1, setTimeout() {}, log() {}, homes: new Map(), runDir: () => '',
    planTextOf: () => '', selectRulings: () => ({ human: [], rulings: [] }), openConsults,
    decisionCard, decisionOptions, explicitDecision,
    pi: { sendMessage: card => cards.push(card) }, ui: { hasUI: true, ui: { input: async () => input } },
    pickDecision: async (_ui, _title, options) => {
      const key = picks.shift();
      if (key !== undefined) assert.ok(options.some(o => o.key === key));
      if (stale) openConsults.delete(request.id);
      return key;
    },
    answerConsult: (id, text, by) => { answers.push({ id, text, by }); openConsults.delete(id); },
    notify() {}, workers: new Map(),
    record: { packet: (run, id, pk) => packets.push({ run, id, pk }), turn() {} }, readFileSync: () => { throw new Error('no console url — the picker fallback is what these tests exercise'); }, AGENT_DIR: '', execFile() {}, needsYouLine, withTurn, borderFor() {}, paint() {}, room: () => ({ send: env => humanHops.push(env) }), humanRequest: (req, pk) => ({ to: ['human'], cc: [req.worker], kind: 'request', re: req.id, task: 'consult', text: JSON.stringify({ consult: { id: req.id, packet: pk } }) }),
  };
  const start = new Function(...Object.keys(deps), flow + '\nreturn decide;')(...Object.values(deps));
  await start('test', request, 'The brief does not settle retention.');
  return { answers, cards, packets, humanHops, pending: openConsults.has(request.id) };
}

test('actual initial and evidence-retry paths relay only the chosen action', async () => {
  for (const picks of [['choice:keep'], ['show', 'choice:keep']]) {
    const result = await trial(picks);
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0].id, request.id);
    assert.match(result.answers[0].text, /Action: Retain the failed row without retrying/);
    assert.doesNotMatch(result.answers[0].text, /Action: Resolve/);
    assert.equal(result.pending, false);
  }
});

test('cancel, stale card and ambiguous free text never authorize', async () => {
  assert.equal((await trial([undefined])).answers.length, 0);
  assert.equal((await trial(['choice:keep'], { stale: true })).answers.length, 0);
  const ambiguous = await trial(['answer'], { input: 'yes', briefing: {} });
  assert.equal(ambiguous.answers.length, 0);
  assert.equal(ambiguous.pending, true);
  assert.equal((await trial(['answer'], { input: 'Keep the row without retrying.', briefing: {} })).answers.length, 1);
});

test('the governor packet is written to the record and the request is re-addressed to the human BEFORE the card', async () => {
  const t = await trial(['approve']);
  assert.equal(t.packets.length, 1); assert.equal(t.packets[0].id, request.id); assert.equal(t.packets[0].pk.question, packet.question);
  assert.equal(t.humanHops.length, 1); assert.deepEqual([t.humanHops[0].to, t.humanHops[0].cc, t.humanHops[0].re], [['human'], [request.worker], request.id]);
});

test('when the console is reachable there is NO picker and NO ping from main: the console syncs the consult to the halo hub; the card says where to decide', async () => {
  const openConsults = new Map([[request.id, request]]);
  const cards = [], pings = [];
  const deps = {
    governorFor: () => ({ packet: async () => packet }), requestAssessment: async () => undefined, halo: (id) => pings.push(id), governorContext: () => '',
    planTextOf: () => '', selectRulings: () => ({ human: [], rulings: [] }), openConsults, decisionCard, decisionOptions, explicitDecision, needsYouLine, withTurn, borderFor() {}, PACKET_SLA_MS: 1, setTimeout() {}, log() {}, homes: new Map(), runDir: () => '',
    pi: { sendMessage: card => cards.push(card) }, ui: { hasUI: true, ui: { input: async () => '' } },
    pickDecision: async () => { throw new Error('the picker must not open when the console is up'); },
    answerConsult: () => { throw new Error('nothing may be answered by main here'); }, notify() {}, workers: new Map(),
    record: { packet() {}, turn() {} }, room: () => ({ send() {} }), humanRequest: () => ({}),
    readFileSync: () => 'http://127.0.0.1:9900/t/abc/\n', AGENT_DIR: '', fetch: async () => ({ ok: true }), execFile() {},
  };
  const start = new Function(...Object.keys(deps), flow + '\nreturn decide;')(...Object.values(deps));
  await start('test', request, 'why');
  assert.ok(openConsults.has(request.id), 'still open — the console decides');
  assert.ok(cards.some(c => /decide in the console: http:\/\/127\.0\.0\.1:9900\/t\/abc\/crews\/test/.test(c.content)));
  assert.deepEqual(pings, [], 'no duplicate: the console→hub sync is the one card on the pill');
});

test('when the console is unreachable the fallback lane posts ONE halo note before the picker', async () => {
  const t = await (async () => {
    const pings = [];
    const openConsults = new Map([[request.id, request]]);
    const deps = {
      governorFor: () => ({ packet: async () => packet }), requestAssessment: async () => undefined, halo: (id, title) => pings.push({ id, title }), governorContext: () => '',
      planTextOf: () => '', selectRulings: () => ({ human: [], rulings: [] }), openConsults, decisionCard, decisionOptions, explicitDecision, needsYouLine, withTurn, borderFor() {}, PACKET_SLA_MS: 1, setTimeout() {}, log() {}, homes: new Map(), runDir: () => '',
      pi: { sendMessage() {} }, ui: { hasUI: true, ui: { input: async () => '' } },
      pickDecision: async () => 'approve', answerConsult: (id) => openConsults.delete(id), notify() {}, workers: new Map(),
      record: { packet() {}, turn() {} }, room: () => ({ send() {} }), humanRequest: () => ({}),
      readFileSync: () => { throw new Error('no console'); }, AGENT_DIR: '', fetch: async () => { throw new Error('down'); }, execFile() {},
    };
    const start = new Function(...Object.keys(deps), flow + '\nreturn decide;')(...Object.values(deps));
    await start('test', request, 'why');
    return pings;
  })();
  assert.equal(t.length, 1); assert.equal(t[0].id, `test:${request.id}`); assert.match(t[0].title, /crew worker/);
});

// ── D73 two-key: a listed (mistake-class) act settles on main ✓ + governor ✓; any dissent, or an unlisted act, still reaches Yong ──
const pushReq = makeRequest({ id: 'c-push', run: 'test', worker: 'implementer', kind: 'irreversible', question: 'push crew/x to origin', action: { verb: 'push', target: 'origin crew/x' } });
async function twoKeyTrial({ listed, governor, main, req = pushReq, operation }) {
  const openConsults = new Map([[req.id, { req, run: 'test', twoKey: listed ? { why: 'own repo, no force' } : undefined }]]);
  const settled = [], humanHops = [], cards = [], packets = [], performed = [];
  const deps = {
    operationOf: () => operation, performOperation: async (run, r, op) => { performed.push(op); return { ok: true, files: { [op.refs[0]]: '/run/children/w/secrets/1' } }; }, operationDoneText,
    governorFor: () => ({ packet: async () => ({ recommendation: governor, why: 'branch exists, own repo' }) }),
    requestAssessment: async () => main === undefined ? undefined : { risk: 'low', recommendation: main, why: 'from session', by: 'main', at: 'now' },
    halo: (id, title, body, open, extra) => cards.push({ id, title, body, extra }), governorContext: () => '',
    planTextOf: () => '', selectRulings: () => ({ human: [], rulings: [] }), openConsults, decisionCard, decisionOptions, explicitDecision, needsYouLine, withTurn, borderFor() {}, PACKET_SLA_MS: 1, setTimeout() {}, log() {}, homes: new Map(), runDir: () => '',
    pi: { sendMessage() {} }, ui: { hasUI: true, ui: { input: async () => '' } }, pickDecision: async () => { throw new Error('no picker'); },
    answerConsult: () => { throw new Error('main never answers as the human'); }, notify() {}, workers: new Map(),
    resolveConsult: (run, req, ans) => { settled.push(ans); openConsults.delete(req.id); },
    record: { packet: (run, id, pk) => packets.push(pk), turn() {} }, room: () => ({ send: (env) => humanHops.push(env) }), humanRequest: (r) => ({ to: ['human'], re: r.id }),
    readFileSync: () => 'http://127.0.0.1:9900/t/abc/\n', AGENT_DIR: '', fetch: async () => ({ ok: true }), execFile() {}, Date,
  };
  const start = new Function(...Object.keys(deps), flow + '\nreturn decide;')(...Object.values(deps));
  await start('test', req, 'kind=irreversible is human-only');
  return { settled, humanHops, cards, packets, performed, pending: openConsults.has(req.id) };
}

test('two-key: listed act + governor approve + main approve → settled by two-key, NO hop to the human, one veto-able note', async () => {
  const t = await twoKeyTrial({ listed: true, governor: 'approve', main: 'approve' });
  assert.equal(t.settled.length, 1); assert.equal(t.settled[0].by, 'two-key'); assert.match(t.settled[0].text, /main ✓ governor ✓/);
  assert.equal(t.humanHops.length, 0, 'Yong is not asked');
  assert.equal(t.cards.length, 1); assert.match(t.cards[0].title, /Decided for you/); assert.equal(t.cards[0].extra.actions[0].id, 'veto');
  assert.equal(t.packets.at(-1).twoKey.outcome, 'settled');
  assert.equal(t.pending, false);
});

test('two-key: one dissent (main says "approve, amended" / governor says reject / main silent) → reaches Yong, packet says which key withheld', async () => {
  for (const [governor, main, expect] of [['approve', 'approve, amended (dry run first)', /main ✗/], ['reject', 'approve', /governor ✗/], ['approve', undefined, /main ✗/], ['needs-info', 'approve', /governor ✗/]]) {
    const t = await twoKeyTrial({ listed: true, governor, main });
    assert.equal(t.settled.length, 0, `${governor}/${main}: not settled`);
    assert.equal(t.humanHops.length, 1, `${governor}/${main}: one hop to the human`);
    assert.equal(t.packets.at(-1).twoKey.outcome, 'escalated'); assert.match(t.packets.at(-1).twoKey.keys, expect);
    assert.equal(t.cards.length, 0, 'no "decided" note when nothing was decided');
  }
});

test('two-key: an UNLISTED act with both keys approving still reaches Yong (absence is the deny)', async () => {
  const t = await twoKeyTrial({ listed: false, governor: 'approve', main: 'approve' });
  assert.equal(t.settled.length, 0); assert.equal(t.humanHops.length, 1); assert.equal(t.packets.at(-1).twoKey, undefined);
});

// ── D94: a two-key settle of an OPERATION performs main's act first; the worker is released with the file path, never a bare "proceed" ──
test('two-key + operation: the secret file is written before the worker hears APPROVED, and the answer carries its path', async () => {
  const opReq = makeRequest({ id: 'c-op', run: 'test', worker: 'w', kind: 'policy', question: 'use the Linear credential', action: { verb: 'POST', target: 'api.linear.app/graphql', detail: 'with op://Employee/linear/credential' } });
  const t = await twoKeyTrial({ listed: true, governor: 'approve', main: 'approve', req: opReq, operation: { type: 'op', refs: ['op://Employee/linear/credential'] } });
  assert.equal(t.performed.length, 1, 'main performed the operation');
  assert.equal(t.settled.length, 1); assert.equal(t.settled[0].by, 'two-key');
  assert.match(t.settled[0].text, /op:\/\/Employee\/linear\/credential → \/run\/children\/w\/secrets\/1/);
  assert.equal(t.humanHops.length, 0, 'Yong is not asked');
});
