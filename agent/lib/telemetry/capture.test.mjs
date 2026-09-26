import test from 'node:test';
import assert from 'node:assert/strict';
import { usageCapture, installUsageCapture, attachSessionUsage } from './capture.ts';

const message = { role: 'assistant', provider: 'fixture', model: 'small', stopReason: 'stop', content: 'PRIVATE_RESPONSE',
  usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } } };
test('capture correlates SDK turn boundaries without copying response content', () => {
  const frames = [], capture = usageCapture(f => frames.push(f), () => 20);
  capture({ type: 'turn_start', timestamp: 10 }, 'session');
  capture({ type: 'message_end', message }, 'session');
  capture({ type: 'turn_end', message, toolResults: [{ content: 'PRIVATE_TOOL_RESULT' }] }, 'session');
  assert.deepEqual(frames.map(f => f.phase), ['start', 'call', 'end']);
  assert.equal(new Set(frames.map(f => f.turnKey)).size, 1);
  assert.equal(frames[1].totalTokens, 10);
  assert.equal(frames[2].toolCount, 1);
  assert.equal(JSON.stringify(frames).includes('PRIVATE'), false);
});
test('failed zero usage is unknown; successful explicit zero remains zero', () => {
  const frames = [], capture = usageCapture(f => frames.push(f), () => 20);
  const zero = { ...message, usage: { ...message.usage, totalTokens: 0, cost: { total: 0 } } };
  capture({ type: 'message_end', message: { ...zero, stopReason: 'error' } }, 'a');
  capture({ type: 'message_end', message: zero }, 'b');
  assert.equal(frames[0].totalTokens, null);
  assert.equal(frames[0].estimatedCost, null);
  assert.equal(frames[1].totalTokens, 0);
  assert.equal(frames[1].estimatedCost, 0);
  assert.notEqual(frames[0].turnKey, frames[1].turnKey);
  assert.equal(frames[0].startedAt, null);
});
test('telemetry failure is reported without breaking the model event hook', () => {
  const hooks = {}, errors = [];
  installUsageCapture({ on: (t, f) => { hooks[t] = f; } }, () => { throw Error('busy'); }, e => errors.push(e.message));
  assert.doesNotThrow(() => hooks.turn_start({ type: 'turn_start', timestamp: 10 }, { sessionManager: { getSessionId: () => 'session' } }));
  assert.deepEqual(errors, ['busy']);
});

test('attachSessionUsage feeds a session event stream through the same mapper and detaches cleanly', () => {
  const frames = [], errors = [];
  let handler, unsubscribed = false;
  const subscribe = fn => { handler = fn; return () => { unsubscribed = true; }; };
  const detach = attachSessionUsage(subscribe, 'governor:run1', f => frames.push(f), e => errors.push(e));
  handler({ type: 'turn_start', timestamp: 5 });
  handler({ type: 'message_end', message });
  handler({ type: 'turn_end', message, toolResults: [] });
  handler({ type: 'agent_end', messages: [] });          // irrelevant events pass through silently
  assert.deepEqual(frames.map(f => f.phase), ['start', 'call', 'end']);
  assert.equal(frames[1].sessionId, 'governor:run1');
  assert.equal(frames[1].totalTokens, 10);
  assert.equal(new Set(frames.map(f => f.turnKey)).size, 1);
  assert.equal(errors.length, 0);
  detach();
  assert.equal(unsubscribed, true);
});

test('a dropped background summary becomes a compaction frame with applied=false and its real cost', async () => {
  const { installDroppedCompactionCapture } = await import('./capture.ts');
  const handlers = {};
  const frames = [];
  installDroppedCompactionCapture({ events: { on: (ch, h) => { handlers[ch] = h; } } }, f => frames.push(f), e => { throw e; });
  handlers['background-compaction:dropped']({ sessionId: 's1', at: 42, label: 'threshold 200k', why: 'branch changed at splice',
    tokensBefore: 195000, usage: { input: 1, output: 6000, cacheRead: 0, cacheWrite: 0, cost: { total: 0.71 } } });
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.applied, false);
  assert.equal(f.fromExtension, true);
  assert.equal(f.cost, 0.71);
  assert.equal(f.summaryTokens, 6000);
  assert.match(f.reason, /^dropped: branch changed/);
  // unknown usage (aborted mid-stream) → cost null, never 0
  handlers['background-compaction:dropped']({ sessionId: 's1', at: 43, why: 'cancelled', tokensBefore: null, usage: null });
  assert.equal(frames[1].cost, null);
  assert.equal(frames[1].summaryTokens, null);
});

test('a failed background summarizer request is billed as unknown cost, never as zero or a compaction', async () => {
  const { installDroppedCompactionCapture } = await import('./capture.ts');
  const handlers = {}; const frames = [];
  installDroppedCompactionCapture({ events: { on: (ch, h) => { handlers[ch] = h; } } }, f => frames.push(f), e => { throw e; });
  handlers['background-compaction:failed']({ sessionId: 's1', at: 7, label: 'threshold 30k', error: 'The model refused to complete the request' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].applied, false);
  assert.equal(frames[0].cost, null);
  assert.match(frames[0].reason, /^failed: The model refused/);
});

test('an applied background compaction enriches the row (label + post-splice ledger + model) WITHOUT clobbering the real summary size, retrying once if the insert has not landed yet', async () => {
  const { installAppliedCompactionCapture } = await import('./capture.ts');
  const handlers = {};
  const calls = [];
  let hit = false;
  installAppliedCompactionCapture({ events: { on: (ch, h) => { handlers[ch] = h; } } },
    e => { calls.push(e); return hit; }, e => { throw e; }, 5 /* retryMs */);

  // insert already landed → one enrich call, no retry
  hit = true;
  handlers['background-compaction:applied']({ sessionId: 's1', at: 100, label: 'threshold 200k', tokensBefore: 193240, tokensAfter: 12915, model: 'claude-fable-5-1', usage: { output: 4773 } });
  assert.equal(calls.length, 1);
  // tokensAfter is the post-splice MESSAGE LEDGER (summary + kept tail), never the summary size:
  // it moves with keepRecentTokens. session_compact already stored usage.output; enrichment must not touch it.
  assert.deepEqual(calls[0], { sessionId: 's1', at: 100, reason: 'threshold 200k', tokensAfter: 12915, model: 'claude-fable-5-1' });
  assert.equal('summaryTokens' in calls[0], false, 'enrichment must never carry a summary size');

  // insert not landed yet (hook ordering) → one retry after retryMs, then give up silently
  hit = false;
  handlers['background-compaction:applied']({ sessionId: 's2', at: 200, label: 'manual', tokensAfter: null, usage: null });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(calls.length, 3, 'first attempt + exactly one retry');
  assert.equal(calls[2].sessionId, 's2');
  assert.equal(calls[2].tokensAfter, null);
  assert.equal(calls[2].model, null);

  // missing sessionId → ignored entirely
  handlers['background-compaction:applied']({ at: 300, label: 'x' });
  assert.equal(calls.length, 3);
});
