import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRequest, decisionCard, decisionOptions } from './consult.ts';
import { parsePacket } from '../governor/prompt.ts';

const request = () => makeRequest({ id: 'c-test-1', run: 'test', worker: 'implementer', kind: 'clarify', question: 'Should terminal failures resolve the row or retain it for inspection?' });
const briefing = {
  question: 'What should happen to a permanently failed job?',
  context: 'The worker needs one final-state behavior before implementing the change.',
  options: [
    { key: 'resolve', label: 'Resolve the row', action: 'Resolve the permanently failed job row.', consequence: 'The queue no longer retains that row for inspection.' },
    { key: 'retain', label: 'Retain for inspection', action: 'Retain the permanently failed job row without retrying it.', consequence: 'Operators can inspect the row; retained rows need a cleanup policy.' },
  ],
  recommendedOption: 'retain', why: 'Preserves inspectability while stopping retries.', checked: [],
};

test('either/or fallback never offers blanket approval when briefing is absent', () => {
  const opts = decisionOptions('clarify', undefined, request());
  assert.ok(!opts.some(o => o.key === 'approve' || o.key === 'amend'));
  assert.ok(opts.some(o => o.key === 'answer'));
});

test('structured packet yields named choices, complete implications and an explicit selected action', () => {
  const parsed = parsePacket(JSON.stringify(briefing));
  const packet = { ...parsed, whyHuman: 'The intended operational behavior is not settled in the brief.' };
  const card = decisionCard(request(), packet).join('\n');
  assert.match(card, /What should happen to a permanently failed job\?/);
  assert.match(card, /Operators can inspect the row; retained rows need a cleanup policy/);
  assert.match(card, /▶ Governor: Retain for inspection.*Preserves inspectability/);
  assert.match(card, /Original request: Should terminal failures/);
  const options = decisionOptions('clarify', packet, request());
  const chosen = options.find(o => o.label === 'Retain for inspection');
  assert.equal(chosen?.recommended, true);
  assert.match(chosen?.answer ?? '', /Retain the permanently failed job row without retrying it/);
  assert.ok(!options.some(o => o.key === 'approve'));
});

test('malformed options cannot introduce a hidden or ambiguous authorization', () => {
  for (const options of [[briefing.options[0]], [briefing.options[0], briefing.options[0]], [{ ...briefing.options[0], consequence: '' }, briefing.options[1]]]) {
    const packet = parsePacket(JSON.stringify({ ...briefing, options }));
    assert.equal(packet.options, undefined);
    assert.ok(!decisionOptions('clarify', packet, request()).some(o => o.answer));
  }
});

test('model-generated choices cannot replace an explicit human-class action', () => {
  const packet = { ...parsePacket(JSON.stringify(briefing)), recommendation: 'approve', whyHuman: 'Human-only action.' };
  for (const kind of ['auth', 'notify', 'money', 'policy', 'scope', 'irreversible']) {
    const req = makeRequest({ id: 'c-explicit', run: 'test', worker: 'worker', kind, question: 'May I perform this exact action?', action: { verb: 'do', target: 'ONLY the explicitly named target' }, intent: { why: 'w', exact: 'do X', effect: 'e', reversible: 'no', ifDenied: 'stop' } });
    const options = decisionOptions(kind, packet, req);
    assert.ok(!options.some(o => o.answer || o.key.startsWith('choice:')), kind);
    assert.match(decisionCard(req, packet).join('\n'), /Action: do — ONLY the explicitly named target/);
  }
});

test('human-only classes without submitted actions stay non-authorizable despite model options', () => {
  const packet = { ...parsePacket(JSON.stringify(briefing)), whyHuman: 'Human-only.' };
  for (const kind of ['auth', 'notify', 'money', 'policy', 'scope', 'irreversible']) {
    const req = makeRequest({ id: 'c-missing', run: 'test', worker: 'worker', kind, question: 'Which route should I take?' });
    const keys = decisionOptions(kind, packet, req).map(o => o.key);
    assert.deepEqual(keys, ['answer', 'show', 'reject'], `${kind}: direction (human states the act himself), evidence, refuse`);
    assert.ok(!keys.some(k => k === 'approve' || k === 'self' || k === 'amend' || k.startsWith('choice:')), `${kind}: nothing one-click authorizes an unstated act`);
  }
});
