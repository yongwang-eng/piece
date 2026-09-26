import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { UsageFrame, CompactionFrame } from '../database/usage.ts';

type Event = { type: string; timestamp?: number; message?: unknown; toolResults?: unknown[] };
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const label = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const reason = (v: unknown): string => ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(v)) ? String(v) : 'unknown';

export function usageCapture(emit: (frame: UsageFrame) => void, now = Date.now) {
  let active: { turnKey: string; sessionId: string; startedAt: number | null } | undefined;
  let messageStart: number | undefined;
  return (event: Event, sessionId: string, thinkingLevel?: string | null): void => {
    if (event.type === 'turn_start') {
      active = { turnKey: randomUUID(), sessionId, startedAt: number(event.timestamp) };
      emit({ ...active, phase: 'start', at: now() });
      return;
    }
    if (event.type === 'message_start') {
      if ((event.message as Record<string, any> | undefined)?.role === 'assistant') messageStart = now();
      return;
    }
    const m = event.message as Record<string, any> | undefined;
    if (m?.role !== 'assistant' || !['message_end', 'turn_end'].includes(event.type)) return;
    if (!active || active.sessionId !== sessionId) active = { turnKey: randomUUID(), sessionId, startedAt: null };
    const common = { ...active, at: now(), stopReason: reason(m.stopReason) };
    if (event.type === 'message_end') {
      const u = m.usage;
      // Failed SDK responses can carry placeholder zero usage without any provider accounting.
      const unknown = !u || (['error', 'aborted'].includes(common.stopReason) && !(u.totalTokens > 0));
      const n = (v: unknown) => unknown ? null : number(v);
      const input = n(u?.input), cacheRead = n(u?.cacheRead), cacheWrite = n(u?.cacheWrite);
      const context = input === null && cacheRead === null && cacheWrite === null
        ? null : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
      emit({ ...common, phase: 'call', provider: label(m.provider), model: label(m.model),
        input, output: n(u?.output), reasoning: n(u?.reasoning),
        cacheRead, cacheWrite, totalTokens: n(u?.totalTokens), contextTokens: context,
        durationMs: messageStart === undefined ? null : Math.max(0, now() - messageStart),
        thinkingLevel: thinkingLevel ?? null,
        estimatedCost: n(u?.cost?.total), costInput: n(u?.cost?.input), costOutput: n(u?.cost?.output),
        costCacheRead: n(u?.cost?.cacheRead), costCacheWrite: n(u?.cost?.cacheWrite) });
      messageStart = undefined;
    } else {
      emit({ ...common, phase: 'end', toolCount: event.toolResults?.length ?? 0 });
      active = undefined;
    }
  };
}

export function installUsageCapture(pi: ExtensionAPI, emit: (frame: UsageFrame) => void, failed: (error: unknown) => void): void {
  const capture = usageCapture(emit);
  const onEvent = (event: Event, ctx: ExtensionContext) => {
    try { capture(event, ctx.sessionManager.getSessionId(), (ctx as { thinkingLevel?: string }).thinkingLevel ?? null); }
    catch (error) { failed(error); }
  };
  pi.on('turn_start', onEvent);
  pi.on('message_start', onEvent);
  pi.on('message_end', onEvent);
  pi.on('turn_end', onEvent);
}

/** Record ANY in-process AgentSession (governor today, any future embedded session) through the same
 *  mapper main and workers use. `subscribe` is the session's full event stream; nothing bespoke per role. */
export function attachSessionUsage(
  subscribe: (fn: (ev: unknown) => void) => () => void,
  sessionId: string,
  emit: (frame: UsageFrame) => void,
  failed: (error: unknown) => void,
): () => void {
  const capture = usageCapture(emit);
  return subscribe(ev => {
    try { capture(ev as Event, sessionId); } catch (error) { failed(error); }
  });
}

