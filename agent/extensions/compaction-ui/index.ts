/**
 * UI for compaction: ONE status row (a board section) under the editor while a background summary runs, and a
 * persisted DETAIL CARD under every `[compaction]` entry (background or blocking) — the cut, the
 * summarizer's request/cache/cost, timing, payback. Listens to `background-compaction:*` on pi.events
 * and to pi's `session_compact`; no imports from the package.
 *
 *   ┊ ⟳ compacting 193k in background — keep working (threshold 200k) · 35s
 *
 *   [compaction · detail]  191.0k → 33.2k · −83% · 54s · $0.46        (ctrl+o for every row)
 */
import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { boardOf } from "../../lib/agent-ui/sections.ts";
import { cutStyled } from "../../lib/agent-ui/width.ts";
import { describe, fromCompactEvent, headline, type Detail, type Pending } from "./detail.ts";

const k = (n: unknown) => (typeof n === "number" ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : "?");
const ENTRY = "compaction-detail";

export default function compactionStatusRow(pi: ExtensionAPI) {
  let ui: any;
  pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; });

  // ── the detail card ─────────────────────────────────────────────────────────────────────────
  pi.registerEntryRenderer<Detail>(ENTRY, (entry, { expanded }, theme) => {
    const d = entry.data;
    if (!d || typeof d.before !== "number") return undefined;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction · detail]")) + "  " + theme.fg("accent", headline(d)), 0, 0));
    if (expanded) {
      box.addChild(new Spacer(1));
      const rows = describe(d);
      const w = Math.max(...rows.map(r => r.key.length));
      for (const r of rows)
        box.addChild(new Text(theme.fg("dim", r.key.padEnd(w)) + "  " + (r.tone ? theme.fg(r.tone, r.value) : theme.fg("customMessageText", r.value)), 0, 0));
    }
    return box;
  });

  // Background timings: started/ready arrive before pi's session_compact for the same cut.
  let pending: Pending | undefined;
  pi.events.on("background-compaction:started", (d: any) => { pending = { tokensBefore: d.tokensBefore, label: d.label, startedAt: d.at ?? Date.now() }; });
  pi.events.on("background-compaction:ready", (d: any) => { if (pending && pending.tokensBefore === d.tokensBefore) pending.readyAt = d.at ?? Date.now(); });
  pi.events.on("background-compaction:dropped", () => { pending = undefined; });
  pi.events.on("background-compaction:failed", () => { pending = undefined; });

  pi.on("session_compact", async (event: any, ctx: any) => {
    // Same arithmetic as pi's estimatedTokensAfter: the post-splice message ledger, summary + kept tail.
    let after: number | null = null;
    try { after = (ctx.sessionManager.buildSessionContext?.().messages ?? []).reduce((t: number, m: any) => t + estimateTokens(m), 0) || null; } catch { after = null; }
    const detail = fromCompactEvent(event, pending, after, ctx.model?.id ?? null);
    pending = undefined;
    // Deferred: pi rebuilds the transcript on compaction_end and appends its own [compaction] card;
    // ours must land after that, or it renders above the card it explains.
    setTimeout(() => { try { pi.appendEntry(ENTRY, detail); } catch { /* headless or closed session */ } }, 50);
  });

  // ── the status row ──────────────────────────────────────────────────────────────────────────

  // One section on the shared board, never its own widget: pi's setWidget re-inserts a key at the END on every call, so a
  // row that re-set itself every 5 s hopped below the board and back as each side repainted (Yong 2026-09-24).
  const board = boardOf(pi);
  const ID = "compaction";
  let clearTimer: NodeJS.Timeout | undefined;
  const row = (text: string, tone: "muted" | "text" | "warning" | "error" = "muted", autoClearMs?: number) => {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = undefined; }
    board.section({ id: ID, render: (width, theme) => [cutStyled(`${theme.fg("dim", "┊ ")}${theme.fg(tone, text)}`, width)] });
    if (autoClearMs) clearTimer = setTimeout(() => board.remove(ID), autoClearMs);
  };

  // The in-progress row ticks: minutes of summarization behind a static line reads as a hang.
  let ticker: NodeJS.Timeout | undefined;
  const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = undefined; } };

  pi.events.on("background-compaction:started", (d: any) => {
    stopTicker();
    const t0 = Date.now();
    const base = `⟳ compacting ${k(d.tokensBefore)} in background — keep working (${d.label})`;
    row(base, "text");
    ticker = setInterval(() => row(`${base} · ${Math.round((Date.now() - t0) / 1000)}s`, "text"), 5_000);
  });
  pi.events.on("background-compaction:ready", (d: any) => {
    stopTicker();
    row(`✓ summary ready (${k(d.tokensBefore)}) — applying at the next pause`, "text");
  });
  pi.events.on("background-compaction:applied", (d: any) => {
    stopTicker();
    const cost = d.usage?.cost?.total;
    const ov = d.overlapEntries ? ` · ${d.overlapEntries} entries overlap` : "";
    row(`✓ async compaction done: ${k(d.tokensBefore)} → summary ${k(d.tokensAfter)}${ov}${cost ? ` · $${cost.toFixed(2)}` : ""}`, "text", 20_000);
  });
  pi.events.on("background-compaction:dropped", (d: any) => {
    stopTicker();
    const cost = d.usage?.cost?.total;
    row(`⚠ background summary discarded (${d.why})${cost ? ` · $${cost.toFixed(2)} spent` : ""}`, "warning", 20_000);
  });
  pi.events.on("background-compaction:failed", (d: any) => {
    stopTicker();
    row(`✕ async compaction failed: ${d.error}`, "error");
  });
  pi.on("session_shutdown", async () => { stopTicker(); if (clearTimer) clearTimeout(clearTimer); });
}
