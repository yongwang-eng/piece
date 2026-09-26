/** Worker progress — the milestone a worker REPORTS, kept apart from the activity the harness OBSERVES.
 *  A worker calls `progress` once per meaningful step (never a heartbeat); main keeps the latest per worker for the
 *  board row and can wake on a shared finding. Progress never grants authority, never replaces the final report, and
 *  never counts as verified completion: it is what the worker says, timestamped and attributed by the harness. */

export const PROGRESS_TASK = "progress";
/** A worker's shared findings reach main at most this often; the rest wait for the next flush. */
export const SHARE_MIN_MS = 60_000;
/** Bursts across workers land as ONE message. */
export const SHARE_DEBOUNCE_MS = 2_000;

export interface Milestone {
  phase: string;
  finding?: string;
  next?: string;
  evidence?: string[];
  /** collaborative mode: the worker asks main to hear this finding now, not at the next glance */
  share?: boolean;
  /** set by the harness from the room log, never trusted from the worker */
  at: string;
}
export type WorkerMilestone = Milestone & { worker: string };

const cut = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

/** The wire text of a progress notice → a bounded milestone, or undefined when it is not one. `phase` is the only required field. */
export function parseMilestone(text: string): Milestone | undefined {
  let p: any; try { p = JSON.parse(text); } catch { return undefined; }
  const phase = cut(p?.phase, 80); if (!phase) return undefined;
  const m: Milestone = { phase, at: typeof p.at === "string" ? p.at : "" };
  const finding = cut(p.finding, 300); if (finding) m.finding = finding;
  const next = cut(p.next, 120); if (next) m.next = next;
  if (Array.isArray(p.evidence)) { const ev = p.evidence.filter((e: unknown) => typeof e === "string" && e).map((e: string) => e.slice(0, 200)).slice(0, 8); if (ev.length) m.evidence = ev; }
  m.share = p.share === true;
  return m;
}

/** Row detail: what the worker says it is doing, then what the harness sees it doing. */
export function milestoneDetail(m: Pick<Milestone, "phase">, observed: string): string {
  return observed && observed !== m.phase ? `${m.phase} · ${observed}` : m.phase;
}

/** Every milestone in a run log (room.jsonl lines, flattened envelopes), oldest first; optionally one worker. */
export function progressTrail(lines: Array<Record<string, any>>, worker?: string): WorkerMilestone[] {
  const out: WorkerMilestone[] = [];
  for (const l of lines) {
    if (l.type !== "message" || l.kind !== "notice" || l.task !== PROGRESS_TASK || typeof l.from !== "string") continue;
    if (worker && l.from !== worker) continue;
    const m = parseMilestone(String(l.text ?? "")); if (!m) continue;
    out.push({ ...m, at: typeof l.at === "string" ? l.at : m.at, worker: l.from });
  }
  return out;
}

/** The one follow-up main reads for a burst of shared findings: latest per worker, plainly marked as FYI. */
export function coalesceFindings(pending: Map<string, WorkerMilestone>): string {
  const items = [...pending.values()].sort((a, b) => a.at.localeCompare(b.at));
  const body = items.map((m) => [
    `${m.worker} · ${m.phase}`,
    m.finding ? `  found: ${m.finding}` : undefined,
    m.evidence?.length ? `  evidence: ${m.evidence.join(" · ")}` : undefined,
    m.next ? `  next: ${m.next}` : undefined,
  ].filter(Boolean).join("\n")).join("\n");
  return `[crew progress · ${items.length} finding${items.length === 1 ? "" : "s"}]\n${body}\n\nFYI from workers in collaborative mode — not a request, no reply is owed. Steer only if a finding changes the plan.`;
}