export function installCompactionCapture(pi: ExtensionAPI, emit: (frame: CompactionFrame) => void, failed: (error: unknown) => void): void {
  pi.on('session_compact', (event, ctx: ExtensionContext) => {
    try {
      const e = event as { compactionEntry?: { tokensBefore?: number; usage?: { output?: number; cost?: { total?: number } } }; reason?: string; fromExtension?: boolean };
      emit({ sessionId: ctx.sessionManager.getSessionId(), at: Date.now(),
        reason: label(e.reason) ?? 'unknown', fromExtension: e.fromExtension === true,
        tokensBefore: number(e.compactionEntry?.tokensBefore), summaryTokens: number(e.compactionEntry?.usage?.output),
        tokensAfter: null, model: label((ctx as { model?: { id?: string } }).model?.id),
        cost: number(e.compactionEntry?.usage?.cost?.total) });
    } catch (error) { failed(error); }
  });
}

export type CompactionEnrichment = { sessionId: string; at: number; reason: string; tokensAfter: number | null; model: string | null };

/** pi stamps every extension splice reason='manual', so the service's `applied` event supplies the
 *  trigger label, the post-splice ledger size and the summarizer's model. It may fire before or after
 *  the insert depending on hook order — so enrich, and retry once if the row is not there yet.
 *  Enrichment never touches billing, and never touches `summary_tokens`: session_compact already stored
 *  the summarizer's real output. `tokensAfter` is the whole post-splice MESSAGE LEDGER (summary + kept
 *  tail, `agent-session.js` estimateMessagesTokens), so it moves with `keepRecentTokens` — recording it
 *  AS the summary size made a 10k→20k tail change look like the summarizer doubling its output. */
export function installAppliedCompactionCapture(pi: Partial<Pick<ExtensionAPI, 'events'>>, enrich: (e: CompactionEnrichment) => boolean, failed: (error: unknown) => void, retryMs = 1500): void {
  if (typeof pi.events?.on !== 'function') return;
  pi.events.on('background-compaction:applied', (data: unknown) => {
    try {
      const d = data as { sessionId?: string; at?: number; label?: string; tokensAfter?: number | null; model?: string | null };
      if (!d?.sessionId) return;
      const e: CompactionEnrichment = { sessionId: d.sessionId, at: typeof d.at === 'number' ? d.at : Date.now(),
        reason: label(d.label ?? 'background') ?? 'background', tokensAfter: number(d.tokensAfter), model: label(d.model) };
      if (enrich(e)) return;
      setTimeout(() => { try { enrich(e); } catch (error) { failed(error); } }, retryMs);
    } catch (error) { failed(error); }
  });
}

/** A background summarizer result that never landed still cost money. The service reports it once on
 *  pi.events; this turns it into a compaction frame with applied=false. usage=null → cost null = unknown. */
export function installDroppedCompactionCapture(pi: Partial<Pick<ExtensionAPI, 'events'>>, emit: (frame: CompactionFrame) => void, failed: (error: unknown) => void): void {
  if (typeof pi.events?.on !== 'function') return;   // no bus (older pi, test harness): nothing to hear, nothing to break
  // A failed request also consumed input tokens; the provider returned no usage, so the cost is unknown (null).
  pi.events.on('background-compaction:failed', (data: unknown) => {
    try {
      const d = data as { sessionId?: string; at?: number; error?: string };
      if (!d?.sessionId) return;
      emit({ sessionId: d.sessionId, at: typeof d.at === 'number' ? d.at : Date.now(), reason: label(`failed: ${d.error ?? 'unknown'}`.slice(0, 120)) ?? 'failed',
        fromExtension: true, applied: false, tokensBefore: null, summaryTokens: null, tokensAfter: null, model: label((d as { model?: string }).model), cost: null });
    } catch (error) { failed(error); }
  });
  pi.events.on('background-compaction:dropped', (data: unknown) => {
    try {
      const d = data as { sessionId?: string; at?: number; label?: string; why?: string; tokensBefore?: number | null;
        model?: string | null; usage?: { output?: number; cost?: { total?: number } } | null };
      if (!d?.sessionId) return;
      emit({ sessionId: d.sessionId, at: typeof d.at === 'number' ? d.at : Date.now(),
        reason: label(`dropped: ${d.why ?? 'unknown'}`.slice(0, 120)) ?? 'dropped', fromExtension: true, applied: false,
        tokensBefore: number(d.tokensBefore), summaryTokens: number(d.usage?.output), tokensAfter: null, model: label(d.model),
        cost: number(d.usage?.cost?.total) });
    } catch (error) { failed(error); }
  });
}
