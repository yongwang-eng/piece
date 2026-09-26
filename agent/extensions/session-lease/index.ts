/**
 * session-lease — one pi process per session JSONL. `pi -c` / `--session` / `/resume` can open a file another live pi
 * already writes to (pi has no lock); two writers interleave the ledger. This holds a lease per session id under
 * state/session-leases/ and, on a conflict, clones the session AT the leaf so this process gets its own file with the
 * same context — the occupant is never touched. Workers never load this (they get fresh sessions via --session-dir).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { claim, release } from "./lease.ts";
import { problems } from "../../lib/agent-ui/problems.ts";
import { where } from "../../lib/where.ts";

const AGENT_DIR = `${homedir()}/.pi/agent`;
const DIR = `${AGENT_DIR}/state/session-leases`;
const CMD = "session-lease-clone";

export default function sessionLease(pi: ExtensionAPI) {
  if (process.env.PI_CREW_ROLE === "worker") return;
  const problem = problems(pi, `${AGENT_DIR}/state/problems.log`);
  let leased: string | undefined;          // session id this process holds
  let conflict: { id: string; holderPid: number; holder: string; leaf: string } | undefined;

  pi.on("session_start", (_e, ctx) => {
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile(); const id = sm.getSessionId();
    if (!file || !id) return;                                  // ephemeral: nothing on disk to share
    const r = claim({ dir: DIR, sessionId: id, file, pid: process.pid, cwd: process.cwd(), pane: process.env.TMUX_PANE });
    if (r.verdict !== "occupied") { leased = id; return; }
    const leaf = sm.getLeafId();
    const holder = where({ pane: r.holder!.pane, pid: r.holder!.pid, cwd: r.holder!.cwd });     // "11 harness (pid 34668)", never a bare pid
    if (!leaf) { problem.report("session-lease:empty", `this session is already open in ${holder} and has no entries to clone — quit this pi`); return; }
    conflict = { id, holderPid: r.holder!.pid, holder, leaf };
    if (ctx.hasUI) ctx.ui.notify(`this session is already open in ${holder} — cloning so nothing interleaves…`, "warning");
    // fork() lives on a command ctx only; the idle probe below submits the command once startup settles (same seam as /reload).
    let tries = 0;
    const attempt = () => {
      if (!conflict) return;
      try { pi.sendUserMessage(`/${CMD}`, { expandPromptTemplates: true } as any); }
      catch { if (++tries < 100) setTimeout(attempt, 200); else problem.report("session-lease:clone", `could not clone this session away from ${holder} — type /fork before sending anything`); }
    };
    setTimeout(attempt, 200);
  });

  pi.registerCommand(CMD, {
    description: "Clone this session at its leaf because another live pi holds its file (session-lease does this for you).",
    handler: async (_a, ctx) => {
      const c = conflict; conflict = undefined;
      if (!c) { ctx.ui.notify("no session conflict to resolve", "info"); return; }
      const res = await ctx.fork(c.leaf, { position: "at", withSession: async (next) => {
        next.ui.notify(`you are in a clone — the original session stays in ${c.holder}`, "info");
      } });
      if (res.cancelled) problem.report("session-lease:clone", `clone was cancelled — this pi still shares a session file with ${c.holder}; type /fork`);
    },
  });

  pi.on("session_shutdown", () => { if (leased) { release({ dir: DIR, sessionId: leased, pid: process.pid }); leased = undefined; } });
}
