#!/usr/bin/env node
// Usage: node scripts/spend-report.mjs [days=7]
// Reads pi's agent.sqlite + compaction.log and reports (a) measured compaction
// economics for the window and (b) the threshold projection table recomputed
// from this window's real usage — so tuning `at` is a re-run, not a re-study.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const days = Number(process.argv[2] ?? 7);
const state = join(homedir(), ".pi", "agent", "state");
const since = Date.now() - days * 86_400_000;
const RATE = { read: 0.25e-6, write: 12.5e-6, out: 50e-6 }; // fable-5-1

const db = new DatabaseSync(join(state, "agent.sqlite"), { readOnly: true });
const calls = db
  .prepare(
    `SELECT m.recorded_at at, m.context_tokens ctx FROM model_calls m
     WHERE m.recorded_at > ? AND m.context_tokens IS NOT NULL ORDER BY m.recorded_at`
  )
  .all(since);
const compactions = db
  .prepare(`SELECT tokens_before, tokens_after, cost, applied, reason, session_id, recorded_at FROM compactions WHERE recorded_at > ?`)
  .all(since);
// first cold write after each compaction = what the wake actually cost
const colds = db
  .prepare(`SELECT t.session_id sid, m.recorded_at at, m.cache_write_tokens w, m.estimated_cost c
            FROM model_calls m JOIN turns t ON m.turn_id=t.id
            WHERE m.recorded_at > ? AND m.cache_read_tokens=0 AND m.cache_write_tokens>20000`)
  .all(since);

// per-call growth (ledger increments), splice landings (= true post-splice floor)
const incs = [], floors = [];
for (let i = 1; i < calls.length; i++) {
  const d = calls[i].ctx - calls[i - 1].ctx;
  if (d > 0 && d < 30_000) incs.push(d);
  if (d < -5_000) floors.push(calls[i].ctx);
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1] ?? 0;
const growthDay = incs.reduce((s, d) => s + d, 0) / days;
const callsDay = calls.length / days;
const B = floors.length ? med(floors) : 80_000;

// summarizer cache-hit ratio from compaction.log usage lines
let hits = [];
try {
  hits = readFileSync(join(state, "compaction.log"), "utf8")
    .split("\n")
    .map((l) => l.match(/\bcached=([\d,]+)\s+uncached=([\d,]+)/))
    .filter(Boolean)
    .map(([, r, i]) => {
      const cr = Number(r.replaceAll(",", "")), inp = Number(i.replaceAll(",", ""));
      return cr / Math.max(1, cr + inp);
    });
} catch {}

const applied = compactions.filter((c) => c.applied).length;
const spent = compactions.reduce((s, c) => s + (c.cost ?? 0), 0);
console.log(`window: last ${days}d · ${calls.length} calls · growth ${(growthDay / 1000).toFixed(0)}k tok/day`);
console.log(`compactions: ${compactions.length} (${applied} applied) · $${spent.toFixed(2)} total · avg trigger ${med(compactions.map((c) => c.tokens_before)) / 1000 | 0}k`);
console.log(`post-splice floor (measured): ${(B / 1000).toFixed(0)}k across ${floors.length} splices`);
if (hits.length) console.log(`summarizer cache-hit ratio: median ${(med(hits) * 100).toFixed(1)}% over ${hits.length} runs`);

console.log(`\nthreshold projection from THIS window's usage:`);
console.log(`   T  compacts/day   $/day   runway`);
for (const T of [150_000, 200_000, 250_000]) {
  if (T <= B + 10_000) continue;
  const cyc = growthDay / (T - B);
  const $ = callsDay * ((T + B) / 2) * RATE.read + cyc * (T * RATE.read + 8_000 * RATE.out) + cyc * 28_000 * RATE.write;
  console.log(`${(T / 1000).toString().padStart(4)}k  ${cyc.toFixed(1).padStart(12)}  ${$.toFixed(2).padStart(6)}  ${((T - B) / 1000).toFixed(0).padStart(5)}k`);
}

// --- idle compaction: attribution first, then economics -------------------------------------
// Source of truth is compaction.log, not sqlite: of the first four idle compactions, only three
// got a `compactions` row, so a DB-based count silently under-reports what the trigger did.
let appliedLog = "";
try { appliedLog = readFileSync(join(state, "compaction.log"), "utf8"); } catch {}
const LIMIT = 200_000, LEAD = 10_000;       // the threshold path is gated `tokens > limit - lead`
const fires = [...appliedLog.matchAll(
  /applied idle (\d+)s before=(\d+) after=(\d+)(?:.*?cached=(\d+) uncached=(\d+))?.*?model=(\S+).*?cost=([\d.]+)/g
)].map((m) => ({
  idleS: +m[1], before: +m[2], after: +m[3],
  cached: m[4] ? +m[4] : null, uncached: m[5] ? +m[5] : null, model: m[6], cost: +m[7],
}));

