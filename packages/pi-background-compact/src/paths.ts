/**
 * Agent-dir resolution without a hard load-time dependency on pi's exports: tests run `node --test`
 * with no peer deps installed, and older pi versions may not export getAgentDir. Start with the
 * conventional default; upgrade to pi's answer (rebranded distros) when the extension boots.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

let agentDir = join(homedir(), ".pi", "agent");

export const agentDirNow = (): string => agentDir;

let ensuredDir = "";

/** A fresh install has no `state/`, and appendFileSync into a missing directory throws ENOENT that
 *  every caller swallows — so the log documented as the always-on record would silently not exist.
 *  Re-checked when the dir changes because upgradeAgentDir can move it after load. Still non-fatal:
 *  unwritable storage must never block a compaction. */
export function statePath(file: string): string {
  const dir = join(agentDir, "state");
  if (ensuredDir !== dir) {
    try { mkdirSync(dir, { recursive: true }); ensuredDir = dir; } catch { /* non-fatal; the append will no-op */ }
  }
  return join(dir, file);
}

export async function upgradeAgentDir(): Promise<void> {
  try {
    const m: any = await import("@earendil-works/pi-coding-agent");
    if (typeof m.getAgentDir === "function") agentDir = m.getAgentDir();
  } catch { /* keep the conventional default */ }
}
