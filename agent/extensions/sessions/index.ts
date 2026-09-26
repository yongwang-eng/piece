/**
 * sessions — the session observer. "What are my pi sessions doing?" answered from what the producers already wrote:
 * leases (session ↔ pane/pid/cwd), pane dots (turn state), sqlite crews (owner), the Devin registry (owner), bg stamps
 * (owner). Read-only; nothing is read through a live process. `/sessions` renders the board grammar; the `sessions`
 * tool gives main the same rows as text. Claude Code panes are not pi sessions and do not appear.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { boardLines, styledRow, type Palette, type Row } from "../../lib/agent-ui/board.ts";
import { pidAlive, type Lease } from "../session-lease/lease.ts";
import { readPanes } from "../../lib/tmux-dot/tmux.ts";
import { where } from "../../lib/where.ts";
import { peek } from "../../lib/sessions/reader.ts";
import { observe, rowFor, sortRows, type BgIn, type CrewIn, type DevinIn, type LeaseIn } from "../../lib/sessions/observe.ts";
import { ENDED } from "../devin/state.ts";

const AGENT = `${homedir()}/.pi/agent`;
const LEASES = `${AGENT}/state/session-leases`;
const DB = `${AGENT}/state/agent.sqlite`;
const BG = "/tmp/pi-bg";

function leases(): LeaseIn[] {
  if (!existsSync(LEASES)) return [];
  return readdirSync(LEASES).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try { const l = JSON.parse(readFileSync(join(LEASES, f), "utf8")) as Lease; return [{ sessionId: f.slice(0, -5), pid: l.pid, file: l.file, cwd: l.cwd, pane: l.pane, alive: pidAlive(l.pid) }]; }
    catch { return []; }
  });
}
function crews(): CrewIn[] {
  if (!existsSync(DB)) return [];
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    try {
      return db.prepare("select a.session_id as owner, c.slug as slug from crews c join agents a on a.id = c.owner_id where c.closed_at is null").all()
        .map((r: any) => ({ ownerSession: r.owner, slug: r.slug }));
    } finally { db.close(); }
  } catch { return []; }
}
/** D97: Devin rows live in agent.sqlite; a paused row is still live (it is on its owner's board) until ended or signed off. */
function devin(): DevinIn[] {
  if (!existsSync(DB)) return [];
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    try {
      return db.prepare("select owner_session, slug, title, watch, last, question, signed_off_at from devin_sessions").all().map((r: any) => {
        let status = ""; try { status = JSON.parse(r.last ?? "null")?.status ?? ""; } catch { /* unreadable snapshot reads as live */ }
        return { ownerSession: r.owner_session ?? undefined, slug: r.slug ?? r.title ?? "devin", live: r.watch === 1 && !r.signed_off_at && !ENDED.has(status), asking: !!r.question };
      });
    } finally { db.close(); }
  } catch { return []; }
}
function bg(): BgIn[] {
  if (!existsSync(BG)) return [];
  return readdirSync(BG).filter((f) => f.endsWith(".job.json")).flatMap((f) => {
    try { const j = JSON.parse(readFileSync(join(BG, f), "utf8")); return [{ ownerSession: j.owner?.session, name: j.name, running: j.exit === null && !j.signal && pidAlive(j.pid) }]; }
    catch { return []; }
  });
}
const safePeek = (file: string) => { try { return peek(file); } catch { return undefined; } };

export default function (pi: ExtensionAPI) {
  if (process.env.PI_CREW_ROLE === "worker") return;
  let me: string | undefined;
  pi.on("session_start", (_e, ctx) => { me = ctx.sessionManager.getSessionId() || undefined; });

  const rows = async (): Promise<Row[]> => {
    const panes = await readPanes().catch(() => []);
    const now = Date.now();
    const views = observe({ leases: leases(), panes, crews: crews(), devin: devin(), bg: bg(), label: (s) => where(s), peek: safePeek });
    return sortRows(views.map((v) => rowFor(v, now, me)));
  };

  pi.registerCommand("sessions", {
    description: "Every live pi session: where it runs, what it is doing, what it owns (crews · devin · bg)",
    handler: async (_args, ctx) => {
      const r = await rows();
      if (!r.length) { ctx.ui.notify("no live pi sessions hold a lease", "info"); return; }
      pi.appendEntry("sessions_list", { rows: r });   // TUI-only, durable; never model context
    },
  });
  pi.registerEntryRenderer("sessions_list", (entry, _o, theme) => {
    const data = entry.data as { rows: Row[] };
    const pal: Palette = { fg: (t, x) => theme.fg(t, x), bold: (x) => theme.bold(x), link: getCapabilities().hyperlinks ? hyperlink : undefined };
    const width = Math.max(40, (process.stdout.columns ?? 120) - 4);
    return new Text(data.rows.map((r) => styledRow(r, width, pal)).join("\n"), 0, 0);
  });

  pi.registerTool({
    name: "sessions", label: "Live pi sessions",
    description: "Read-only: every live pi session on this machine — its tmux window, turn state (working · waiting on you · finished unseen · idle), what it owns (crews, Devin watches, bg jobs), last prompt, transcript path. Joined from leases, pane dots, sqlite and registries; never reads a live process.",
    parameters: Type.Object({}),
    async execute() {
      const r = await rows();
      return { content: [{ type: "text", text: r.length ? boardLines(r, 160, r.length).join("\n") : "no live pi sessions hold a lease" }], details: {} };
    },
  });
}
