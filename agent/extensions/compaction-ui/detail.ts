/** Pure half of the compaction-detail card: facts in, rows out. No pi imports, so it is testable. */

export type Usage = {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
} | null | undefined;

export type Detail = {
  at: number;
  mode: "background" | "blocking";
  /** trigger label: "threshold 200k" · "manual" · pi's own "threshold" | "overflow" */
  label: string;
  model: string | null;
  before: number;
  /** post-splice ledger = summary + kept tail (pi's estimatedTokensAfter) */
  after: number | null;
  summaryChars: number;
  usage: Usage;
  /** background only: wall time of the summarizer request, then how long the summary waited for a pause */
  summarizeMs: number | null;
  waitMs: number | null;
};

export type Row = { key: string; value: string; tone?: "accent" | "success" | "warning" | "dim" };

export type Pending = { tokensBefore: number; label: string; startedAt: number; readyAt?: number };

/** Fold pi's `session_compact` event and the background service's started/ready facts into one record.
 *  Background facts are borrowed only when the extension made this cut AND it is the same cut (tokensBefore). */
export function fromCompactEvent(
  event: { fromExtension?: boolean; reason?: string; compactionEntry?: { tokensBefore?: number; summary?: string; usage?: Usage } },
  pending: Pending | undefined,
  after: number | null,
  model: string | null,
  now = Date.now(),
): Detail {
  const e = event.compactionEntry ?? {};
  const bg = event.fromExtension && pending && pending.tokensBefore === e.tokensBefore ? pending : undefined;
  return {
    at: now,
    mode: bg ? "background" : "blocking",
    label: bg?.label ?? String(event.reason ?? "manual"),
    model,
    before: Number(e.tokensBefore ?? 0),
    after,
    summaryChars: String(e.summary ?? "").length,
    usage: e.usage ?? null,
    summarizeMs: bg ? (bg.readyAt ?? now) - bg.startedAt : null,
    waitMs: bg?.readyAt ? now - bg.readyAt : null,
  };
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);

/** One line for the collapsed card: the cut, the ratio, the time, the price, when it finished. */
export function headline(d: Detail): string {
  const parts = [`${k(d.before)} → ${d.after != null ? k(d.after) : "?"}`];
  if (d.after != null && d.before > 0) parts.push(`−${Math.round((1 - d.after / d.before) * 100)}%`);
  const total = (d.summarizeMs ?? 0) + (d.waitMs ?? 0);
  if (total > 0) parts.push(secs(total));
  if (d.usage?.cost?.total) parts.push(money(d.usage.cost.total));
  parts.push(clock(d.at));
  return parts.join(" · ");
}

/** The full card. Every row is a fact the compaction itself produced — nothing estimated is shown as exact. */
export function describe(d: Detail): Row[] {
  const rows: Row[] = [];
  const u = d.usage ?? undefined;
  const summary = u?.output ?? null;
  const kept = d.after != null && summary != null ? Math.max(0, d.after - summary) : null;

  rows.push({ key: "trigger", value: `${d.label} · ${d.mode}${d.model ? ` · summarizer ${d.model}` : ""}`, tone: "dim" });

  let ledger = `${k(d.before)} → ${d.after != null ? k(d.after) : "?"} tokens`;
  if (d.after != null && d.before > 0) ledger += `  (−${Math.round((1 - d.after / d.before) * 100)}%, ${k(d.before - d.after)} reclaimed)`;
  rows.push({ key: "ledger", value: ledger, tone: "accent" });

  if (summary != null) {
    let s = `${k(summary)} tokens · ${k(d.summaryChars)} chars`;
    if (kept != null) s += ` · kept tail ≈ ${k(kept)}`;
    if (d.before > 0) s += ` · ${(d.before / Math.max(1, summary)).toFixed(0)}:1 compression`;
    rows.push({ key: "summary", value: s });
  }

  if (u && (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0) {
    const sent = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    const hit = (u.cacheRead ?? 0) / sent;
    rows.push({
      key: "request",
      value: `sent ${k(sent)} · cached ${k(u.cacheRead ?? 0)} (${(hit * 100).toFixed(1)}%) · uncached ${k((u.cacheWrite ?? 0) + (u.input ?? 0))} · out ${k(u.output ?? 0)}`,
      tone: hit >= 0.9 ? "success" : hit > 0 ? undefined : "warning",
    });
  }

  if (u?.cost?.total) {
    const c = u.cost;
    const ctx = (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
    let v = money(c.total!);
    if (ctx || c.output) v += `  (context ${money(ctx)} · output ${money(c.output ?? 0)})`;
    // Payback: what every later call stops paying, at the rate this very request paid for cached tokens.
    const rate = (u.cacheRead ?? 0) > 0 && c.cacheRead ? c.cacheRead / u.cacheRead! : (u.input ?? 0) > 0 && c.input ? c.input / u.input! : 0;
    if (rate > 0 && d.after != null && d.before > d.after) {
      const perCall = (d.before - d.after) * rate;
      v += ` · saves ≈ ${money(perCall)}/call → pays back in ${Math.ceil(c.total! / perCall)} calls`;
    }
    rows.push({ key: "cost", value: v });
  }

  if (d.summarizeMs != null) {
    let t = `summarized in ${secs(d.summarizeMs)}`;
    if (d.waitMs != null) t += ` · waited ${secs(d.waitMs)} for a pause · total ${secs(d.summarizeMs + d.waitMs)}`;
    rows.push({ key: "timing", value: t });
    const start = d.at - d.summarizeMs - (d.waitMs ?? 0);
    rows.push({ key: "span", value: `${clock(start)} → ${clock(d.at)}`, tone: "dim" });
  } else {
    rows.push({ key: "span", value: clock(d.at), tone: "dim" });
  }
  return rows;
}
