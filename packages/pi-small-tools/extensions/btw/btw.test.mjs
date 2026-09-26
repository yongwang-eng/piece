import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextText, answerText } from './core.ts';

test('context is text-only, bounded, and does not mutate session messages', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'my question' }, { type: 'image', data: 'SECRET_IMAGE_BYTES' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } }, { type: 'text', text: 'visible answer' }] },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: '/repo' }] },
  ];
  const before = structuredClone(messages);
  const text = contextText(messages);
  assert.match(text, /my question/);
  assert.match(text, /visible answer/);
  assert.match(text, /bash.*\n\/repo/);
  assert.doesNotMatch(text, /SECRET_IMAGE_BYTES|PRIVATE_THINKING/);
  assert.deepEqual(messages, before);
  const truncated = contextText([{ role: 'user', content: 'x'.repeat(100) + 'recent' }], 20);
  assert.match(truncated, /earlier context omitted/);
  assert.ok(truncated.endsWith('recent'));
});

test('answers expose text only and fail loudly for failed or empty completions', () => {
  assert.equal(answerText({ stopReason: 'stop', content: [{ type: 'text', text: 'answer' }] }), 'answer');
  assert.throws(() => answerText({ stopReason: 'error', errorMessage: 'offline', content: [] }), /offline/);
  assert.throws(() => answerText({ stopReason: 'stop', content: [] }), /no text/);
  assert.throws(() => answerText({ stopReason: 'aborted', content: [] }), /aborted/);
});
