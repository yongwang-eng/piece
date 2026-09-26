/**
 * Example UI for pi-background-compact: ONE status row under the editor (with a 5s elapsed ticker
 * while summarizing). Listens only to `background-compaction:*` on pi.events — no imports from
 * the package — so copy it into your extensions folder and restyle freely. Pair it with
 * `"backgroundCompact": { "notify": false }` in settings.json to mute the package's own notifications.
 *
 *   ┊ ⟳ compacting 193k in background — keep working (threshold 200k) · 35s
 *   ┊ ✓ async compaction done: 193k → context 13k · $0.46        (clears after 20s)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const k = (n: unknown) => (typeof n === "number" ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : "?");

export default function compactionStatusRow(pi: ExtensionAPI) {
  let ui: any;
  pi.on("session_start", async (_e, ctx) => { ui = ctx.ui; });

  const WIDGET = "compaction-status-row";
  let clearTimer: NodeJS.Timeout | undefined;
  const row = (text: string, tone: "muted" | "text" | "warning" | "error" = "muted", autoClearMs?: number) => {
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = undefined; }
    ui?.setWidget?.(WIDGET, (_tui: any, theme: any) => ({
      render: () => [`${theme.fg("dim", "┊ ")}${theme.fg(tone, text)}`],
      invalidate() {},
    }), { placement: "belowEditor" });
    if (autoClearMs) clearTimer = setTimeout(() => ui?.setWidget?.(WIDGET, undefined), autoClearMs);
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
    row(`✓ async compaction done: ${k(d.tokensBefore)} → context ${k(d.tokensAfter)}${cost ? ` · $${cost.toFixed(2)}` : ""}`, "text", 20_000);
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
