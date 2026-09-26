// awake — keep the Mac awake via caffeinate. Ported from the Claude Code /awake skill:
// pure system control, zero judgment → command, not skill (entry-point rule, pilab lecture 3).
// /awake [4h|30m|2h30m|90m|N]  start; default 8h; replaces any running caffeinate
// /awake status | ls           running? elapsed + time left (parsed from ps: -t arg vs etime)
// /awake off                   stop it
import { execSync, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function parseSeconds(arg: string): number | null {
  const s = arg.trim().toLowerCase();
  if (!s) return 8 * 3600;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 3600); // bare number = hours
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return (parseInt(m[1] ?? "0", 10) * 60 + parseInt(m[2] ?? "0", 10)) * 60;
}

// ps etime format: [[dd-]hh:]mm:ss
function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, dd, hh, mm, ss] = m;
  return (parseInt(dd ?? "0", 10) * 24 + parseInt(hh ?? "0", 10)) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
}

function fmtDur(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const mins = Math.round(secs / 60); // round once, then split — avoids "7h 60m"
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

type CaffeinateProc = { pid: number; elapsed: number; total: number | null };

function caffeinateProcs(): CaffeinateProc[] {
  let pids: number[];
  try {
    pids = execSync("pgrep -x caffeinate", { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((p) => parseInt(p, 10))
      .filter((p) => Number.isFinite(p));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
  const procs: CaffeinateProc[] = [];
  for (const pid of pids) {
    try {
      const out = execSync(`ps -o etime=,args= -p ${pid}`, { encoding: "utf8" }).trim();
      const [etime, ...rest] = out.split(/\s+/);
      const args = rest.join(" ");
      const t = args.match(/-t\s+(\d+)/);
      procs.push({ pid, elapsed: parseEtime(etime), total: t ? parseInt(t[1], 10) : null });
    } catch {
      // process exited between pgrep and ps — skip
    }
  }
  return procs;
}

function stopCaffeinate(): void {
  try {
    execSync("pkill caffeinate");
  } catch {
    // not running — fine
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("awake", {
    description: "Keep the Mac awake (caffeinate). /awake [8h|30m|2h30m] · ls · off",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "status" || arg === "ls") {
        const procs = caffeinateProcs();
        if (procs.length === 0) {
          ctx.ui.notify("awake: OFF — Mac sleeps normally", "info");
          return;
        }
        const lines = procs.map((p) => {
          const left =
            p.total === null
              ? "no time limit"
              : `${fmtDur(Math.max(0, p.total - p.elapsed))} left (of ${fmtDur(p.total)})`;
          return `  pid ${p.pid} — up ${fmtDur(p.elapsed)} — ${left}`;
        });
        ctx.ui.notify(`awake: ON\n${lines.join("\n")}`, "info");
        return;
      }

      if (arg === "off") {
        stopCaffeinate();
        ctx.ui.notify("caffeinate stopped — Mac sleeps normally.", "info");
        return;
      }

      const secs = parseSeconds(arg);
      if (secs === null) {
        ctx.ui.notify(`Can't parse "${args}" — try 4h, 30m, 2h30m, or a bare number of hours.`, "info");
        return;
      }

      stopCaffeinate(); // one caffeinate at a time; new duration replaces old
      const child = spawn("caffeinate", ["-dims", "-t", String(secs)], { detached: true, stdio: "ignore" });
      child.unref();
      const hours = secs / 3600;
      const label = Number.isInteger(hours) ? `${hours}h` : `${(secs / 60).toFixed(0)}m`;
      ctx.ui.notify(`Mac stays awake for ${label} (caffeinate -dims, pid ${child.pid}). /awake off to cancel.`, "info");
    },
  });
}
