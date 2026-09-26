/**
 * compaction — the background-compaction SERVICE for this pi process.
 *
 * Owns the pi seams so no trigger has to: `session_before_compact` (answer our own splice),
 * `session_compact` (someone else compacted → our stash is stale), `session_shutdown`,
 * `agent_settled` (the boundary where a ready summary is applied). Triggers just call
 * `backgroundCompaction().summarize(ctx, {label, autoApply})` — see src/trigger.ts for the
 * threshold trigger; `/compact-bg` here is the manual one.
 *
 * Events on pi.events (one bus per process, shared by every extension):
 *   background-compaction:{started,ready,applied,dropped,failed}
 * `dropped` carries the summarizer's usage so the ledger can bill work that never landed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact, convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { appendedCompact, sliceDoomed } from "./appended.ts";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDirNow, upgradeAgentDir, statePath } from "./paths.ts";
import { createBackgroundCompaction, publishBackgroundCompaction, type Deps } from "./background.ts";

/** pi runs from its bundle, whose virtual module does not export prepareCompaction; the unbundled
 *  dist file next to it does, and it is pure (entries in → messages/cut point out). */
async function loadPrepare(): Promise<{ prepare: Deps["prepare"]; complete?: (...a: any[]) => Promise<any> } | undefined> {
  const roots = [
    process.argv[1]?.includes("pi-coding-agent/") ? process.argv[1].split("pi-coding-agent/")[0] + "pi-coding-agent" : undefined,
    resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent"),
  ].filter((p): p is string => !!p);
  for (const root of roots) {
    const file = join(root, "dist/core/compaction/compaction.js");
    if (!existsSync(file)) continue;
    try {
      const prepare = (await import(file)).prepareCompaction;
      let complete: ((...a: any[]) => Promise<any>) | undefined;
      const compat = join(root, "node_modules/@earendil-works/pi-ai/dist/compat.js");
      if (existsSync(compat)) { try { complete = (await import(compat)).completeSimple; } catch { /* appended strategy just stays off */ } }
      return { prepare, complete };
    } catch { /* try the next root */ }
  }
  return undefined;
}

/** Split on ownership: `compaction.{reserveTokens,keepRecentTokens}` are PI CORE's own settings
 *  (same semantics, respected as-is); everything this package adds lives under `backgroundCompact`
 *  so nothing squats in — or is one capital letter away from — a core key. */
function settingsFile(): any {
  try { return JSON.parse(readFileSync(join(agentDirNow(), "settings.json"), "utf8")) ?? {}; }
  catch { return {}; }
}
function compactionSettings() {
  const c = settingsFile()?.compaction ?? {};
  return { enabled: c.enabled ?? true, reserveTokens: c.reserveTokens ?? 16384, keepRecentTokens: c.keepRecentTokens ?? 20000 };
}

const k = (n: unknown) => (typeof n === "number" ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : "?");