console.log(`\nidle-triggered background compactions`);
if (!fires.length) {
  console.log(`   none yet · trigger fires above ${(150_000 / 1000) | 0}k after 4.5min quiet`);
} else {
  // Lines written before `applied` carried warmth can still be resolved: the summarizer line
  // reports the same cost, so match on it rather than scoring an unknown as a win.
  const sums = [...appliedLog.matchAll(/summarizer strategy=appended cached=(\d+) uncached=(\d+) .*?cost=([\d.]+)/g)]
    .map((m) => ({ cached: +m[1], uncached: +m[2], cost: +m[3] }));
  for (const f of fires) {
    if (f.cached !== null) continue;
    const hit = sums.find((x) => Math.abs(x.cost - f.cost) < 1e-3);
    if (hit) { f.cached = hit.cached; f.uncached = hit.uncached; }
  }
  const warm = fires.filter((f) => f.cached !== null && f.cached > f.uncached);
  const cold = fires.filter((f) => f.cached !== null && f.cached <= f.uncached);
  const unknown = fires.filter((f) => f.cached === null);
  const sum = (a) => a.reduce((s, f) => s + f.cost, 0);
  const attempts = (appliedLog.match(/\[trigger\] idle: .*→ summarize=started/g) ?? []).length;
  if (attempts > fires.length) console.log(`   attempted ${attempts} · ${attempts - fires.length} dropped before apply (reload/shutdown raced it — cost unknown, summarizer calls are invisible to model_calls)`);
  console.log(`   fired ${fires.length} · warm ${warm.length} ($${sum(warm).toFixed(2)}) · COLD ${cold.length} ($${sum(cold).toFixed(2)})${unknown.length ? ` · warmth unknown ${unknown.length} ($${sum(unknown).toFixed(2)})` : ""} · total $${sum(fires).toFixed(2)}`);
  console.log(`   fire point: median ${med(fires.map((f) => f.idleS))}s idle · ledger ${(Math.min(...fires.map((f) => f.before)) / 1000) | 0}k-${(Math.max(...fires.map((f) => f.before)) / 1000) | 0}k → ${(med(fires.map((f) => f.after)) / 1000) | 0}k`);
  // Attribution that does not trust our own label: the threshold path CANNOT fire below this floor.
  const ceiling = Math.max(...fires.map((f) => f.before));
  console.log(ceiling <= LIMIT - LEAD
    ? `   attribution: all ${fires.length} below ${((LIMIT - LEAD) / 1000) | 0}k, the floor the threshold path needs — that path could not have produced them`
    : `   attribution: ${fires.filter((f) => f.before > LIMIT - LEAD).length} fire(s) above ${((LIMIT - LEAD) / 1000) | 0}k — label is the only evidence for those`);
  if (cold.length) console.log(`   ⚠ ${cold.length} fired COLD (cache already gone): paid $${sum(cold).toFixed(2)} to avoid a cold write, which is the failure this is supposed to prevent`);
  // Warmth by model: a provider-specific miss (EXP-009, OpenAI prompt_cache_key) shows here as one model 0% warm.
  const byModel = new Map();
  for (const f of fires) { const b = byModel.get(f.model) ?? { n: 0, warm: 0, cold: 0, cost: 0 }; b.n++; b.cost += f.cost; if (f.cached !== null) (f.cached > f.uncached ? b.warm++ : b.cold++); byModel.set(f.model, b); }
  console.log(`   by model: ` + [...byModel].map(([m, b]) => `${m} ${b.n} (warm ${b.warm} · cold ${b.cold}${b.n - b.warm - b.cold ? ` · ? ${b.n - b.warm - b.cold}` : ""} · $${b.cost.toFixed(2)})`).join(" · "));

  // Payoff needs a session id, which only sqlite has — report coverage honestly.
  const rows = compactions.filter((c) => String(c.reason ?? "").startsWith("idle"));
  let paired = 0, actual = 0, counter = 0;
  for (const c of rows) {
    const next = colds.filter((x) => x.sid === c.session_id && x.at > c.recorded_at).sort((a, b) => a.at - b.at)[0];
    if (!next) continue;
    paired++; actual += next.c ?? 0;
    counter += (c.tokens_before + (next.w - (c.tokens_after ?? 0))) * RATE.write;
  }
  console.log(paired
    ? `   payoff: ${paired}/${fires.length} wakes observed · actual $${actual.toFixed(2)} vs uncompacted ~$${counter.toFixed(2)} · net ~$${(counter - actual - sum(fires)).toFixed(2)}`
    : `   payoff: 0/${fires.length} wakes observed yet — PAYOFF UNPROVEN (a session never resumed saved nothing)`);
  if (rows.length !== fires.length) console.log(`   note: sqlite has ${rows.length}/${fires.length} of these — payoff math covers only those`);
}
