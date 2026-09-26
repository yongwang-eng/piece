/**
 * Who is waiting on whom — replayed from the run's room record. Pure; no pi imports.
 *
 * Presence says whether a pane is alive; this says why it is idle: the last thing a worker sent was an
 * ask (query/request) to ONE peer or to main, and nothing directed has come back → it waits on them.
 * Its last outbound was a `result` to main and main has not steered it since → done. Consults (waiting
 * on Jane / the governor) are not here — index.ts owns those and lays them over this.
 */
import { readFileSync, statSync } from "node:fs";

export interface Wait { on: string | undefined; why: string; sinceMs: number; done?: boolean }

const housekeeping = new Set(["presence", "vitals", "turn_end", "consult"]);
const asks = new Set(["query", "request"]);
const answers = new Set(["result", "propose", "refuse", "accept", "inform", "error", "request", "query"]);

type Msg = { seq: number; id: string; kind: string; from: string; to: string[]; re?: string | number; at: number; text: string };

const head = (s: string, n = 40) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function replayWaits(text: string, run: string, now: number): Map<string, Wait> {
  const msgs: Msg[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== "message" || e.run !== run || typeof e.from !== "string" || !Array.isArray(e.to)) continue;
    if (housekeeping.has(e.task) || e.from === "room") continue;
    msgs.push({ seq: Number(e.seq) || 0, id: String(e.id ?? ""), kind: String(e.kind), from: e.from, to: e.to.map(String), re: e.re, at: Date.parse(e.at) || 0, text: String(e.text ?? "") });
  }
  msgs.sort((a, b) => a.seq - b.seq);
  const workers = new Set(msgs.map((m) => m.from).filter((f) => f !== "main"));
  const out = new Map<string, Wait>();
  for (const name of workers) {
    // the worker's latest outbound that is an ask to one addressee, or a result to main
    let last: Msg | undefined;
    for (const m of msgs) if (m.from === name && m.to.length === 1 && m.to[0] !== "*" && (asks.has(m.kind) || (m.kind === "result" && m.to[0] === "main"))) last = m;
    if (!last) continue;
    const peer = last.to[0];
    const answered = msgs.some((m) => m.seq > last!.seq && m.from === peer && (
      (m.re !== undefined && (String(m.re) === last!.id || Number(m.re) === last!.seq)) ||
      (m.to.includes(name) && answers.has(m.kind))));
    if (answered) continue;
    if (last.kind === "result") out.set(name, { on: undefined, why: "reported ✓", sinceMs: now - last.at, done: true });
    else out.set(name, { on: peer, why: `${last.kind} #${last.seq} · ${head(last.text)}`, sinceMs: now - last.at });
  }
  return out;
}

const cache = new Map<string, { stamp: string; text: string }>();
/** Cached by file stamp like communicationFor: the board repaints every second, the record changes rarely. */
export function waitsFor(path: string, run: string, now: number): Map<string, Wait> {
  try {
    const st = statSync(path);
    const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    let e = cache.get(path);
    if (!e || e.stamp !== stamp) { e = { stamp, text: readFileSync(path, "utf8") }; cache.set(path, e); }
    return replayWaits(e.text, run, now);
  } catch { return new Map(); }
}
