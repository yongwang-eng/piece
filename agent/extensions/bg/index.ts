// bg — background shell jobs that wake main when they finish.
//   bg_run({ name, command, cwd?, timeout_s?, notify? }) → returns at once { pid, log }; when the job EXITS, this session
//   gets a follow-up turn carrying the exit code and the log tail (pi.sendMessage followUp + triggerTurn).
//   bg_list · bg_tail · bg_kill · /bg. Running jobs are the `bg` section of the board below the editor (lib/agent-ui/sections.ts);
//   a job that writes /tmp/pi-bg/<name>.board.json (board-file.ts) gets its detail, a progress bar, stats, a sparkline and
//   links under its row — any bash/python drives a live section with no extension code.
// Jobs are detached (own process group): they survive pi exiting, but only a live session hears the exit.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { doneMessage, fmtDur, listText, rowFor, running, tail, TAIL_LINES, type Job } from "./format.ts";
import { clearBoardFile, readBoardFile, withBoardFile, type FileRead } from "./board-file.ts";
import { boardOf } from "../../lib/agent-ui/sections.ts";

const DIR = "/tmp/pi-bg";
const WIDGET = "bg";
const TICK_MS = 5_000;

type Live = Job & { timer?: NodeJS.Timeout; board?: FileRead };
const boardPath = (name: string) => join(DIR, `${name}.board.json`);

