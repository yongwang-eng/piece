/**
 * Read model over a run directory: roster prose, the HIGH-LEVEL timeline (lifecycle events only — never the
 * `room_publish` stream, design §3b), artifacts, evidence files. Pure over paths; the store supplies the index.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { where as whereLive, type Spot } from "../../../agent/lib/where.ts";

export type RosterMember = { name: string; id?: number; role: string; responsibility?: string; presence: string; backend?: string; profile?: string; model?: string; joinedAt?: string; lastSeen?: string };
export type TimelineRow = { at: string; icon: string; text: string; worker?: string; consult?: string };
export type Artifacts = { dir: string; project?: string; name?: string } | null;

const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
/** room.jsonl rows are flat envelopes (`{type:"message", from, to, kind, …}`); older logs nested them under `envelope`. */
const envelopeOf = (r: any) => (r?.type === "message" ? (r.envelope ?? r) : null);
const readLines = (path: string): any[] => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/** roster.json ∪ every `worker_spawned` in the log — the file lists only members that announced on this main's channel,
 *  so a run's workers are recovered from the log (role, profile, model, pane), keeping whatever the file knows. */
export function roster(runDir: string): RosterMember[] {
  const byName = new Map<string, RosterMember>();
  for (const m of readJson<{ members: RosterMember[] }>(`${runDir}/roster.json`)?.members ?? []) byName.set(m.name, { ...m });
  for (const e of readLines(`${runDir}/log.jsonl`)) {
    if (e.event === "worker_spawned" && e.worker) {
      const m = byName.get(e.worker) ?? { name: e.worker, role: e.role ?? e.profile ?? "worker", presence: "unknown", backend: "crew" };
      byName.set(e.worker, { ...m, role: m.role && m.role !== m.name ? m.role : (e.role ?? e.profile ?? m.role), profile: m.profile ?? e.profile, model: m.model ?? e.model, joinedAt: m.joinedAt ?? e.at });
    }
    if ((e.event === "worker_killed" || e.event === "worker_gone" || e.event === "worker_shutdown") && byName.has(e.worker)) byName.get(e.worker)!.presence = "gone";
  }
  return [...byName.values()];
}

export function artifacts(runDir: string): Artifacts { return readJson<Artifacts>(`${runDir}/artifacts.json`); }

/** The lifecycle events worth a row, and how to say them. Anything not listed is not high-level. */
const SAY: Record<string, (e: any) => { icon: string; text: string } | undefined> = {
  worker_spawned: (e) => ({ icon: "＋", text: `spawned ${e.worker}${e.profile ? ` (${e.profile})` : ""}${e.model ? ` · ${e.model.split("/").pop()}` : ""}` }),
  consult_to_human: (e) => ({ icon: "◆", text: `${e.worker} asked ${e.class} → you` }),
  consult_answered: (e) => ({ icon: "◇", text: `${e.worker}'s ${e.kind ?? e.class ?? "consult"} answered by ${e.by}` }),
  consult_withdrawn: (e) => ({ icon: "◇", text: `${e.worker}'s consult withdrawn — ${e.reason}` }),
  consult_escalated: (e) => ({ icon: "◆", text: `governor escalated ${e.worker}'s consult to you` }),
  report: (e) => ({ icon: e.status === "aborted" ? "✕" : "✓", text: `${e.worker} reported${e.status ? ` · ${e.status}` : ""}` }),
  worker_stalled: (e) => ({ icon: "⚠", text: `${e.worker} stalled${e.elapsed ? ` ${e.elapsed}` : ""}` }),
  worker_unstalled: (e) => ({ icon: "·", text: `${e.worker} recovered` }),
  model_failover: (e) => ({ icon: "↻", text: `${e.worker} model failover${e.from ? ` ${String(e.from).split("/").pop()} → ${String(e.to).split("/").pop()}` : ""}` }),
  model_switch_sent: (e) => ({ icon: "↻", text: `${e.worker} switched to ${String(e.model ?? "").split("/").pop()}` }),
  governor_model_fallback: (e) => ({ icon: "↻", text: `governor fell back to ${String(e.to ?? e.model ?? "").split("/").pop()}` }),
  artifacts_created: (e) => ({ icon: "▤", text: `artifacts → ${String(e.dir).split("/").slice(-2).join("/")}` }),
  decided: (e) => ({ icon: "✎", text: `${e.worker ?? "main"} decided: ${String(e.what ?? "").slice(0, 120)}` }),
  rulings_checked: () => ({ icon: "·", text: "rulings checked before deciding" }),
  worker_killed: (e) => ({ icon: "－", text: `${e.worker} disposed — ${e.reason ?? ""}`.trim() }),
  worker_gone: (e) => ({ icon: "✕", text: `${e.worker} gone — ${e.why ?? ""}`.trim() }),
  worker_shutdown: (e) => ({ icon: "－", text: `${e.worker} shut down${e.reason ? ` — ${e.reason}` : ""}` }),
  respawn_failed: (e) => ({ icon: "✕", text: `respawn of ${e.worker} failed` }),
  error: (e) => ({ icon: "✕", text: `error: ${String(e.error ?? e.message ?? "").slice(0, 120)}` }),
  dead_request: (e) => ({ icon: "✕", text: `request to ${e.to ?? e.worker ?? "?"} went unanswered` }),
  context_pressure: (e) => ({ icon: "◐", text: `${e.worker} under context pressure` }),
  merged: (e) => ({ icon: "✓", text: `merged${e.branch ? ` ${e.branch}` : ""}` }),
};

