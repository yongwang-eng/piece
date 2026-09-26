import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest mtime (ms) of any .ts under `dir`, recursively. 0 when the dir is unreadable. */
export function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".ts") && st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

/**
 * True when source on disk is newer than what this process loaded. Extensions load once at session start, so a fix
 * committed mid-session is NOT running — main debugged an already-fixed race for an hour without this cue (2026-09-11).
 */
export function isStale(loadedMtime: number, dir: string): boolean {
  return newestSourceMtime(dir) > loadedMtime;
}

export const STALE_HINT = "⚠ crew extension is newer on disk than what is loaded — /reload to run it";
