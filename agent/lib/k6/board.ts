/**
 * k6's REST API (http://127.0.0.1:6565/v1 while a run is live) → the `.board.json` body a bg job's row shows
 * (extensions/bg/board-file.ts): progress · rps · p95 · fail% · VUs · 429s · dropped · a 60 s rps sparkline · links.
 * Pure: bin/k6_board.ts does the polling and the atomic write. Two facts about the API shape this file encodes:
 * `http_reqs.rate` is cumulative since start (so rps is Δcount/Δt between polls), and a metric id is absent until its
 * first sample (so a missing counter is 0 — `dropped_iterations`, and the custom `rate_limited` — never an error).
 */
import { fmtNum } from "../agent-ui/section.ts";

export type Sample = Record<string, number | null | undefined>;
export type Metrics = Map<string, Sample>;
export type Status = { running: boolean; tainted: boolean; vus: number; vusMax: number };
/** The rps window: the last poll's counter and the points since. */
export type Track = { at: number; count: number; points: number[] };
export type Run = { runId: string; durationS: number; startedAt: number; rate?: number; target?: string; log?: string; summary?: string };
export type BoardJson = {
  detail: string;
  progress: { value: number; label: string };
  stats: Array<{ label: string; value: string; tone?: "alert" | "quiet" }>;
  series?: { label: string; points: number[]; unit: string };
  links: Array<{ label: string; url: string }>;
};

const WINDOW = 60;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** `GET /v1/metrics` → id → sample. Anything malformed is skipped, not thrown. */
export function parseMetrics(json: unknown): Metrics {
  const out: Metrics = new Map();
  if (!obj(json) || !Array.isArray(json.data)) return out;
  for (const m of json.data) if (obj(m) && typeof m.id === "string" && obj(m.attributes) && obj(m.attributes.sample)) out.set(m.id, m.attributes.sample);
  return out;
}

/** `GET /v1/status` → the four facts the board uses. */
export function parseStatus(json: unknown): Status | undefined {
  const a = obj(json) && obj(json.data) ? json.data.attributes : undefined;
  if (!obj(a)) return undefined;
  return { running: !!a.running, tainted: !!a.tainted, vus: Number(a.vus) || 0, vusMax: Number(a["vus-max"]) || 0 };
}

/** One poll of `http_reqs.count` at `now`: rps = Δcount/Δt since the last poll; a counter that went backwards reads 0. */
export function trackRps(prev: Track | undefined, count: number, now: number): Track {
  if (!prev || now <= prev.at) return { at: prev?.at ?? now, count: prev?.count ?? count, points: prev?.points ?? [] };
  const rps = Math.max(0, (count - prev.count) / ((now - prev.at) / 1000));
  return { at: now, count, points: [...prev.points, rps].slice(-WINDOW) };
}

/** Where `k6 run --summary-export` writes: the RUNID link, and the fact that the run ENDED — a killed k6 never writes it. */
export const summaryPath = (run: Run): string => run.summary ?? `/tmp/k6_${run.runId}.json`;

/** The one body the wrapper writes after the API is gone: pinned at 100 % with the last numbers, on the fact that k6 wrote its
 *  summary since the run started (k6 closes the API before it ever answers running=false). No summary → undefined: k6 was
 *  killed, or run without --summary-export, and the last honest body stands. */
export function endedBody(run: Run, m: Metrics, st: Status | undefined, tr: Track, lastAt: number, summaryMtimeMs: number | undefined): BoardJson | undefined {
  if (summaryMtimeMs === undefined || summaryMtimeMs < run.startedAt) return undefined;
  return bodyOf(run, m, { ...(st ?? { tainted: false, vus: 0, vusMax: 0 }), running: false }, tr, lastAt);
}

/** 45s · 4m12 · 10m · 1h05 — seconds as a person would write a test duration. */
export function durText(s: number): string {
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), r = t % 60;
  if (m < 60) return `${m}m${r ? String(r).padStart(2, "0") : ""}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const n = (v: number | null | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The body for this tick. Stats are in importance order because the host cuts them from the right. */
export function bodyOf(run: Run, m: Metrics, st: Status | undefined, tr: Track, now: number): BoardJson {
  const over = st ? !st.running : false;
  const elapsed = (now - run.startedAt) / 1000;
  const done = over || elapsed >= run.durationS;
  const p95 = n(m.get("http_req_duration")?.["p(95)"]);
  const fail = (n(m.get("http_req_failed")?.rate) ?? 0) * 100;
  const vus = st?.vus || n(m.get("vus")?.value), vusMax = st?.vusMax || n(m.get("vus_max")?.value);
  const rateLimited = n(m.get("rate_limited")?.count) ?? 0;
  const dropped = n(m.get("dropped_iterations")?.count) ?? 0;
  const rps = tr.points.length ? tr.points[tr.points.length - 1] : 0;
  const log = run.log ?? `/tmp/k6_${run.runId}.log`, summary = summaryPath(run);
  return {
    detail: `${run.runId}${run.rate ? ` · ${run.rate}/s` : ""}${run.target ? ` vs ${run.target}` : ""}`,
    progress: done
      ? { value: 1, label: `${durText(run.durationS)} / ${durText(run.durationS)}` }
      : { value: elapsed / run.durationS, label: `${durText(elapsed)} / ${durText(run.durationS)} · ~${durText(run.durationS - elapsed)}` },
    stats: [
      { label: "rps", value: fmtNum(rps) },
      { label: "p95", value: p95 === undefined ? "—" : `${Math.round(p95)}ms` },   // whole ms: a tenth of a millisecond is noise at a glance
      { label: "fail", value: `${fmtNum(fail)}%`, ...(st?.tainted ? { tone: "alert" as const } : {}) },
      { label: "VUs", value: `${vus ?? "?"}/${vusMax ?? "?"}` },
      { label: "429s", value: fmtNum(rateLimited) },
      { label: "dropped", value: fmtNum(dropped), tone: dropped > 0 ? "alert" : "quiet" },
    ],
    ...(tr.points.length ? { series: { label: "rps", points: tr.points, unit: "/s" } } : {}),
    links: [
      { label: "log", url: `file://${log}` },
      { label: "dashboard", url: `https://app.datadoghq.com/dashboard/REPLACE-ME?tpl_var_runid=${encodeURIComponent(run.runId)}` },
      { label: "events", url: `https://app.datadoghq.com/logs?query=${encodeURIComponent(`@http.useragent:k6-burst/${run.runId}`)}` },
      { label: run.runId, url: `file://${summary}` },
    ],
  };
}
