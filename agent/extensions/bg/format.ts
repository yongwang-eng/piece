// Pure formatting for the bg extension — no pi imports, so `node --test` can load it.
import { boardLines, type Row } from "../../lib/agent-ui/board.ts";
export type Job = {
  name: string; command: string; pid: number; log: string; started: number; notify: boolean;
  exit?: number | null; signal?: string | null; timedOut?: boolean;
};

export const TAIL_LINES = 20;

export const running = (j: Job) => j.exit === undefined && !j.signal;

export function tail(text: string, n = TAIL_LINES): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function stateOf(j: Job, now: number): string {
  if (running(j)) return `running ${fmtDur(now - j.started)}`;
  if (j.timedOut) return "timed out";
  if (j.signal) return `killed ${j.signal}`;
  return `exit ${j.exit}`;
}

export function doneMessage(job: Job, logText: string, now = Date.now()): string {
  const dur = fmtDur(now - job.started);
  const how = job.timedOut ? `timed out after ${dur}` : job.signal ? `killed (${job.signal}) after ${dur}` : `exit ${job.exit} · ${dur}`;
  return `[bg ${job.name}] ${how} · ${job.log}\n\`\`\`\n${tail(logText) || "(no output)"}\n\`\`\``;
}

export function listText(jobs: Iterable<Job>, now = Date.now()): string {
  const rows = [...jobs].map((j) => `${j.name.padEnd(18)} ${String(j.pid).padEnd(7)} ${stateOf(j, now).padEnd(16)} ${j.log}`);
  return rows.length ? `${"name".padEnd(18)} ${"pid".padEnd(7)} ${"state".padEnd(16)} log\n${rows.join("\n")}` : "no bg jobs this session";
}

/** A job in the board grammar: running is live, exit 0 is done, anything else is alert. The log file is the link. */
export function rowFor(j: Job, lastLine: string, now = Date.now()): Row {
  const state = running(j) ? "working" : j.exit === 0 ? "done" : "gone";
  const detail = running(j) ? lastLine.trim() || "running" : stateOf(j, now);
  return { name: j.name, pane: "bg", state, detail, ageMs: now - j.started, url: `file://${j.log}` };
}

/** Header + one row per RUNNING job, plain. Empty when nothing runs → widget clears. */
export function widgetLines(jobs: Iterable<Job>, lastLine: (j: Job) => string, width: number, now = Date.now()): string[] {
  return boardLines(runningRows(jobs, lastLine, now), width, 4, "bg", { noun: "job", hint: "bg_list" });
}

export const runningRows = (jobs: Iterable<Job>, lastLine: (j: Job) => string, now = Date.now()): Row[] =>
  [...jobs].filter(running).map((j) => rowFor(j, lastLine(j), now));
