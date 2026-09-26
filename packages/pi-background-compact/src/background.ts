/**
 * Background compaction — a SERVICE, not a trigger.
 *
 * Summarizes the ledger off the critical path and hands pi the finished summary at the next
 * settled boundary, where the splice is ~0 s. Anyone may call `summarize()` (a threshold
 * extension, a /command, a skill before a long phase); the service owns the invariants:
 *
 *   one in flight · never blocks prompting · never splices a summary of a ledger that changed ·
 *   a stale summary is CANCELLED, never silently replaced by a foreground summarizer ·
 *   every summarizer request is accounted exactly once (applied via pi, or reported dropped).
 *
 *   idle ──summarize()──► summarizing ──resolve──► ready ──apply()──► applying ──pi lands it──► idle
 *     ▲                       │ reject/cancel          │ branch changed / other compaction        │
 *     └───────────────────────┴──────────────────────  dropped (usage reported once) ◄───────────┘
 *
 * pi facts this rests on (0.85.1): `session_before_compact` may return `{compaction}` (pi skips its
 * summarizer) or `{cancel:true}`; prompting is refused only while pi's own compact() holds its
 * abort controller, which the background request never touches.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Entry = { id?: string; type?: string };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } } | null;
export type CompactionResult = { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: Usage; details?: unknown };

export type Fingerprint = { sessionId: string; firstKeptEntryId: string; prefix: string[] };

/** What the summary covers: the branch as it was, up to and including the first kept entry's
 *  position. Growth after it is fine; anything that changes THIS prefix invalidates the summary. */
export function fingerprintOf(sessionId: string, entries: Entry[], firstKeptEntryId: string): Fingerprint {
  const keptAt = entries.findIndex(e => e.id === firstKeptEntryId);
  const end = keptAt >= 0 ? keptAt + 1 : entries.length;
  return { sessionId, firstKeptEntryId, prefix: entries.slice(0, end).map(e => String(e.id)) };
}

export function fingerprintHolds(fp: Fingerprint, sessionId: string, entries: Entry[]): boolean {
  if (sessionId !== fp.sessionId) return false;
  if (entries.length < fp.prefix.length) return false;
  for (let i = 0; i < fp.prefix.length; i++) if (String(entries[i]?.id) !== fp.prefix[i]) return false;
  // A compaction entry after the snapshot means the ledger was already rewritten by someone else.
  for (let i = fp.prefix.length; i < entries.length; i++) if (entries[i]?.type === "compaction") return false;
  return true;
}

const SLOT = Symbol.for("pi.agent.backgroundCompaction");

export type State = "idle" | "summarizing" | "ready" | "applying";
export type Status = { state: State; label?: string; startedAt?: number; tokensBefore?: number };

export type Deps = {
  prepare: (entries: Entry[], settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) => { firstKeptEntryId: string; tokensBefore: number } | undefined;
  compact: (req: CompactRequest) => Promise<CompactionResult>;
  /** Project the branch into summarizer messages AT SNAPSHOT TIME. Must be called before the auth
   *  await, never from inside the request: the fingerprint only authenticates the prefix captured
   *  here, so a live re-read could summarize a branch the fingerprint does not describe. */
  snapshotMessages?: (ctx: Ctx, firstKeptEntryId: string) => unknown[];
  settings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  emit: (channel: string, data: Record<string, unknown>) => void;
  now?: () => number;
  thinkingLevel?: () => unknown;
  retry?: () => unknown;
};

export type CompactRequest = {
  prep: any; model: any; apiKey?: string; headers?: any; env?: any;
  customInstructions?: string; signal: AbortSignal; thinkingLevel?: unknown; retry?: unknown;
  sessionId: string; maxTokens: number; ctx: Ctx;
  /** The branch as it was when `prep` and the fingerprint were taken. The summarizer reads THIS,
   *  not `ctx`, so a branch switch during auth cannot swap the conversation underneath it. */
  messages?: unknown[];
};

export type SummarizeOptions = { label: string; autoApply?: boolean; customInstructions?: string };

/** Minimal slice of ExtensionContext the service uses (kept narrow so tests can fake it). */
export type Ctx = Pick<ExtensionContext, "compact"> & {
  sessionManager: { getBranch(): Entry[]; getSessionId(): string };
  model?: any;
  modelRegistry: { getApiKeyAndHeaders(model: any): Promise<any> };
};

