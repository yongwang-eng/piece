/**
 * trigger — the THRESHOLD TRIGGER: compact at an ABSOLUTE token count, not at the window's edge.
 *
 * pi's built-in trigger is `contextTokens > contextWindow - reserveTokens`, so on a 1M model it
 * fires at ~984k — an overflow guard, not an economic policy. Cost per call ≈ context × read-rate,
 * so the ledger you carry is the bill you pay (measured figures in the README).
 *
 * Threshold = min(settings.backgroundCompact.at, window × maxFraction). With the background service
 * (extensions/background-compact.ts) loaded, the summarizer starts `lead` tokens EARLY and the summary is
 * applied at the next settled boundary — the conversation is never blocked. Without it, this
 * falls back to pi's blocking ctx.compact() at the threshold.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDirNow, upgradeAgentDir, statePath } from "./paths.ts";
import { backgroundCompaction } from "./background.ts";
import { appendFileSync } from "node:fs";

const logPath = () => statePath("compaction.log");
const log = (line: string) => { try { appendFileSync(logPath(), `${new Date().toISOString()} [trigger] ${line}\n`); } catch { /* never block */ } };

const DEFAULTS = {
  at: 200_000 as number | string, maxFraction: 0.75, lead: 10_000, minGapMs: 60_000, enabled: true, background: true,
  idleCompact: true, idleAt: 150_000, idleAfterMs: 270_000, cacheTtlMs: 300_000, idlePollMs: 15_000,
};

/** `at` is an ECONOMIC policy first: cost per call ≈ context × read-rate, denominated in tokens —
 *  so the default is absolute. `"20%"` opts into window-relative for cross-model hoppers.
 *  maxFraction caps BOTH forms; junk falls back to the default. Exported pure for tests. */
/** Should a quiet session compact itself while its cache is still warm? The wake-up write is
 *  proportional to the ledger, so shrinking it first turns a ~$2.40 cold start into ~$1.07 plus a
 *  ~$0.29 warm summarize. The window is bounded at BOTH ends and both bounds are measured: below
 *  `after` this is a tab-switch, not a departure; past `ttl` the cache is already gone and
 *  summarizing would pay the cold price to avoid the cold price. Exported pure for tests. */
export function idleCompactDue(o: { idleMs: number; tokens: number; state: string; after: number; ttl: number; minTokens: number }): boolean {
  return o.state === "idle" && o.tokens > o.minTokens && o.idleMs >= o.after && o.idleMs < o.ttl;
}

/** The warm window runs from the last cache READ — the request start — not from when the answer
 *  finished streaming; measured from settle, a long final response pushes the fire past the TTL. */
export function idleClock(now: () => number = Date.now) {
  let lastRequestAt: number | undefined;
  return {
    request: () => { lastRequestAt = now(); },
    idleMs: () => (lastRequestAt === undefined ? undefined : now() - lastRequestAt),
  };
}

export function resolveLimit(cfg: { at: number | string; maxFraction: number }, window: number, override?: number): number {
  const cap = Math.floor(window * cfg.maxFraction);
  if (override !== undefined) return Math.min(override, cap);
  let at: number | undefined;
  if (typeof cfg.at === "number" && Number.isFinite(cfg.at) && cfg.at > 0) at = cfg.at;
  else if (typeof cfg.at === "string") {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(cfg.at.trim());
    if (m) at = Math.floor(window * (Number(m[1]) / 100));
  }
  return Math.min(at ?? (DEFAULTS.at as number), cap);
}

// ctx.settings does not exist; read the tracked settings file like other extensions do.
// `backgroundCompact` is OUR namespace — pi core owns `autoCompact` (its overflow guard) and
// `compaction.*`; a lowercase-only sibling of a core key is a support ticket waiting to happen.
function fileSettings(): Partial<typeof DEFAULTS> {
  try { return JSON.parse(readFileSync(join(agentDirNow(), "settings.json"), "utf8"))?.backgroundCompact ?? {}; }
  catch { return {}; }
}