function killGroup(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

export default function (pi: ExtensionAPI) {
  const jobs = new Map<string, Live>();
  let ui: { ui: { setWidget: (k: string, v: unknown, o?: { placement: "belowEditor" }) => void } } | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let me: string | undefined;
  const board = boardOf(pi);
  /** <name>.job.json beside the log: the job's owner (this pi session + its Spot) and outcome, so /sessions can join it from outside this process. */
  const stamp = (j: Job) => { try { writeFileSync(join(DIR, `${j.name}.job.json`), JSON.stringify({ name: j.name, command: j.command, pid: j.pid, started: j.started, exit: j.exit ?? null, signal: j.signal ?? null, owner: me ? { session: me, pane: process.env.TMUX_PANE, pid: process.pid, cwd: process.cwd() } : undefined })); } catch { /* a projection */ } };

  const readLog = (j: Job) => (existsSync(j.log) ? readFileSync(j.log, "utf8") : "");
  const lastLine = (j: Job) => tail(readLog(j), 1);

  const paint = () => {
    if (!ui) return;
    try {
      const live = [...jobs.values()].filter(running);
      if (!live.length) { board.remove(WIDGET); return; }
      const now = Date.now();
      const rows = live.map((j) => { j.board = readBoardFile(boardPath(j.name), j.board); return withBoardFile(rowFor(j, lastLine(j), now), j.board, now); });
      board.section({ id: WIDGET, data: { title: "bg", noun: "job", hint: "bg_list", rows } });
    } catch { /* the widget is a projection; never fail a tool call over it */ }
  };
  const ensureTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => { if (![...jobs.values()].some(running)) { clearInterval(ticker); ticker = undefined; } paint(); }, TICK_MS);
    ticker.unref?.();
  };

  const finish = (job: Live, exit: number | null, signal: NodeJS.Signals | null) => {
    if (job.timer) clearTimeout(job.timer);
    job.exit = exit; job.signal = signal;
    stamp(job);
    paint();
    if (!job.notify) return;
    pi.sendMessage(
      { customType: "bg_done", display: true, content: doneMessage(job, readLog(job)), details: { name: job.name, exit, signal, log: job.log } },
      { deliverAs: "followUp", triggerTurn: true } as any,
    );
  };

  pi.on("session_start", async (_e, ctx) => { ui = ctx as any; me = ctx.sessionManager.getSessionId() || undefined; paint(); });
  // /reload builds a new instance; this one's ticker must die with it (the jobs themselves are detached and live on).
  pi.on("session_shutdown", async () => { ui = undefined; if (ticker) { clearInterval(ticker); ticker = undefined; } });

  pi.registerTool({
    name: "bg_run",
    label: "Background job",
    description:
      "Run a shell command in the BACKGROUND and return immediately. When it exits, this session gets a follow-up turn with " +
      "the exit code and the last lines of its log — so never `sleep` in a turn waiting on CI, Aviator, a deploy, a build or a " +
      "test run; hand the wait to bg_run. Write the command so it EXITS when its condition is met (a polling loop with a cap). " +
      "Output goes to /tmp/pi-bg/<name>.log (readable any time). notify=false for fire-and-forget.",
    parameters: Type.Object({
      name: Type.String({ description: "short snake_case id, unique among running jobs" }),
      command: Type.String({ description: "bash command; runs via `bash -c` with pi's own env (same PATH and leases as the bash tool)" }),
      cwd: Type.Optional(Type.String()),
      timeout_s: Type.Optional(Type.Number({ description: "kill the job and notify if it runs longer than this" })),
      notify: Type.Optional(Type.Boolean({ description: "default true: wake main when the job exits" })),
    }),
    async execute(_id, p) {
      const prev = jobs.get(p.name);
      if (prev && running(prev)) return { content: [{ type: "text", text: `bg job "${p.name}" is already running (pid ${prev.pid}); pick another name or bg_kill it` }], details: {}, isError: true };
      mkdirSync(DIR, { recursive: true });
      const log = join(DIR, `${p.name}.log`);
      clearBoardFile(boardPath(p.name));
      const fd = openSync(log, "w");
      // `-c`, not `-lc`: a login shell re-sources the profile and puts /usr/bin ahead of mise/homebrew, so `python3` silently
      // becomes the 3.9 system binary. Inheriting pi's env gives a bg child exactly what the bash tool sees (incl. secret leases).
      const child = spawn("bash", ["-c", p.command], { cwd: p.cwd, detached: true, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      child.unref();
      const job: Live = { name: p.name, command: p.command, pid: child.pid ?? -1, log, started: Date.now(), notify: p.notify ?? true };
      jobs.set(p.name, job);
      stamp(job);
      child.on("exit", (code, signal) => finish(job, code, signal));
      child.on("error", (err) => { appendFileSync(log, `\n[bg] spawn error: ${err.message}\n`); finish(job, null, null); });
      if (p.timeout_s) job.timer = setTimeout(() => { job.timedOut = true; killGroup(job.pid); }, p.timeout_s * 1000);
      paint(); ensureTicker();
      return { content: [{ type: "text", text: `started bg "${p.name}" pid ${job.pid} → ${log}${job.notify ? " (main gets a follow-up turn on exit)" : " (quiet)"}` }], details: { name: p.name, pid: job.pid, log } };
    },
  });

  pi.registerTool({
    name: "bg_list", label: "Background jobs", description: "List this session's background jobs (running and finished) with pid, state and log path.",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: listText(jobs.values()) }], details: {} }; },
  });

  pi.registerTool({
    name: "bg_tail", label: "Background job log", description: "Last N lines of a background job's log (default 20).",
    parameters: Type.Object({ name: Type.String(), lines: Type.Optional(Type.Number()) }),
    async execute(_id, p) {
      const job = jobs.get(p.name);
      if (!job) return { content: [{ type: "text", text: `no bg job "${p.name}"` }], details: {}, isError: true };
      const state = running(job) ? `running ${fmtDur(Date.now() - job.started)}` : `exit ${job.exit ?? job.signal}`;
      return { content: [{ type: "text", text: `[bg ${job.name}] ${state} · ${job.log}\n${tail(readLog(job), p.lines ?? TAIL_LINES) || "(no output yet)"}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "bg_kill", label: "Kill background job", description: "Stop a running background job (SIGTERM to its process group). Notifies like a normal exit.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, p) {
      const job = jobs.get(p.name);
      if (!job || !running(job)) return { content: [{ type: "text", text: `no running bg job "${p.name}"` }], details: {}, isError: true };
      killGroup(job.pid);
      return { content: [{ type: "text", text: `sent SIGTERM to bg "${p.name}" (pid ${job.pid})` }], details: {} };
    },
  });

  pi.registerCommand("bg", {
    description: "List background jobs",
    handler: async (_args, ctx) => ctx.ui.notify(listText(jobs.values()), "info"),
  });
}
