import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundCompaction, fingerprintOf, fingerprintHolds } from './background.ts';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
const entry = (id, type = 'message') => ({ id, type });
const branch = (...ids) => ids.map(id => entry(id));
const prep = (firstKeptEntryId, tokensBefore = 200_000) => ({ firstKeptEntryId, tokensBefore, messagesToSummarize: [{}], turnPrefixMessages: [], isSplitTurn: false });
const result = (usage = { input: 1, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.7 } }) =>
  ({ summary: 'S', firstKeptEntryId: 'e5', tokensBefore: 200_000, usage });

function harness({ prepare = () => prep('e5'), compact, entries = branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6'), sessionId = 'sess', blocksOf } = {}) {
  const events = [];
  let resolveCompact, rejectCompact;
  const deps = {
    prepare,
    ...(blocksOf ? { blocksOf } : {}),
    compact: compact ?? (() => new Promise((res, rej) => { resolveCompact = res; rejectCompact = rej; })),
    auth: async () => ({ ok: true, apiKey: 'k' }),
    settings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 10_000 }),
    emit: (channel, data) => events.push({ channel, ...data }),
    now: () => 1000,
  };
  const ctx = {
    branch: entries,
    sessionManager: { getBranch: () => ctx.branch, getSessionId: () => sessionId },
    model: { id: 'm', provider: 'p' },
    modelRegistry: { getApiKeyAndHeaders: deps.auth },
    compactCalls: 0,
    compact(opts) { ctx.compactCalls++; ctx.lastCompactOpts = opts; },
  };
  const svc = createBackgroundCompaction(deps);
  return { svc, ctx, events, deps, resolve: (r) => resolveCompact(r), reject: (e) => rejectCompact(e) };
}
const tick = () => new Promise(r => setImmediate(r));

// ── snapshot immutability ───────────────────────────────────────────────────────────
test('a branch switch during the auth await cannot change what gets summarized', async () => {
  // The fingerprint authenticates the prefix captured BEFORE auth. If the summarizer input is
  // read from the live branch AFTER auth, A->B->A yields a summary of B that fingerprints as A
  // and splices into A. Preparation, fingerprint and messages must come from ONE snapshot.
  let releaseAuth;
  const h = harness({ entries: branch('a1', 'a2', 'a3', 'a4', 'a5', 'a6') });
  h.deps.snapshotMessages = (ctx, firstKeptEntryId) =>
    ctx.sessionManager.getBranch().map(e => `msg:${e.id}`).concat(`kept:${firstKeptEntryId}`);
  const seen = [];
  h.deps.compact = (req) => { seen.push(req); return new Promise(() => {}); };
  h.ctx.modelRegistry.getApiKeyAndHeaders = () =>
    new Promise(res => { releaseAuth = () => res({ ok: true, apiKey: 'k' }); });

  const started = h.svc.summarize(h.ctx, { label: 'threshold' });
  await tick();
  h.ctx.branch = branch('b1', 'b2', 'b3', 'b4', 'b5', 'b6');   // user hits /tree mid-auth
  releaseAuth();
  await started;
  await tick();

  assert.equal(seen.length, 1, 'one request went out');
  const msgs = seen[0].messages;
  assert.ok(Array.isArray(msgs), 'the request carries an immutable message snapshot');
  assert.ok(msgs.every(m => !String(m).startsWith('msg:b')), `summarized branch B: ${JSON.stringify(msgs)}`);
  assert.ok(msgs.some(m => String(m).startsWith('msg:a')), 'summarized the branch it fingerprinted');
});