/** ~/.pi/agent/state/compaction.log — every service transition, always on. Notifications vanish; this doesn't. */
const logPath = () => statePath("compaction.log");
const log = (line: string) => { try { appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`); } catch { /* never block */ } };

export async function setupService(pi: ExtensionAPI) {
  await upgradeAgentDir();
  const internals = await loadPrepare();
  const prepare = internals?.prepare;
  if (!prepare) {
    // No service → triggers see `backgroundCompaction()` undefined and fall back to blocking.
    pi.on("session_start", async (_e, ctx) => ctx.ui?.notify?.("background compaction unavailable: pi's compaction module not found; compaction will block", "warning"));
    return;
  }

  // Strategy A (pi): serialize the conversation under a summarizer prompt — new prefix, full input
  // price. Strategy B (appended): the live prefix + one appended instruction — cacheRead price.
  // B needs pi-ai's completeSimple; without it, or on any B failure that is not our own abort, A runs.
  const piCompact: Deps["compact"] = (r) =>
    (compact as any)(r.prep, r.model, r.apiKey, r.headers, r.customInstructions, r.signal, r.thinkingLevel, undefined, r.env, r.retry, undefined, r.sessionId);
  const entriesToLlm = (actx: any, firstKeptEntryId?: string) => {
    const all = actx.sessionManager.buildContextEntries();
    const doomed = sliceDoomed(all, firstKeptEntryId);
    log(`summarizer input: ${doomed.length}/${all.length} entries (firstKept=${firstKeptEntryId ?? "none"}${doomed.length === all.length ? " NOT FOUND → full ledger" : ""})`);
    return convertToLlm(doomed.flatMap(sessionEntryToContextMessages));
  };
  const strategyName = () => settingsFile()?.backgroundCompact?.strategy ?? "appended";
  const summarizerCompact: Deps["compact"] = async (r) => {
    if (strategyName() !== "appended" || !internals?.complete) return piCompact(r);
    try {
      // getAllTools/getActiveTools live on the API object, getSystemPrompt on the event ctx
      const actx = { getSystemPrompt: () => (r.ctx as any).getSystemPrompt(), getAllTools: () => (pi as any).getAllTools(), getActiveTools: () => (pi as any).getActiveTools(), sessionManager: (r.ctx as any).sessionManager };
      const res = await appendedCompact({ complete: internals.complete as any, entriesToLlm }, { ...r, ctx: actx, thinkingLevel: (r.ctx as any).thinkingLevel } as any);
      const u: any = res.usage;
      const sent = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
        const cachedPct = sent ? (u?.cacheRead ?? 0) / sent : 0;
        log(`summarizer strategy=appended cached=${u?.cacheRead} uncached=${(u?.cacheWrite ?? 0) + (u?.input ?? 0)} sent=${sent} out=${u?.output} cost=${u?.cost?.total?.toFixed?.(4)}`);
        if (cachedPct < 0.5) log(`summarizer LOOKUP MISS suspected: cached only ${(cachedPct * 100).toFixed(1)}% of ${sent} — the entry below the cut was out of reach`);
      return res;
    } catch (e) {
      if (r.signal?.aborted) throw e;   // an abort is the caller's decision, not a strategy failure
      log(`summarizer strategy=appended FAILED (${(e as Error).message}) → falling back to pi's serializing summarizer`);
      return piCompact(r);
    }
  };

  const svc = createBackgroundCompaction({
    prepare,
    compact: (req: any) => {
      log(`summarizer overlap: ${req.overlapEntries ?? 0} entries summarized AND kept verbatim (splice keeps from ${req.prep?.firstKeptEntryId})`);
      return summarizerCompact(req);
    },
    settings: compactionSettings,
    snapshotMessages: (ctx, firstKeptEntryId) => entriesToLlm(ctx as any, firstKeptEntryId),
    emit: (channel, data) => pi.events.emit(channel, data),
  });
  publishBackgroundCompaction(svc);

  // The seams. Hook results are returned to pi; everything else is bookkeeping.
  pi.on("session_before_compact", async (event: any, ctx) => svc.beforeCompact(event, ctx as any));
  pi.on("session_compact", async (event: any, ctx) => { svc.afterCompact(event, ctx as any); });
  pi.on("session_shutdown", async () => { svc.shutdown(); });
  // A ready summary applies at the next boundary. `agent_settled` is one; "pi is idle when the
  // summary arrives" is the other — otherwise the next call would carry the whole ledger once more.
  let lastCtx: any;
  pi.on("session_start", async (_e, ctx) => { lastCtx = ctx; });
  pi.on("agent_settled", async (_e, ctx) => { lastCtx = ctx; svc.settle(ctx as any); });
  pi.events.on("background-compaction:ready", () => {
    setImmediate(() => {
      log(`ready→apply? hasCtx=${!!lastCtx} isIdle=${lastCtx?.isIdle?.()} state=${svc.status().state}`);
      if (lastCtx?.isIdle?.() === true) svc.settle(lastCtx);
    });
  });

  // Feedback: transition log (always) + pi's standard notifications for the three outcomes a
  // user must not miss. No custom widgets — UI is taste; render your own from the events on
  // pi.events (see examples/status-row.ts) and set "backgroundCompact": { "notify": false } to mute these.
  const notifyOn = () => settingsFile()?.backgroundCompact?.notify !== false;
  let ui: any;
  pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; log(`session_start reason=${(_e as any).reason} service=ready`); });
  pi.events.on("background-compaction:started", (d: any) => log(`started ${d.label} tokens=${d.tokensBefore}`));
  pi.events.on("background-compaction:ready", (d: any) => log(`ready tokens=${d.tokensBefore} cost=${d.usage?.cost?.total ?? "?"} elapsed=${d.elapsedMs}ms`));
  pi.events.on("background-compaction:applied", (d: any) => {
    const cost = d.usage?.cost?.total;
    // after = summary + kept tail, NOT the summary: label it for what it is or the next reader
    // mistakes a keepRecentTokens change for the summarizer doubling its output.
    // One line must answer all three questions on its own — WHO fired it (label), what it cost, and
      // whether the cache was actually warm — because the sqlite row is not guaranteed to exist.
      log(`applied ${d.label} before=${d.tokensBefore} after=${d.tokensAfter} summary=${d.usage?.output ?? "?"} cached=${d.usage?.cacheRead ?? "?"} uncached=${(d.usage?.cacheWrite ?? 0) + (d.usage?.input ?? 0)} model=${d.model ?? "?"} cost=${cost ?? "?"}`);
    if (notifyOn()) ui?.notify?.(`compacted in background: ${k(d.tokensBefore)} → ${k(d.tokensAfter)}${cost ? ` · $${cost.toFixed(2)}` : ""} (${d.label})`, "info");
  });
  pi.events.on("background-compaction:dropped", (d: any) => {
    const cost = d.usage?.cost?.total;
    log(`dropped why="${d.why}" tokens=${d.tokensBefore} cost=${cost ?? "unknown"}`);
    if (notifyOn()) ui?.notify?.(`background summary discarded (${d.why})${cost ? ` · $${cost.toFixed(2)} spent` : ""}`, "warning");
  });
  pi.events.on("background-compaction:failed", (d: any) => {
    log(`FAILED ${d.label}: ${d.error}`);
    if (notifyOn()) ui?.notify?.(`background compaction failed: ${d.error}`, "error");
  });
  pi.on("session_shutdown", async () => log("session_shutdown"));

  pi.registerCommand("compact-bg", {
    description: "compact in the background: /compact-bg [status|cancel] — summarizes now, applies at the next pause, never blocks",
    handler: async (args: string, ctx) => {
      const a = args.trim().toLowerCase();
      const s = svc.status();
      if (a === "status") return ctx.ui.notify(`background compaction: ${s.state}${s.label ? ` (${s.label})` : ""}${s.tokensBefore ? ` · ${k(s.tokensBefore)}` : ""}`, "info");
      if (a === "cancel") return ctx.ui.notify(svc.cancel(ctx.sessionManager.getSessionId()) ? "background compaction cancelled" : "nothing in flight", "info");
      const r = await svc.summarize(ctx as any, { label: "manual", autoApply: true });
      const msg: Record<string, string> = {
        started: `summarizing ${k(ctx.getContextUsage?.()?.tokens)} in the background — keep working; it applies at the next pause`,
        busy: `already ${s.state}${s.label ? ` (${s.label})` : ""}`,
        nothing: "nothing to compact (session too small or already compacted)",
        "no-model": "no model selected",
        "no-auth": "no API key for the current model",
      };
      ctx.ui.notify(msg[r] ?? r, r === "started" ? "info" : "warning");
    },
  });
}
