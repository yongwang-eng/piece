#!/usr/bin/env node
/**
 * k6_board <name> <RUNID> <DURATION_S> [--api 127.0.0.1:6565] [--rate N] [--target host] [--log path] [--summary path]
 *          [--dir /tmp/pi-bg] [--interval-ms 1000]
 * Runs BESIDE `k6 run` in the same bg job and turns k6's REST API into /tmp/pi-bg/<name>.board.json (lib/k6/board.ts),
 * so the job's row on the board shows progress · rps · p95 · fail% · VUs · 429s · dropped · a 60 s sparkline · links.
 * Writes are atomic (tmp + rename). Exits when the API stops answering: if k6's `--summary-export` file (the RUNID link;
 * the same path as --summary) has appeared since the run started, the run ENDED — one last body pinned at 100 %, then one
 * bg tick of linger so the board paints it before the row leaves with the job; no summary = k6 killed (or run without
 * --summary-export) and the last honest body stands. Exits after 60 s if the API never answered (the last fetch error is
 * printed: node's fetch refuses some ports outright, e.g. 6566 "bad port"). Talks only to the address it is given.
 */
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyOf, endedBody, parseMetrics, parseStatus, summaryPath, trackRps, type BoardJson, type Metrics, type Status, type Track } from "../lib/k6/board.ts";

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
const [name, runId, durationArg] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const durationS = Number(durationArg);
if (!name || !runId || !Number.isFinite(durationS) || durationS <= 0) {
  process.stderr.write("usage: k6_board <name> <RUNID> <DURATION_S> [--api 127.0.0.1:6565] [--rate N] [--target host] [--log path] [--summary path] [--dir /tmp/pi-bg] [--interval-ms 1000]\n");
  process.exit(2);
}
const api = `http://${flag("--api") ?? "127.0.0.1:6565"}`;
const dir = flag("--dir") ?? "/tmp/pi-bg";
const intervalMs = Number(flag("--interval-ms")) || 1000;
const rateFlag = Number(flag("--rate"));
const run = { runId, durationS, startedAt: Date.now(), rate: Number.isFinite(rateFlag) && rateFlag > 0 ? rateFlag : undefined, target: flag("--target"), log: flag("--log"), summary: flag("--summary") };
const out = join(dir, `${name}.board.json`);
const NEVER_ANSWERED_MS = 60_000, MISSES_TO_EXIT = 5;
// Must exceed bg's 5 s tick so one tick lands strictly inside (pin, exit): bg removes the row on the job's exit, not on
// a tick, and this wrapper is the job's last child — exit before a tick and the 100 % body reaches the disk, never the screen.
const LINGER_MS = 5_500;

let lastErr = "";
const get = async (path: string): Promise<unknown | undefined> => {
  try { const r = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(Math.min(900, intervalMs)) }); return r.ok ? await r.json() : undefined; }
  catch (e) { lastErr = String((e as { cause?: Error }).cause?.message ?? (e as Error).message); return undefined; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (body: BoardJson): void => { writeFileSync(`${out}.tmp`, JSON.stringify(body)); renameSync(`${out}.tmp`, out); };
/** k6 writes the summary as it exits; allow one tick for it to land before calling the run killed. */
const summaryMtime = async (): Promise<number | undefined> => {
  const until = Date.now() + LINGER_MS;
  for (;;) {
    try { const mt = statSync(summaryPath(run)).mtimeMs; if (mt >= run.startedAt) return mt; } catch { /* not yet */ }
    if (Date.now() >= until) return undefined;
    await sleep(intervalMs);
  }
};

async function main(): Promise<void> {
  mkdirSync(dir, { recursive: true });
  let track: Track | undefined, misses = 0;
  let last: { metrics: Metrics; status: Status | undefined; track: Track; at: number } | undefined;
  for (;;) {
    const [metricsJson, statusJson] = await Promise.all([get("/v1/metrics"), get("/v1/status")]);
    if (!metricsJson) {
      misses++;
      if (last && misses >= MISSES_TO_EXIT) {
        const fin = endedBody(run, last.metrics, last.status, last.track, last.at, await summaryMtime());
        if (fin) write(fin);
        process.stdout.write(`[k6_board] k6 API gone at ${api} — ${fin ? "summary written: run ended, pinned at 100 %" : `no summary at ${summaryPath(run)}: k6 killed or run without --summary-export, last body stands`}\n`);
        if (fin) await sleep(LINGER_MS);
        return;
      }
      if (!last && Date.now() - run.startedAt > NEVER_ANSWERED_MS) { process.stdout.write(`[k6_board] k6 API never answered at ${api} (${lastErr || "no response"}) — done\n`); return; }
      await sleep(intervalMs); continue;
    }
    if (!last) process.stdout.write(`[k6_board] ${api} → ${out}\n`);
    misses = 0;
    const metrics = parseMetrics(metricsJson), status = parseStatus(statusJson);
    const now = Date.now();
    track = trackRps(track, Number(metrics.get("http_reqs")?.count) || 0, now);
    last = { metrics, status, track, at: now };
    write(bodyOf(run, metrics, status, track, now));
    await sleep(intervalMs);
  }
}
main().catch((e) => { process.stderr.write(`[k6_board] ${(e as Error).message}\n`); process.exit(1); });