// ── fingerprint ─────────────────────────────────────────────────────────────────────────────
test('fingerprint holds while the summarized prefix is still the branch prefix', () => {
  const fp = fingerprintOf('sess', branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6'), 'e5');
  assert.equal(fingerprintHolds(fp, 'sess', branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8')), true, 'growth after the snapshot is fine');
  assert.equal(fingerprintHolds(fp, 'other', branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6')), false, 'different session');
  assert.equal(fingerprintHolds(fp, 'sess', branch('e1', 'e2', 'e3', 'e4')), false, 'kept entry missing (branch switched / tree navigation)');
  assert.equal(fingerprintHolds(fp, 'sess', branch('e1', 'e2', 'X', 'e4', 'e5', 'e6')), false, 'prefix changed');
  const compacted = [...branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6'), entry('c1', 'compaction'), entry('e7')];
  assert.equal(fingerprintHolds(fp, 'sess', compacted), false, 'someone else compacted in between');
});

// ── one at a time ────────────────────────────────────────────────────────────────────────────
test('one summarization in flight: a second summarize() is refused, not queued', async () => {
  const { svc, ctx, deps } = harness();
  assert.equal(await svc.summarize(ctx, { label: 'threshold' }), 'started');
  assert.equal(await svc.summarize(ctx, { label: 'threshold' }), 'busy');
  assert.equal(svc.status().state, 'summarizing');
});

test('nothing to compact → idle, no request made', async () => {
  let compactCalls = 0;
  const { svc, ctx } = harness({ prepare: () => undefined, compact: () => { compactCalls++; return new Promise(() => {}); } });
  assert.equal(await svc.summarize(ctx, { label: 'threshold' }), 'nothing');
  assert.equal(compactCalls, 0);
  assert.equal(svc.status().state, 'idle');
});

// ── the splice ───────────────────────────────────────────────────────────────────────────────
test('ready result is handed to pi through the before-compact hook, once, and only for our own splice', async () => {
  const { svc, ctx, resolve, events } = harness();
  await svc.summarize(ctx, { label: 'threshold', autoApply: true });
  resolve(result()); await tick();
  assert.equal(svc.status().state, 'ready');
  assert.equal(events.at(-1).channel, 'background-compaction:ready');

  // a user /compact that is NOT our splice must not receive the stash
  assert.equal(svc.beforeCompact({ reason: 'manual', branchEntries: ctx.branch }, ctx), undefined);

  // our own apply: requests pi.compact and answers the hook with the result
  assert.equal(svc.apply(ctx), 'applying');
  assert.equal(ctx.compactCalls, 1);
  const answer = svc.beforeCompact({ reason: 'manual', branchEntries: [...ctx.branch, entry('e7')] }, ctx);
  assert.equal(answer?.compaction?.summary, 'S');
  // second hook call (defensive) gets nothing — the stash is spent
  assert.equal(svc.beforeCompact({ reason: 'manual', branchEntries: ctx.branch }, ctx), undefined);
  ctx.lastCompactOpts.onComplete({ tokensBefore: 200_000, estimatedTokensAfter: 80_000 });
  assert.equal(svc.status().state, 'idle');
  assert.equal(events.at(-1).channel, 'background-compaction:applied');
});

test('a stale stash at splice time is CANCELLED, never replaced by a foreground summarizer', async () => {
  const { svc, ctx, resolve, events } = harness();
  await svc.summarize(ctx, { label: 'threshold' });
  resolve(result()); await tick();
  svc.apply(ctx);
  // between apply() and the hook, the branch changed under us
  const answer = svc.beforeCompact({ reason: 'manual', branchEntries: branch('e1', 'zz') }, ctx);
  assert.deepEqual(answer, { cancel: true });
  ctx.lastCompactOpts.onError(new Error('Compaction cancelled'));
  assert.equal(svc.status().state, 'idle');
  const dropped = events.find(e => e.channel === 'background-compaction:dropped');
  assert.ok(dropped, 'the discarded summary is reported');
  assert.equal(dropped.usage.cost.total, 0.7, 'with the money it cost');
});

// ── exactly-once accounting for work that never lands ───────────────────────────────────────
test('someone else compacting while we are ready drops the stash and reports its usage once', async () => {
  const { svc, ctx, resolve, events } = harness();
  await svc.summarize(ctx, { label: 'threshold' });
  resolve(result()); await tick();
  svc.afterCompact({ fromExtension: false, reason: 'manual' }, ctx);   // user pressed /compact
  assert.equal(svc.status().state, 'idle');
  assert.equal(events.filter(e => e.channel === 'background-compaction:dropped').length, 1);
  svc.afterCompact({ fromExtension: false, reason: 'manual' }, ctx);   // again: nothing left to drop
  assert.equal(events.filter(e => e.channel === 'background-compaction:dropped').length, 1);
});

test('shutdown while summarizing accounts immediately (cost unknown) and a late result is ignored, never spliced', async () => {
  let signal;
  const { svc, ctx, events } = harness({ compact: ({ signal: s }) => { signal = s; return new Promise(() => {}); } });
  await svc.summarize(ctx, { label: 'threshold', autoApply: true });
  svc.shutdown();
  assert.equal(signal.aborted, true, 'the provider request is cancelled');
  assert.equal(svc.status().state, 'idle');
  const d = events.at(-1);
  assert.equal(d.channel, 'background-compaction:dropped');
  assert.equal(d.why, 'shutdown');
  assert.equal(d.usage, null, 'aborted mid-stream: cost unknown, not zero');
  assert.equal(d.sessionId, 'sess', 'accounted to the right session without a ctx');
  assert.equal(ctx.compactCalls, 0);
});

test('shutdown while READY reports the exact cost of the summary that will never be applied', async () => {
  const { svc, ctx, resolve, events } = harness();
  await svc.summarize(ctx, { label: 'threshold', autoApply: true });
  resolve(result()); await tick();
  svc.shutdown();
  const d = events.at(-1);
  assert.equal(d.channel, 'background-compaction:dropped');
  assert.equal(d.usage.cost.total, 0.7);
  assert.equal(events.filter(e => e.channel === 'background-compaction:dropped').length, 1, 'once');
});

test('summarizer failure → idle + failed event; nothing is spliced, nothing blocks', async () => {
  const { svc, ctx, reject, events } = harness();
  await svc.summarize(ctx, { label: 'threshold' });
  reject(new Error('boom')); await tick();
  assert.equal(svc.status().state, 'idle');
  assert.equal(events.at(-1).channel, 'background-compaction:failed');
  assert.equal(ctx.compactCalls, 0);
});

test('cancel() while summarizing aborts the request and reports unknown usage (null), not zero', async () => {
  let signal;
  const { svc, ctx, events } = harness({ compact: ({ signal: s }) => { signal = s; return new Promise(() => {}); } });
  await svc.summarize(ctx, { label: 'manual' });
  svc.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(svc.status().state, 'idle');
  const d = events.at(-1);
  assert.equal(d.channel, 'background-compaction:dropped');
  assert.equal(d.usage, null, 'an aborted stream may have consumed tokens; the amount is unknown');
});

test('settle(): when ready and autoApply, the next settled boundary applies; otherwise nothing', async () => {
  const { svc, ctx, resolve } = harness();
  svc.settle(ctx);
  assert.equal(ctx.compactCalls, 0, 'idle: settle is a no-op');
  await svc.summarize(ctx, { label: 'threshold', autoApply: true });
  svc.settle(ctx);
  assert.equal(ctx.compactCalls, 0, 'still summarizing: never block, never call compact');
  resolve(result()); await tick();
  svc.settle(ctx);
  assert.equal(ctx.compactCalls, 1, 'ready + autoApply → apply at the boundary');
});

test('a shut-down service refuses work and removes itself from the process slot', async () => {
  const { publishBackgroundCompaction, backgroundCompaction } = await import('./background.ts');
  const { svc, ctx } = harness();
  publishBackgroundCompaction(svc);
  assert.equal(backgroundCompaction(), svc);
  svc.shutdown();
  assert.equal(backgroundCompaction(), undefined, 'a trigger after /reload must not find the dead instance');
  assert.equal(await svc.summarize(ctx, { label: 'threshold' }), 'dead');
});

// ── the 20-block lookup window (EXP-008) ────────────────────────────────────────────────────
// A read searches at most 20 blocks back from the breakpoint. If the kept tail is longer than
// that, the entry below the cut is unreachable and the summarizer recovers nothing from the
// message cache. Tighten the cut so the tail can never exceed the window.
test('the summarizer gets the whole ledger; the splice still keeps its tail', async () => {
  const seen = []; const snapped = [];
  const h = harness({ prepare: () => prep('e5') });
  h.deps.snapshotMessages = (_ctx, firstKeptEntryId) => { snapped.push(firstKeptEntryId); return ['m']; };
  h.deps.compact = (req) => { seen.push(req); return new Promise(() => {}); };
  h.svc.summarize(h.ctx, { label: 'threshold' });
  await tick(); await tick();
  // No cut: the prefix is then exactly the last live call's, so the cache has an entry to reach.
  assert.equal(snapped[0], undefined, 'summarizer reads the full ledger');
  assert.equal(seen[0].prep.firstKeptEntryId, 'e5', 'splice boundary untouched');
  // e5, e6 are summarized AND kept verbatim.
  assert.equal(seen[0].overlapEntries, 2);
});
