/** Pure fold over session entries → per-call and session-level context/cost stats. */
import type { Ledger, Miss, Compaction } from "./ledger.ts";

export type CallRow = {
  n: number;
  fresh: number; // uncached input tokens
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
  /** what this call paid to RE-SEND the ledger (input + cache read + cache write) */
  costCtx: number;
  /** what it paid to GENERATE (output, thinking included) */
  costOut: number;
  stop: string;
  tools: number;
};

export type ToolWeight = { name: string; bytes: number };

export type CtxStats = {
  calls: CallRow[];
  totals: { calls: number; cost: number; fresh: number; cacheRead: number; cacheWrite: number; output: number };
  hitRate: number; // cacheRead share of all prefix tokens sent
  contextNow: number; // last call's full request size
  cacheResets: number; // calls after #1 whose read was 0 but wrote a large prefix
  topTools: ToolWeight[];
};

// Entries as sessionManager.getBranch() returns them: {type:"message", message:{role,...}} among others.
export function computeStats(entries: any[]): CtxStats {
  const calls: CallRow[] = [];
  const toolSizes = new Map<string, number>();
  let toolsInCurrent = 0;

  for (const e of entries) {
    const m = e?.message ?? e; // tolerate raw messages
    if (!m || typeof m !== "object") continue;
    if (m.role === "toolResult") {
      const bytes = JSON.stringify(m.content ?? "").length;
      const name = m.toolName ?? "?";
      toolSizes.set(name, (toolSizes.get(name) ?? 0) + bytes);
      continue;
    }
    if (m.role !== "assistant") continue;
    const u = m.usage;
    toolsInCurrent = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "toolCall").length : 0;
    if (!u || typeof u.input !== "number") continue; // assistant entries without usage (aborted etc.)
    calls.push({
      n: calls.length + 1,
      fresh: u.input,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      output: u.output ?? 0,
      cost: u.cost?.total ?? 0,
      costCtx: (u.cost?.input ?? 0) + (u.cost?.cacheRead ?? 0) + (u.cost?.cacheWrite ?? 0),
      costOut: u.cost?.output ?? 0,
      stop: m.stopReason ?? "?",
      tools: toolsInCurrent,
    });
  }

  const totals = calls.reduce(
    (t, c) => ({
      calls: t.calls + 1,
      cost: t.cost + c.cost,
      fresh: t.fresh + c.fresh,
      cacheRead: t.cacheRead + c.cacheRead,
      cacheWrite: t.cacheWrite + c.cacheWrite,
      output: t.output + c.output,
    }),
    { calls: 0, cost: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
  const prefixTokens = totals.fresh + totals.cacheRead + totals.cacheWrite;
  const last = calls[calls.length - 1];
  const cacheResets = calls.filter((c, i) => i > 0 && c.cacheRead === 0 && c.cacheWrite + c.fresh > 1024).length;
  const topTools = [...toolSizes.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  return {
    calls,
    totals,
    hitRate: prefixTokens > 0 ? totals.cacheRead / prefixTokens : 0,
    contextNow: last ? last.fresh + last.cacheRead + last.cacheWrite : 0,
    cacheResets,
    topTools,
  };
}

const SPARK = "▁▂▃▄▅▆▇█";
/** Both sides of a comparison must carry the SAME unit: "202.9k → 6310" is a reading bug. */
const tok = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** Context over time as a shape: the sawtooth IS compaction economics — a ramp you pay for on
 *  every call, cut by each ▼. Scaled to the window so the height means "share of what I'm renting". */
export function sawtooth(points: Ledger["points"], width = 48): string[] {
  const ctxPoints = points.filter(p => !p.compaction && p.context > 0);
  if (ctxPoints.length < 2) return [];
  const peak = Math.max(...ctxPoints.map(p => p.context));
  const step = Math.max(1, Math.ceil(points.length / width));
  const line: string[] = [];
  for (let i = 0; i < points.length; i += step) {
    const slice = points.slice(i, i + step);
    if (slice.some(p => p.compaction)) { line.push("▼"); continue; }
    const top = Math.max(...slice.map(p => p.context));
    if (top <= 0) continue;
    line.push(SPARK[Math.min(SPARK.length - 1, Math.floor((top / peak) * (SPARK.length - 1)))]);
  }
  return [line.join(""), `${tok(Math.min(...ctxPoints.map(p => p.context)))} → ${tok(peak)} tok · ▼ = compaction`];
}

/** Why a call paid full freight. A compaction rewrites the prefix, so the next call MUST miss —
 *  that is the price of the cut, not a leak. Anything else is a cold start or a TTL expiry. */
export function missCause(m: Miss, compactions: Compaction[]): string {
  const after = compactions.find(c => m.at >= c.at && m.at - c.at < 5 * 60_000);
  return after ? "after compaction (prefix rewritten)" : "cold start / 5-min TTL expiry";
}
