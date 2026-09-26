/** Where /borrow may borrow from (live pi processes in tmux panes) and how its arguments read. Pure enough to test. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { peek } from "../../lib/sessions/reader.ts";
import { paneForPid } from "../../lib/where.ts";

const LIVE_DIR = `${homedir()}/.pi/agent/state/live`;
/** 10 rounds or 10k tokens, whichever comes first: measured 2026-09-17, a round is ~400 tok median, so 10 rounds is ~4k and
 *  the cap bites only on design-heavy turns. Whole rounds fall off the front, never a partial one. */
export const DEFAULT_ROUNDS = 10, MAX_TOKENS = 10_000;

export type Source = { pid: number; window: string; cwd: string; file: string; lastUser: string; lastAt: string };

const run = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const parentOf = (pid: number) => { const n = Number(run("ps", ["-o", "ppid=", "-p", String(pid)])); return Number.isFinite(n) && n > 0 ? n : undefined; };

/** Live sources = breadcrumbs (pid → session file) whose pid sits in a tmux pane. No pane, not offered. */
export function liveSources(mePid = process.pid): Source[] {
  if (!existsSync(LIVE_DIR)) return [];
  const panes = run("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{session_name}:#{window_index} #{window_name}"]).split("\n").filter(Boolean)
    .map((l) => { const [pane, pid, idx, ...name] = l.split(" "); return { pane, pid: Number(pid), label: `${idx.split(":")[1]} ${name.join(" ")}` }; });
  const labelOf = new Map(panes.map((p) => [p.pane, p.label]));
  const out: Source[] = [];
  for (const ent of readdirSync(LIVE_DIR)) {
    const pid = Number(ent); if (!pid || pid === mePid) continue;
    const pane = paneForPid(pid, panes, parentOf); if (!pane) continue;
    const file = readFileSync(`${LIVE_DIR}/${ent}`, "utf8").trim(); if (!file || !existsSync(file)) continue;
    const cwd = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "";
    let p = { lastUser: "", lastAt: "" }; try { p = peek(file); } catch { /* unreadable → still listed */ }
    out.push({ pid, window: labelOf.get(pane) ?? pane, cwd, file, ...p });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** `/borrow [<window|cwd fuzzy>] [N | <M>m] [about "<re>"] [-- question]` */
export function parseArgs(raw: string): { pick?: string; n: number; since?: string; about?: RegExp; question?: string } {
  let s = raw.trim(), question: string | undefined;
  const q = s.indexOf("--"); if (q >= 0) { question = s.slice(q + 2).trim() || undefined; s = s.slice(0, q).trim(); }
  let about: RegExp | undefined; s = s.replace(/about\s+"([^"]+)"|about\s+(\S+)/, (_m, a, b) => { about = new RegExp(a ?? b, "i"); return ""; }).trim();
  let n = DEFAULT_ROUNDS, since: string | undefined;
  s = s.replace(/\b(\d+)m\b/, (_m, mins) => { since = new Date(Date.now() - Number(mins) * 60_000).toISOString(); n = 999; return ""; }).trim();
  s = s.replace(/\b(\d+)\b/, (_m, k) => { n = Number(k); return ""; }).trim();
  return { pick: s || undefined, n, since, about, question };
}
