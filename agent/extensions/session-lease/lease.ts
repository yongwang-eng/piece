/**
 * Session leases — the LIST that says which pi process holds a session JSONL. pi itself has no lock: `pi -c` in a
 * directory picks the most recent session, so two mains started from one cwd append to the same file and interleave.
 * Pure file logic here; the extension decides what to do with the verdict.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Lease { pid: number; file: string; cwd: string; at: string; pane?: string }
export type Verdict = "free" | "mine" | "stale" | "occupied";

export const leasePath = (dir: string, sessionId: string) => join(dir, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);

export function readLease(dir: string, sessionId: string): Lease | undefined | null {   // null = present but unreadable
  try { return JSON.parse(readFileSync(leasePath(dir, sessionId), "utf8")) as Lease; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
}

export function verdict(lease: Pick<Lease, "pid"> | undefined | null, myPid: number, isAlive: (pid: number) => boolean): Verdict {
  if (lease === undefined) return "free";
  if (!lease || typeof lease.pid !== "number") return "stale";
  if (lease.pid === myPid) return "mine";
  return isAlive(lease.pid) ? "occupied" : "stale";
}

/** EPERM means the process exists but is not ours — still alive. */
export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Take the lease unless a LIVE other process holds it. A dead holder is healed silently (D74: heal before you report). */
export function claim(o: { dir: string; sessionId: string; file: string; pid: number; cwd: string; pane?: string; isAlive?: (pid: number) => boolean }): { verdict: Verdict; holder?: Lease } {
  mkdirSync(o.dir, { recursive: true });
  const current = readLease(o.dir, o.sessionId);
  const v = verdict(current, o.pid, o.isAlive ?? pidAlive);
  if (v === "occupied") return { verdict: v, holder: current as Lease };
  writeFileSync(leasePath(o.dir, o.sessionId), JSON.stringify({ pid: o.pid, file: o.file, cwd: o.cwd, at: new Date().toISOString(), ...(o.pane ? { pane: o.pane } : {}) } satisfies Lease));
  return { verdict: v };
}

export function release(o: { dir: string; sessionId: string; pid: number }): void {
  const current = readLease(o.dir, o.sessionId);
  if (current && current.pid !== o.pid) return;   // not mine to remove
  try { rmSync(leasePath(o.dir, o.sessionId), { force: true }); } catch { /* best effort */ }
}