/** Lifecycle events (log.jsonl) merged with what members SAID (room.jsonl), in time order. Left out of the said-half:
 *  notices (joins, vitals, state, turn_end — telemetry, not speech), consult wire bodies (JSON; the lifecycle row says it),
 *  and consult answers (already `consult_answered`). Bodies are cut for the row; room.jsonl keeps the full text. */
export function timeline(runDir: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const e of readLines(`${runDir}/log.jsonl`)) {
    const say = SAY[e.event]?.(e); if (!say) continue;
    rows.push({ at: e.at, ...say, worker: e.worker, consult: e.id });
  }
  for (const m of readLines(`${runDir}/room.jsonl`).map(envelopeOf)) {
    if (!m || m.kind === "notice" || m.task === "consult" || (m.kind === "result" && /^c-/.test(m.re ?? ""))) continue;
    const body = String(m.text ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    const to = (m.to ?? []).join(", ");
    rows.push({ at: m.at, icon: m.from === "main" ? "→" : "›", text: `${m.from} → ${to}: ${body.length > 200 ? body.slice(0, 200) + "…" : body}`, worker: m.from === "main" ? undefined : m.from });
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** finished-crew status from the log: merged > aborted > reported > ended. Live status is the caller's (CLIENT LIST). */
export function outcome(runDir: string): "merged" | "aborted" | "reported" | "ended" {
  const events = readLines(`${runDir}/log.jsonl`);
  if (events.some((e) => e.event === "merged")) return "merged";
  const reports = events.filter((e) => e.event === "report");
  if (reports.length && reports.every((e) => e.status === "aborted")) return "aborted";
  if (reports.length) return "reported";
  return "ended";
}

export function evidence(runDir: string, worker: string): { brief: string | null; report: string | null; roomTail: Array<{ at: string; from: string; to: string[]; kind: string; text: string }> } {
  const dir = `${runDir}/children/${worker}`;
  const read = (f: string) => (existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, "utf8") : null);
  const tail = readLines(`${runDir}/room.jsonl`).map(envelopeOf).filter((e) => e && e.kind !== "notice").slice(-40)
    .map((e) => ({ at: e.at, from: e.from, to: e.to, kind: e.kind, text: String(e.text ?? "").slice(0, 400) }));
  return { brief: read("brief.md"), report: read("report.md"), roomTail: tail };
}

export function children(runDir: string): string[] { try { return readdirSync(`${runDir}/children`); } catch { return []; } }

// ── topology: who talks to whom, from the room log (messages only — notices are ambient) ────────────────────────────
export type TopoNode = { name: string; role: string; kind: "main" | "worker" | "governor" | "human"; sent: number; received: number; consults: number; talksTo?: string[] };
export type TopoEdge = { from: string; to: string; count: number; kinds: Record<string, number>; last: string };
export function topology(runDir: string): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const members = roster(runDir);
  const nodes = new Map<string, TopoNode>();
  const node = (name: string): TopoNode => {
    let n = nodes.get(name);
    if (!n) { const m = members.find((x) => x.name === name); n = { name, role: m?.role ?? name, kind: name === "main" ? "main" : name === "governor" ? "governor" : name === "human" ? "human" : "worker", sent: 0, received: 0, consults: 0, talksTo: (m as any)?.talksTo }; nodes.set(name, n); }
    return n;
  };
  for (const m of members) node(m.name);
  const edges = new Map<string, TopoEdge>();
  for (const r of readLines(`${runDir}/room.jsonl`)) {
    const e = envelopeOf(r); if (!e || e.kind === "notice" || e.from === "room") continue;
    const from = node(e.from); from.sent++;
    if (e.task === "consult" && e.kind === "request") from.consults++;
    for (const to of [...(e.to ?? []), ...(e.cc ?? [])]) {
      if (to === "*" || to === e.from) continue;
      node(to).received++;
      const key = `${e.from}→${to}`;
      const edge = edges.get(key) ?? { from: e.from, to, count: 0, kinds: {}, last: e.at };
      edge.count++; edge.kinds[e.kind] = (edge.kinds[e.kind] ?? 0) + 1; edge.last = e.at; edges.set(key, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** The tmux window of the main that owns a crew — "11 harness (pid N)" — read from its session lease (state/session-leases).
 *  Null when the main is gone: a stale lease's pane may already belong to another pi. */
export function ownerWindow(leaseDir: string, sessionId: string | null, where: (s: Spot) => string = whereLive, alive: (pid: number) => boolean = pidAlive): string | null {
  if (!sessionId) return null;
  const lease = readJson<{ pid: number; cwd: string; pane?: string }>(`${leaseDir}/${sessionId.replace(/[^\w.-]/g, "_")}.json`);
  if (!lease || typeof lease.pid !== "number" || !alive(lease.pid)) return null;
  return where({ pane: lease.pane, pid: lease.pid, cwd: lease.cwd });
}
