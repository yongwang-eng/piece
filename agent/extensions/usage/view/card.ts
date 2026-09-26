/**
 * The /usage card — five numbers that change a habit, read in three seconds, then the tables one word away.
 * Pure: builds a JSON-serializable model (appendEntry data), derives rule-based insights, renders with a palette.
 */
import { elapsed } from "../../../lib/agent-ui/time.ts";
import { displayWidth } from "../../../lib/agent-ui/width.ts";
import { linkText, type Palette } from "../../../lib/agent-ui/board.ts";
import type { Ledger } from "./ledger.ts";
import type { CtxStats } from "./stats.ts";
import { missCause, sawtooth } from "./stats.ts";

export type Card = {
  model: string; elapsed: string; calls: number;
  sessionCost: number; todayCost?: number; sharePct?: number; weekMedian?: number;
  ctxNow: number; ctxWindow: number; ctxPct: number;
  hitPct: number; misses: number; missCost: number; missSharePct: number; missesAvoidable: number; missCostAvoidable: number;
  output: number; reasoning: number;
  compactions: number; compactionCost: number;
  todayCompactions?: { count: number; cost: number; avgBefore: number; avgSummary: number; byTrigger: { trigger: string; count: number; cost: number }[] };
  today?: { calls: number; cost: number; hitPct: number; split: { label: string; cost: number; pct: number }[]; hotCalls: number; hotCost: number; coldCalls: number; coldCost: number; coldSharePct: number; byKind: { kind: string; cost: number }[] };
  dropped: { count: number; cost: number };
  sawtooth: string[];
  topTools: { name: string; bytes: number }[];
  week: { day: string; cost: number }[];
};

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function buildCard(stats: CtxStats, ledger: Ledger | null, o: { contextWindow: number; now?: number }): Card {
  const now = o.now ?? Date.now();
  const l = ledger;
  const misses = l?.cache.misses ?? [];
  // A miss right after a compaction is the price of the cut; the rest are cold starts / TTL expiry — those are the habit.
  const avoidable = misses.filter((m) => !missCause(m, l?.compactions ?? []).startsWith("after compaction"));
  const sessionCost = l ? l.cost + l.compactions.reduce((t, c) => t + c.cost, 0) : stats.totals.cost;
  const todayCost = l ? l.today.reduce((t, r) => t + r.cost, 0) : undefined;
  return {
    model: l?.model || "", elapsed: l?.startedAt ? elapsed(now - l.startedAt) : "", calls: l?.calls ?? stats.totals.calls,
    sessionCost, todayCost, sharePct: todayCost ? pct(sessionCost, todayCost) : undefined,
    weekMedian: l?.week?.length ? median(l.week.map((d) => d.cost)) : undefined,
    ctxNow: stats.contextNow, ctxWindow: o.contextWindow, ctxPct: pct(stats.contextNow, o.contextWindow),
    hitPct: Math.round(l ? l.cache.hitPct : stats.hitRate * 100), misses: l ? misses.length : stats.cacheResets,
    missCost: l?.cache.missCost ?? 0, missSharePct: l ? pct(l.cache.missCost, sessionCost) : 0,
    missesAvoidable: avoidable.length, missCostAvoidable: avoidable.reduce((t, m) => t + m.cost, 0),
    output: stats.totals.output, reasoning: l?.reasoning ?? 0,
    compactions: l?.compactions.length ?? 0, compactionCost: l?.compactions.reduce((t, c) => t + c.cost, 0) ?? 0, todayCompactions: l?.todayCompactions,
    today: l?.todaySplit && l.todaySplit.calls > 0 ? (() => { const t = l.todaySplit; const seg = (label: string, cost: number) => ({ label, cost, pct: pct(cost, t.cost) }); return {
      calls: t.calls, cost: t.cost, hitPct: Math.round(t.hitPct),
      split: [seg("fresh", t.fresh), seg("cache read", t.cacheRead), seg("cache write", t.cacheWrite), seg("output", t.output)],
      hotCalls: t.hotCalls, hotCost: t.hotCost, coldCalls: t.coldCalls, coldCost: t.coldCost, coldSharePct: pct(t.coldCost, t.cost),
      byKind: l.today.map((r) => ({ kind: r.kind, cost: r.cost })) }; })() : undefined,
    dropped: { count: l?.dropped.count ?? 0, cost: l?.dropped.cost ?? 0 },
    sawtooth: l ? sawtooth(l.points, 24) : [],
    topTools: stats.topTools.slice(0, 2),
    week: l?.week ?? [],
  };
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Rule-based, ranked by $ at stake, ≤3. A line appears only when its rule fires; each names what to do. */
export function insights(c: Card): string[] {
  const out: { cost: number; text: string }[] = [];
  if (c.missesAvoidable > 0 && c.misses > 0)
    out.push({ cost: c.missCostAvoidable, text: `${c.missesAvoidable} of ${c.misses} misses were cold-start / TTL, not compaction — ${usd(c.missCostAvoidable)} avoidable (keep the session warm; compact before a reload)` });
  if (c.dropped.count > 0)
    out.push({ cost: c.dropped.cost, text: `${c.dropped.count} background summar${c.dropped.count > 1 ? "ies" : "y"} discarded — ${usd(c.dropped.cost)} spent without compacting` });
  if (c.weekMedian && c.todayCost && c.todayCost >= 1.5 * c.weekMedian)
    out.push({ cost: c.todayCost - c.weekMedian, text: `today is ${(c.todayCost / c.weekMedian).toFixed(1)}× your 7-day median ($${Math.round(c.weekMedian)}/day) — the dashboard's sessions panel names where` });
  if (c.today && c.today.coldSharePct >= 15)
    out.push({ cost: c.today.coldCost, text: `${c.today.coldCalls} cold calls = ${c.today.coldSharePct}% of today's spend ($${Math.round(c.today.coldCost)}) — each re-bought a full prefix; fewer restarts, compact before a reload` });
  if (c.ctxPct >= 70)
    out.push({ cost: 0.5, text: `context ${c.ctxPct}% full — every call re-sends ${k(c.ctxNow)} tok; compact at a boundary you choose, not the one the limit picks` });
  if (c.topTools[0]?.bytes >= 100_000)
    out.push({ cost: 0.1, text: `${c.topTools.map((t) => `${t.name} ${k(t.bytes)} B`).join(" · ")} on branch → the compaction target` });
  return out.sort((a, b) => b.cost - a.cost).slice(0, 3).map((o) => o.text);
}

/** Word-wrap to a display width; an insight is the one line that runs long. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []; let cur = "";
  for (const word of text.split(" ")) {
    if (cur && displayWidth(cur) + 1 + displayWidth(word) > width) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

const SPARK = "▁▂▃▄▅▆▇█";
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** The trajectory: one bar per local day for the last 7, today marked, $ under each. Three lines, no axis. */
export function weekChart(week: { day: string; cost: number }[], width: number): string[] {
  if (week.length === 0) return [];
  const peak = Math.max(...week.map((d) => d.cost), 1);
  const col = Math.max(5, Math.min(8, Math.floor(width / 7)));
  const cell = (s: string) => padTo(s, col);
  const bars = week.map((d) => cell(SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round((d.cost / peak) * (SPARK.length - 1))))].repeat(3)));
  const today = new Date().toISOString().slice(0, 10);
  const days = week.map((d) => cell(d.day === today || d === week.at(-1) ? "today" : DOW[new Date(`${d.day}T12:00:00`).getDay()]));
  const money = week.map((d) => cell(`$${Math.round(d.cost)}`));
  return [bars.join(""), days.join(""), money.join("")];
}

