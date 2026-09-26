import { readFileSync, statSync } from "node:fs";

export interface PeerCounts {
  sent: number;
  addressed: number;
  onePeer: number;
  multiPeer: number;
  broadcasts: number;
  distinctPeers: number;
  replies: number;
}
export interface CommunicationSnapshot {
  status: "complete" | "partial" | "unknown";
  malformed: number;
  joins: Map<string, number>;
  workers: Map<string, PeerCounts>;
}
export interface WorkerCommunication {
  status: CommunicationSnapshot["status"];
  counts?: PeerCounts;
  reason?: string;
}
const housekeeping = new Set(["presence", "vitals", "turn_end", "consult", "progress"]);
const kinds = new Set(["request", "query", "inform", "result", "error", "propose", "accept", "refuse", "notice"]);
const reserved = new Set(["main", "governor", "room"]);
const emptyCounts = (): PeerCounts => ({ sent: 0, addressed: 0, onePeer: 0, multiPeer: 0, broadcasts: 0, distinctPeers: 0, replies: 0 });

export function replayCommunication(text: string, run: string): CommunicationSnapshot {
  const workers = new Map<string, PeerCounts>();
  const joins = new Map<string, number>();
  const peers = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const directed = new Map<string, { from: string; targets: Set<string> }>();
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { malformed++; continue; }
    if (!e || typeof e !== "object") { malformed++; continue; }
    if (typeof e.run !== "string" || !["event", "message"].includes(e.type)) { malformed++; continue; }
    if (e.run !== run) continue;
    if (e.type === "event") {
      if (e.kind === "member_joined" && ["crew", "fleet"].includes(e.details?.backend) && typeof e.member === "string" && !reserved.has(e.member)) {
        joins.set(e.member, (joins.get(e.member) ?? 0) + 1);
        if (workers.has(e.member)) continue;
        workers.set(e.member, emptyCounts()); peers.set(e.member, new Set());
      }
      continue;
    }
    if (e.type !== "message") continue;
    if (!kinds.has(e.kind) || typeof e.id !== "string" || !e.id || typeof e.from !== "string" || !Array.isArray(e.to) || !e.to.every((n: unknown) => typeof n === "string") || (e.cc !== undefined && (!Array.isArray(e.cc) || !e.cc.every((n: unknown) => typeof n === "string")))) { malformed++; continue; }
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const counts = workers.get(e.from);
    if (housekeeping.has(e.task) || reserved.has(e.from)) continue;
    if (!counts) { malformed++; continue; }
    const addresses = new Set<string>([...e.to, ...(e.cc ?? [])]);
    if (addresses.has("*")) {
      if (e.kind !== "notice") { malformed++; continue; }
      counts.broadcasts++; continue;
    }
    const targets = new Set([...addresses].filter(n => n !== e.from && workers.has(n)));
    if (!targets.size) continue;
    counts.sent++;
    if (targets.size === 1) counts.onePeer++; else counts.multiPeer++;
    for (const target of targets) {
      workers.get(target)!.addressed++;
      peers.get(e.from)!.add(target);
    }
    counts.distinctPeers = peers.get(e.from)!.size;
    const original = directed.get(e.re);
    if (original && targets.has(original.from) && original.targets.has(e.from)) counts.replies++;
    directed.set(e.id, { from: e.from, targets });
  }
  return { status: malformed ? "partial" : "complete", malformed, workers, joins };
}
export function workerStats(snapshot: CommunicationSnapshot, worker: string): WorkerCommunication {
  const counts = snapshot.workers.get(worker);
  const joined = snapshot.joins.get(worker) ?? 0;
  if (counts && joined > 1) return { status: "partial", counts, reason: `${joined} join records for this name; counts may span lifetimes` };
  return counts ? { status: snapshot.status, counts, ...(snapshot.malformed ? { reason: `${snapshot.malformed} malformed record(s)` } : {}) } : { status: "unknown", reason: "worker membership not established" };
}

const cache = new Map<string, { stamp: string; snapshot: CommunicationSnapshot }>();
export function communicationFor(path: string, run: string, worker: string): WorkerCommunication {
  try {
    const stat = statSync(path);
    const key = `${run}\0${path}`;
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let entry = cache.get(key);
    if (!entry || entry.stamp !== stamp) {
      entry = { stamp, snapshot: replayCommunication(readFileSync(path, "utf8"), run) };
      cache.set(key, entry);
    }
    return workerStats(entry.snapshot, worker);
  } catch { return { status: "unknown", reason: "room log unreadable" }; }
}
export function communicationText(entries: Array<{ name: string; run: string; id?: number; communication: WorkerCommunication }>): string {
  if (!entries.length) return "No crew workers.";
  return ["Crew communication — logged addressing, not delivery/read receipts.", "Broadcasts are separate from directed peer totals; peers counts explicit outbound destinations.", "", ...entries.flatMap(e => {
    const c = e.communication.counts;
    return [`#${e.id ?? "?"} ${e.name} · ${e.run}`, ...(c ? [
      `  Peer out ${c.sent} · addressed in ${c.addressed} · peers ${c.distinctPeers}`,
      `  One-peer ${c.onePeer} · multi-peer ${c.multiPeer} · broadcasts ${c.broadcasts} · replies ${c.replies}`,
    ] : []), ...(e.communication.status !== "complete" ? [`  ${e.communication.status}: ${e.communication.reason ?? "incomplete record"}`] : []), ""];
  })].join("\n").trimEnd();
}