export function setupTrigger(pi: ExtensionAPI) {
  void upgradeAgentDir();
  let lastCompactAt = 0;
  let busy = false;
  let override: number | undefined;   // /background-compact 40k — this session only, never written to disk

  const threshold = (ctx: any) => {
    const cfg = { ...DEFAULTS, ...fileSettings() };
    const window = ctx.model?.contextWindow ?? 200_000;
    return { cfg, limit: resolveLimit(cfg, window, override) };
  };

  const blockingCompact = (ctx: any, why: string, before: number) => {
    busy = true;
    lastCompactAt = Date.now();
    ctx.ui?.setStatus?.("background-compact", `compacting at ${(before / 1000).toFixed(0)}k…`);
    ctx.compact({
      onComplete: () => {
        busy = false;
        const after = ctx.getContextUsage?.()?.tokens ?? 0;
        ctx.ui?.setStatus?.("background-compact", "");
        ctx.ui?.notify?.(`background-compact: ${(before / 1000).toFixed(0)}k → ${(after / 1000).toFixed(0)}k (${why})`, "info");
      },
      onError: (error: Error) => {
        busy = false;
        ctx.ui?.setStatus?.("background-compact", "");
        ctx.ui?.notify?.(`background-compact failed: ${error.message}`, "error");
      },
    });
  };

  const check = async (ctx: any, why: string, force = false) => {
    if (busy) return;
    const { cfg, limit } = threshold(ctx);
    if (!cfg.enabled && !force) return;
    const usage = ctx.getContextUsage?.();
    if (!usage) return;
    const tokens = usage.tokens as number;

    const svc = cfg.background ? backgroundCompaction() : undefined;
    if (svc) {
      // The service applies at the next settled boundary on its own (autoApply). Our job is
      // only to START it early enough that the summary is ready by the time we cross `limit`.
      const st = svc.status().state;
      if (st !== "idle") { log(`${why}: tokens=${tokens} service=${st} → wait`); return; }
      if (!force && tokens <= limit - cfg.lead) return;
      if (Date.now() - lastCompactAt < cfg.minGapMs) { log(`${why}: tokens=${tokens} → min-gap`); return; }
      lastCompactAt = Date.now();
      const r = await svc.summarize(ctx, { label: force ? "manual" : `threshold ${(limit / 1000).toFixed(0)}k`, autoApply: true });
      log(`${why}: tokens=${tokens} limit=${limit} lead=${cfg.lead} → summarize=${r}`);
      if (force && r !== "started") ctx.ui?.notify?.(`background-compact: ${r === "nothing" ? "nothing to compact yet (new messages fit in the kept tail)" : r === "busy" ? `already ${svc.status().state}` : `background compaction ${r}`}`, "info");
      else if (r !== "started" && r !== "busy" && r !== "nothing") ctx.ui?.notify?.(`background-compact: ${r}; will retry`, "warning");
      return;
    }

    if (!force && tokens <= limit) return;
    // Don't compact twice in a row on the same growth: one compaction must actually land first.
    if (Date.now() - lastCompactAt < cfg.minGapMs) return;
    log(`${why}: tokens=${tokens} limit=${limit} → BLOCKING compact (no service${cfg.background ? " in slot" : ", background:false"})`);
    blockingCompact(ctx, why, tokens);
  };

  // agent_settled = pi will not auto-continue (no retry, no queued follow-up): the one boundary
  // where an async compaction cannot race a run that was about to start.
  pi.on("agent_settled", async (_event, ctx) => { lastCtx = ctx; await check(ctx, "settled"); });

  // A quiet session is a liability: whatever it is holding, it pays a cache write for it on wake.
  // Polled, not hooked, because "nothing has happened for a while" is the one thing that fires no
  // event. One attempt per quiet period whatever the outcome, so a `nothing` cannot spin.
  let lastCtx: any;
  const clock = idleClock();
  pi.on("turn_start", () => clock.request());
  const idleCheck = async () => {
    const ctx = lastCtx;
    if (!ctx || busy || ctx.isIdle?.() === false) return;
    const idleMs = clock.idleMs();
    if (idleMs === undefined) return;
    const cfg = { ...DEFAULTS, ...fileSettings() };
    if (!cfg.enabled || !cfg.idleCompact) return;
    const svc = cfg.background ? backgroundCompaction() : undefined;
    if (!svc) return;
    const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
    if (!idleCompactDue({ idleMs, tokens, state: svc.status().state, after: cfg.idleAfterMs, ttl: cfg.cacheTtlMs, minTokens: cfg.idleAt })) return;
    clock.request();   // the summarizer request is itself a read
    // The label becomes compactions.reason, so the idle seconds at fire time are queryable later:
    // the window's lower bound is a tuning choice and this is the only record of what it bought.
    const r = await svc.summarize(ctx, { label: `idle ${Math.round(idleMs / 1000)}s`, autoApply: true });
    log(`idle: tokens=${tokens} idle=${(idleMs / 1000).toFixed(0)}s → summarize=${r}`);
  };
  const idleTimer = setInterval(() => void idleCheck().catch(() => { /* a poll never breaks the session */ }), DEFAULTS.idlePollMs);
  idleTimer.unref?.();
  pi.on("session_shutdown", () => clearInterval(idleTimer));

  pi.registerCommand("background-compact", {
    description: "show/set the background-compaction threshold for this session (e.g. /background-compact 120k · 25% · now · reset)",
    handler: async (args: string, ctx: any) => {
      const a = args.trim().toLowerCase();
      if (a === "reset") { override = undefined; }
      const m = /^(\d+)k$/.exec(a);
      if (m) override = Number(m[1]) * 1000;
      const pct = /^(\d+(?:\.\d+)?)%$/.exec(a);
      if (pct) override = Math.floor((ctx.model?.contextWindow ?? 200_000) * (Number(pct[1]) / 100));
      const { cfg, limit } = threshold(ctx);
      const usage = ctx.getContextUsage?.();
      const now = usage ? `${(usage.tokens / 1000).toFixed(0)}k` : "?";
      if (a === "now") return check(ctx, "manual", true);
      const mode = cfg.background && backgroundCompaction() ? `background (starts ${(cfg.lead / 1000).toFixed(0)}k early)` : "blocking";
      ctx.ui.notify(
        `background-compact ${cfg.enabled ? "on" : "off"} · threshold ${(limit / 1000).toFixed(0)}k${override ? " (session override)" : ""} · context now ${now}` +
          ` · window ${((ctx.model?.contextWindow ?? 0) / 1000).toFixed(0)}k · ${mode}` +
          (m || pct || a === "reset" ? "" : ` · persist via settings.json → "backgroundCompact": { "at": 200000 } (or "20%")`),
        "info",
      );
    },
  });
}