export function createBackgroundCompaction(deps: Deps) {
  const now = deps.now ?? Date.now;
  let state: State = "idle";
  let label = "";
  let startedAt = 0;
  let alive = true;
  let abort: AbortController | undefined;
  let stash: { result: CompactionResult; fp: Fingerprint; autoApply: boolean } | undefined;
  let overlapEntries = 0;   // entries summarized AND kept verbatim, for the audit line
  let splicing = false;   // our own ctx.compact() is in progress; the hook may answer
  let seq = 0;            // detects a late resolution from a superseded request
  let sessionId = "";     // of the request in flight, for accounting without a ctx
  let summarizerModel: string | null = null;   // same reason: `drop` has no ctx, and cost is unreadable without it
  let inflightTokens: number | undefined;

  const reset = () => { state = "idle"; stash = undefined; abort = undefined; splicing = false; };

  /** Exactly-once for work that never lands: report and forget. `usage: null` = unknown, never zero. */
  const drop = (why: string, usage: Usage | undefined, tokensBefore: number | undefined, sessionId: string) => {
    deps.emit("background-compaction:dropped", { label, why, usage: usage ?? null, tokensBefore: tokensBefore ?? null, model: summarizerModel, sessionId, at: now() });
    reset();
  };

  const summarize = async (ctx: Ctx, opts: SummarizeOptions): Promise<"started" | "busy" | "nothing" | "no-model" | "no-auth" | "dead"> => {
    if (!alive) return "dead";          // a shut-down service (stale globalThis slot after /reload) takes no work
    if (state !== "idle") return "busy";
    if (!ctx.model) return "no-model";
    const entries = ctx.sessionManager.getBranch();
    sessionId = ctx.sessionManager.getSessionId();
    const prep = deps.prepare(entries, deps.settings());
    if (!prep) return "nothing";
    // The summarizer reads the WHOLE ledger. Its prefix is then exactly the last live call's, so
    // the cache holds an entry one block behind the appended instruction — the only arrangement
    // measured to hit reliably. The splice still keeps pi's recent tail, so the entries below it
    // are summarized AND kept verbatim; that overlap is redundant, not wrong.
    const keptAt = entries.findIndex((e) => e.id === prep.firstKeptEntryId);
    overlapEntries = keptAt >= 0 ? entries.length - keptAt : 0;
    // ONE snapshot: entries, cut point, fingerprint and the summarizer's messages are all taken
    // here, before any yield. The fingerprint authenticates only what was captured at this point.
    const fp = fingerprintOf(sessionId, entries, prep.firstKeptEntryId);
    const messages = deps.snapshotMessages?.(ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth?.ok) return "no-auth";
    if (state !== "idle") return "busy";   // re-check: the await above is a yield point
    if (!alive) return "dead";             // shut down while auth was pending: take no work

    const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
    const mySeq = ++seq;
    abort = new AbortController();
    state = "summarizing"; label = opts.label; startedAt = now(); inflightTokens = prep.tokensBefore;
    summarizerModel = (model as { id?: string }).id ?? null;   // pi summarizes with the SESSION model
    deps.emit("background-compaction:started", { label, tokensBefore: prep.tokensBefore, sessionId, at: startedAt });

    deps.compact({
      prep, model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
      customInstructions: opts.customInstructions, signal: abort.signal,
      thinkingLevel: deps.thinkingLevel?.(), retry: deps.retry?.(), sessionId,
      maxTokens: Math.floor((deps.settings().reserveTokens ?? 16384) * 0.8), ctx, messages,
        overlapEntries,
    })
      .then(result => {
        if (mySeq !== seq || state !== "summarizing" || !alive) return;   // cancelled, superseded or shut down: already accounted
        stash = { result, fp, autoApply: opts.autoApply === true };
        state = "ready";
        deps.emit("background-compaction:ready", { label, tokensBefore: result.tokensBefore, usage: result.usage ?? null, sessionId, at: now(), elapsedMs: now() - startedAt, overlapEntries });
      })
      .catch(error => {
        if (mySeq !== seq || state !== "summarizing") return;
        reset();
        deps.emit("background-compaction:failed", { label, error: String((error as Error)?.message ?? error), sessionId, at: now() });
      });
    return "started";
  };

  /** Ask pi to compact; the hook below answers with the stash. Only valid when ready. */
  const apply = (ctx: Ctx): "applying" | "not-ready" | "stale" => {
    if (state !== "ready" || !stash) return "not-ready";
    const sessionId = ctx.sessionManager.getSessionId();
    if (!fingerprintHolds(stash.fp, sessionId, ctx.sessionManager.getBranch())) {
      drop("branch changed before apply", stash.result.usage, stash.result.tokensBefore, sessionId);
      return "stale";
    }
    state = "applying"; splicing = true;
    const { result } = stash;
    ctx.compact({
      onComplete: (landed: any) => {
        splicing = false;
        const after = landed?.estimatedTokensAfter;
        reset();
        // `after` is estimateMessagesTokens(post-splice messages) = summary + KEPT TAIL, not the summary.
        deps.emit("background-compaction:applied", { label, tokensBefore: result.tokensBefore, tokensAfter: after ?? null, model: summarizerModel, usage: result.usage ?? null, sessionId, at: now(), overlapEntries });
      },
      onError: (error: Error) => {
        splicing = false;
        // A cancel we issued ourselves was already reported as dropped by the hook.
        if (state === "applying") { reset(); deps.emit("background-compaction:failed", { label, error: error.message, sessionId, at: now() }); }
      },
    });
    return "applying";
  };

  /** session_before_compact: hand pi the stash for OUR splice; cancel if the ledger moved; stay
   *  silent for anyone else's compaction (a user /compact, pi's overflow guard). */
  const beforeCompact = (event: { reason?: string; branchEntries: Entry[] }, ctx: Ctx): { compaction: CompactionResult } | { cancel: true } | undefined => {
    if (!splicing || state !== "applying" || !stash) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const { result, fp } = stash;
    if (event.reason !== "manual" || !fingerprintHolds(fp, sessionId, event.branchEntries)) {
      splicing = false;
      drop("branch changed at splice", result.usage, result.tokensBefore, sessionId);
      return { cancel: true };
    }
    stash = undefined;                       // spent: a second hook call gets nothing
    return { compaction: result };
  };

  /** session_compact: a compaction landed. If it was not ours, whatever we held is now stale. */
  const afterCompact = (_event: { fromExtension?: boolean; reason?: string }, ctx: Ctx) => {
    if (state === "applying") return;        // ours; onComplete finishes the bookkeeping
    if (state === "ready" && stash) return drop("another compaction landed", stash.result.usage, stash.result.tokensBefore, ctx.sessionManager.getSessionId());
    if (state === "summarizing") { abort?.abort(); seq++; drop("another compaction landed mid-summary", null, inflightTokens, ctx.sessionManager.getSessionId()); }
  };

  /** agent_settled: the one boundary where applying cannot race a run. Never blocks. */
  const settle = (ctx: Ctx) => { if (state === "ready" && stash?.autoApply) apply(ctx); };

  const cancel = (sessionId = "") => {
    if (state === "summarizing") { abort?.abort(); seq++; drop("cancelled", null, inflightTokens, sessionId); return true; }
    if (state === "ready" && stash) { drop("cancelled", stash.result.usage, stash.result.tokensBefore, sessionId); return true; }
    return false;
  };

  /** The bus dies with the session, so anything in flight is accounted NOW: an aborted request's
   *  cost is unknown (null); a ready-but-unapplied summary's cost is exactly known. */
  const shutdown = () => {
    alive = false;
    if ((globalThis as any)[SLOT] === api) delete (globalThis as any)[SLOT];   // never leave a dead service for a trigger to find
    if (state === "summarizing") { abort?.abort(); seq++; drop("shutdown", null, inflightTokens, sessionId); }
    else if (state === "ready" && stash) drop("shutdown", stash.result.usage, stash.result.tokensBefore, sessionId);
    else if (state === "applying") { /* pi owns this one; its own compaction path reports it */ }
  };

  const status = (): Status => ({ state, label: state === "idle" ? undefined : label, startedAt: state === "idle" ? undefined : startedAt, tokensBefore: stash?.result.tokensBefore });

  const api = { summarize, apply, settle, cancel, shutdown, status, beforeCompact, afterCompact, alive: () => alive };
  return api;
}

export type BackgroundCompaction = ReturnType<typeof createBackgroundCompaction>;

/** Process-wide handle. Every pi extension is its own module graph, so a module-level singleton
 *  would be per-extension; `globalThis` + `Symbol.for` is the one shared place. */
export function publishBackgroundCompaction(svc: BackgroundCompaction): void { (globalThis as any)[SLOT] = svc; }
export function backgroundCompaction(): BackgroundCompaction | undefined { return (globalThis as any)[SLOT]; }
