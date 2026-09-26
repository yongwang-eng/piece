/**
 * Usage recorder — attributes every model call and compaction of THIS pi process to its agent row.
 *
 * Identity rule: take the badge if your creator minted one, otherwise sign yourself in.
 *   worker   → PI_CREW_ID (main registered agent_N before spawn)
 *   main / any plain session → ensureMain + owner lease via the shared registry
 * After the binding, every role records through the same capture and the same store.
 * Telemetry is subordinate: a failed open or write logs and drops the frame, never blocks a turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installUsageCapture, installCompactionCapture, installDroppedCompactionCapture, installAppliedCompactionCapture } from "./capture.ts";
import { openCrewStore, agentDbPath, type AgentId } from "../database/store.ts";
import { sharedRegistry } from "../database/registry.ts";
import { problems } from "../agent-ui/problems.ts";

let installed = false;

export function installUsageRecorder(pi: ExtensionAPI, agentDir: string): void {
  if (installed) return;   // one recorder per process, wherever it's called from
  installed = true;
  const report = problems(pi, `${agentDir}/state/problems.log`);
  const failed = (what: string) => (e: unknown) =>
    report.report(`usage.${what}`, `usage: ${what} failed`, { error: e, hint: "this call's usage row was dropped; if it repeats, /reload rebinds the ledger" });

  const workerId = process.env.PI_CREW_ROLE === "worker" ? Number(process.env.PI_CREW_ID) || undefined : undefined;
  if (workerId !== undefined) {
    let store: ReturnType<typeof openCrewStore> | null | undefined;
    const db = () => {
      if (store === undefined) {
        try { store = openCrewStore(agentDbPath(agentDir)); }
        catch (e) { store = null; failed("store open")(e); }
      }
      return store;
    };
    installUsageCapture(pi, f => { db()?.recordWorkerUsage(`agent_${workerId}` as AgentId, f); }, failed("worker capture"));
    installCompactionCapture(pi, f => { db()?.recordWorkerCompaction(`agent_${workerId}` as AgentId, f); }, failed("worker compaction"));
    installDroppedCompactionCapture(pi, f => { db()?.recordWorkerCompaction(`agent_${workerId}` as AgentId, f); }, failed("worker dropped compaction"));
    installAppliedCompactionCapture(pi, e => db()?.enrichWorkerCompaction(`agent_${workerId}` as AgentId, e) ?? false, failed("worker applied compaction"));
    return;
  }

  const registry = sharedRegistry(pi, agentDbPath(agentDir));
  // Every frame carries its session, so the binding can heal itself if session_start was
  // missed or arrived out of order (notably across /reload).
  installUsageCapture(pi, f => registry.use(f.sessionId, ({ store, owner }) => store.recordUsage(owner, owner.agentId, null, f)), failed("capture"));
  installCompactionCapture(pi, f => registry.use(f.sessionId, ({ store, owner }) => store.recordCompaction(owner, f)), failed("compaction"));
  installDroppedCompactionCapture(pi, f => registry.use(f.sessionId, ({ store, owner }) => store.recordCompaction(owner, f)), failed("dropped compaction"));
  installAppliedCompactionCapture(pi, e => registry.use(e.sessionId, ({ store, owner }) => store.enrichCompaction(owner, e)), failed("applied compaction"));
}