const SPLIT_TONES = ["text", "accent", "warning", "success"];
/** A stacked bar of percentages, one tone per segment, exactly `width` cells. */
export function splitBar(pcts: number[], width: number, pal: Palette): string {
  const cells = pcts.map((p) => Math.round((p / 100) * width));
  let drift = width - cells.reduce((a, b) => a + b, 0); for (let i = 0; drift !== 0 && i < cells.length; i++) { const d = Math.sign(drift); if (cells[i] + d >= 0) { cells[i] += d; drift -= d; } }
  return cells.map((n, i) => pal.fg(SPLIT_TONES[i % SPLIT_TONES.length], "█".repeat(n))).join("");
}

export function bar(pctFull: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pctFull)) / 100) * width);
  return "▇".repeat(filled) + "░".repeat(width - filled);
}

const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - displayWidth(s)));
const justify = (left: string, right: string, width: number, plainLeft = left, plainRight = right) =>
  left + " ".repeat(Math.max(1, width - displayWidth(plainLeft) - displayWidth(plainRight))) + right;

export function renderCard(c: Card, width: number, pal: Palette, dashboardUrl?: string): string[] {
  const w = Math.max(60, width);
  const dim = (s: string) => pal.fg("dim", s), txt = (s: string) => pal.fg("text", s), mut = (s: string) => pal.fg("muted", s);
  const ctxTone = c.ctxPct >= 85 ? "error" : c.ctxPct >= 70 ? "warning" : "success";
  const missTone = c.missSharePct >= 10 ? "error" : c.missSharePct >= 5 ? "warning" : "text";

  const headL = `usage · this session`, headR = [c.model, c.elapsed, `${c.calls} call${c.calls === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const lines: string[] = [justify(txt(headL), dim(headR), w, headL, headR), dim("─".repeat(w))];

  const col1 = padTo(`${usd(c.sessionCost)}  session`, 22);
  const col2 = c.todayCost !== undefined ? padTo(`$${Math.round(c.todayCost)} today · you = ${c.sharePct}%`, 30) : padTo("today: no ledger", 30);
  const ctxStr = `ctx ${k(c.ctxNow)}/${k(c.ctxWindow)} ${bar(c.ctxPct, 10)} ${c.ctxPct}%`;
  lines.push(`${txt(col1)}${mut(col2)}${pal.fg(ctxTone, ctxStr)}`);

  const cacheStr = `cache ${c.hitPct}% hit · ${c.misses} miss${c.misses === 1 ? "" : "es"} = ${usd(c.missCost)} (${c.missSharePct}% of spend)`;
  const outStr = `out ${k(c.output)}${c.reasoning ? ` · thinking ${k(c.reasoning)}` : ""}`;
  lines.push(`${pal.fg(missTone, padTo(cacheStr, 52))}${mut(outStr)}`);

  if (c.sawtooth.length) {
    const comp = `▼ ${c.compactions} compaction${c.compactions === 1 ? "" : "s"} ${usd(c.compactionCost)}${c.todayCompactions ? ` · ${c.todayCompactions.count} today ${usd(c.todayCompactions.cost)}` : ""}`;
    lines.push(`${pal.fg("accent", c.sawtooth[0])}   ${dim(c.sawtooth[1].replace(/ · ▼ = compaction$/, ""))} · ${mut(comp)}`);
  }

  const tips = insights(c);
  if (tips.length) { lines.push(""); for (const t of tips) for (const [i, part] of wrap(t, w - 3).entries()) lines.push(i === 0 ? `${pal.fg("warning", "💡")} ${txt(part)}` : `   ${txt(part)}`); }

  if (c.today) {
    const t = c.today, tc = c.todayCompactions;
    lines.push("");
    lines.push(txt(`today · $${Math.round(t.cost)} · ${t.calls} calls · ${t.hitPct}% hit`));
    if (tc && tc.count) lines.push(dim(`compactions ${tc.count} · ${usd(tc.cost)} · ${k(tc.avgBefore)} → ${k(tc.avgSummary)} avg · ${tc.byTrigger.map((b) => `${b.trigger} ${b.count}${b.cost ? ` ${usd(b.cost)}` : ""}`).join(" · ")}`));
    const legend = t.split.map((s, i) => pal.fg(SPLIT_TONES[i], `${s.label} ${s.pct}%`)).join(dim(" · "));
    lines.push(`${splitBar(t.split.map((s) => s.pct), 30, pal)}  ${legend}`);
    const coldTone = t.coldSharePct >= 15 ? "error" : t.coldSharePct >= 8 ? "warning" : "muted";
    const hot = `hot ${t.hotCalls} calls $${Math.round(t.hotCost)} · `, cold = `cold ${t.coldCalls} calls $${Math.round(t.coldCost)} = ${t.coldSharePct}% of today`;
    const kinds = t.byKind.filter((r) => r.cost >= 0.5).map((r) => `${r.kind} $${Math.round(r.cost)}`).join(" · ");
    lines.push(justify(mut(hot) + pal.fg(coldTone, cold), mut(kinds), w, hot + cold, kinds));
  }

  const chart = weekChart(c.week, Math.min(w, 60));
  if (chart.length) {
    lines.push("");
    lines.push(pal.fg("accent", chart[0]));
    lines.push(mut(chart[1]));
    lines.push(txt(chart[2]));
  }
  lines.push("");
  const total = c.week.reduce((t, d) => t + d.cost, 0);
  const footL = c.week.length ? `7 days · $${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : Math.round(total)} · median $${Math.round(c.weekMedian ?? 0)}/day` : "";
  const footR = dashboardUrl ? linkText(pal, "dashboard ↗", dashboardUrl) : "";
  lines.push(justify(dim(footL), footR, w, footL, dashboardUrl ? "dashboard ↗" : ""));
  return lines;
}
