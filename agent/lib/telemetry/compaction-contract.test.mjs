/**
 * The seam between two packages that each have their own green suite.
 *
 * pi-background-compact EMITS `background-compaction:applied`; the agent's capture layer READS it
 * and writes a row. Both sides are unit-tested against their own fixtures, so a renamed or misspelled
 * field (`model` vs `modelId`) keeps every one of those tests green and silently writes NULL forever.
 * Nothing but a test that runs the real emitter into the real consumer can catch that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackgroundCompaction } from '../../../packages/pi-background-compact/src/background.ts';
import { installAppliedCompactionCapture } from './capture.ts';
import { openCrewStore } from '../database/store.ts';

const branch = (...ids) => ids.map(id => ({ id, type: 'message' }));

test('the applied event carries what the row needs: real emitter → real capture → real SQLite', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'compaction-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = openCrewStore(join(root, 'agent.sqlite'));
  t.after(() => store.close());

  // ── the real service, with only the LLM call and the clock faked ──────────────────────────
  const events = {};
  let resolveCompact;
  const svc = createBackgroundCompaction({
    prepare: () => ({ firstKeptEntryId: 'e5', tokensBefore: 210_778, messagesToSummarize: [{}], turnPrefixMessages: [], isSplitTurn: false }),
    compact: () => new Promise(res => { resolveCompact = res; }),
    auth: async () => ({ ok: true, apiKey: 'k' }),
    settings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20_000 }),
    emit: (channel, data) => { (events[channel] ??= []).push(data); },
    now: () => 1_700_000_000_000,
  });
  const ctx = {
    branch: branch('e1', 'e2', 'e3', 'e4', 'e5', 'e6'),
    sessionManager: { getBranch: () => ctx.branch, getSessionId: () => 'sess-contract' },
    model: { id: 'claude-opus-5', provider: 'anthropic' },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'k' }) },
    // pi splices the summary and reports the post-splice message ledger back through the callback.
    compact(opts) { opts?.onComplete?.({ estimatedTokensAfter: 22_087 }); },
    getContextUsage: () => ({ tokens: 210_778 }),
  };

  await svc.summarize(ctx, { label: 'threshold 200k', autoApply: true });
  // 3,578 is the summarizer's real output; 22,087 is that summary plus the ~18.5k kept tail.
  resolveCompact({ summary: 'S', firstKeptEntryId: 'e5', tokensBefore: 210_778,
    usage: { input: 2, output: 3_578, cacheRead: 171_159, cacheWrite: 0, cost: { total: 0.1797 } } });
  await new Promise(r => setImmediate(r));
  svc.apply(ctx);
  const applied = events['background-compaction:applied']?.at(-1);
  assert.ok(applied, 'the service applied the summary');

  // ── the row pi's own session_compact hook writes first (summary size from the summarizer) ──
  const h = owner(store);
  store.recordCompaction(h, { sessionId: 'sess-contract', at: applied.at,
    reason: 'manual', fromExtension: true, tokensBefore: 210_778, summaryTokens: 3_578, cost: 0.1797 });

  // ── the real capture handler, fed the real event, writing through the real store ───────────
  const handlers = {};
  installAppliedCompactionCapture({ events: { on: (ch, h) => { handlers[ch] = h; } } },
    e => store.enrichCompaction(h, e), e => { throw e; }, 5);
  handlers['background-compaction:applied'](applied);

  const db = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const row = db.prepare("SELECT reason, summary_tokens, tokens_after, model FROM compactions WHERE session_id='sess-contract'").get();
  assert.equal(row.reason, 'threshold 200k', 'the trigger label replaced pi\'s "manual"');
  assert.equal(row.summary_tokens, 3_578, 'the summarizer output survived enrichment');
  assert.equal(row.tokens_after, 22_087, 'the post-splice ledger landed in its own column');
  assert.equal(row.model, 'claude-opus-5', 'the summarizing model was attributed');
});

function owner(s) {
  return s.claimMain(s.ensureMain('sess-contract').id, 'instance-a');
}
