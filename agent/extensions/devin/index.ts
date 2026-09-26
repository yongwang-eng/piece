// devin — a Devin session is a worker whose pane is a URL.
//   Watched sessions get a board row (same row vocabulary as crew), one REST poll every 30 s, and main gets a follow-up
//   turn ONLY on an event: Devin stopped to ask (the question text rides along) · a PR appeared (arrival checklist as
//   code, then pr_watch takes the PR) · the session ended — except idling out (suspended · inactivity), which is row-only.
//   Nothing else wakes main; elapsed time is row telemetry.
//   Rows live in state/agent.sqlite (`devin_sessions` · `devin_events`, D97). `devin_new` / `devin_go` create and flip
//   sessions (rules footers + stops in handoff.ts); `devin_say`/archive refuse a session that is not in the table (a
//   teammate's session is their conversation).
//   A row stays on its owner's board — paused rows dim — until Devin ENDS it, its PR closes, or `/devin done <slug>`.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { linkText, styledRow, type Palette, type Row } from "../../lib/agent-ui/board.ts";
import { boardOf } from "../../lib/agent-ui/sections.ts";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { api, keyTag, leased } from "./api.ts";
import { advance, arrivalChecks, diff, ENDED, mayAddress, onBoard, pollDue, POLL_MS, renderTranscript, rowFor, verdictOf, wakesOnStop, watched, type Event, type Expect, type Health, type Owner, type Session, type Snapshot } from "./state.ts";
import { where } from "../../lib/where.ts";
import { liveSources } from "../borrow/sources.ts";
import { askSlug, buildRules, designShape, expectOf, freshness, goMessage, ASK_FOOTER, DESIGN_FOOTER, type Target } from "./handoff.ts";
import { sharedRegistry } from "../../lib/database/registry.ts";
import { agentDbPath } from "../../lib/database/store.ts";

const AGENT_DIR = join(homedir(), ".pi/agent");
/** The pre-D97 JSON registry: imported into sqlite once (rows that already exist are left alone), then renamed. */
const LEGACY_JSON = join(AGENT_DIR, "state/devin_sessions.json");
const TASKS = join(homedir(), "notes/tasks");
const PR_WATCH = join(homedir(), "workspace/lab/agent_scripts/pr_watch/pr_watch.sh");
const WIDGET = "devin";
const run = promisify(execFile);

type Store = ReturnType<ReturnType<typeof sharedRegistry>>["store"];
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

/** One-time import of the JSON registry. INSERT-if-absent per row, so two sessions importing at once cannot clobber; the
 *  rename is the "done" mark, and losing the race to it is fine. */
function importLegacy(store: Store): void {
  if (!existsSync(LEGACY_JSON)) return;
  let raw: Record<string, any> = {};
  try { raw = JSON.parse(readFileSync(LEGACY_JSON, "utf8")); } catch { return; }
  for (const [id, r] of Object.entries(raw)) {
    const rec: Session = {
      id, title: r.title ?? id, kind: r.kind ?? "build", slug: r.slug, url: r.url ?? `https://app.devin.ai/sessions/${id}`,
      createdAt: r.created_at ? Number(r.created_at) * (r.created_at > 1e12 ? 1 : 1000) : Date.now(),
      watch: r.watch ?? true, owner: r.owner ?? undefined, polledAt: r.polledAt, expect: r.expect, mirror: r.mirror, stage: r.stage, round: r.round, last: r.last, question: r.question, stoppedAt: r.stoppedAt, lastMsgCount: r.lastMsgCount,
    };
    try { if (store.devinInsertIfAbsent(rec)) for (const e of r.events ?? []) store.devinEvent(id, e.at, e.text); } catch { /* a malformed legacy row is not worth failing startup */ }
  }
  try { renameSync(LEGACY_JSON, `${LEGACY_JSON}.imported`); } catch { /* another session got there first */ }
}

export default function (pi: ExtensionAPI) {
  const registry = sharedRegistry(pi, agentDbPath(AGENT_DIR));
  const store = () => registry().store;
  const sessions = new Map<string, Session>();
  /** Every row from the database; rows this process owns keep their in-memory state (it is ahead of the last write). */
  const load = (mine: (s: Session) => boolean) => {
    const rows = store().devinList() as unknown as Session[];
    const seen = new Set<string>();
    for (const r of rows) { seen.add(r.id); if (!(sessions.has(r.id) && mine(sessions.get(r.id)!))) sessions.set(r.id, r); }
    for (const [id, s] of sessions) if (!mine(s) && !seen.has(id)) sessions.delete(id);
  };
  const save = (mine: (s: Session) => boolean) => { for (const s of sessions.values()) if (mine(s)) store().devinUpsert(s); };
  let ui: { hasUI?: boolean; ui: { setWidget: (k: string, v: unknown, o?: { placement: "belowEditor" }) => void } } | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let alive = true;
  let me: string | undefined;                 // this pi session's id — the owner key
  const spot = (): Owner => ({ session: me!, pane: process.env.TMUX_PANE, pid: process.pid, cwd: process.cwd() });
  const mine = (s: Session) => !!me && s.owner?.session === me;
  /** D86's liveness: the owner's pid left a state/live crumb AND sits in a tmux pane. A missing pid is treated as alive — never open a claim on a guess. */
  const ownerAlive = (o: Owner) => o.pid === undefined || o.pid === process.pid || liveSources(process.pid).some((src) => src.pid === o.pid);
  const addressable = (s: Session, takeover = false) => { const r = mayAddress(s, me, ownerAlive); return r.ok || takeover ? undefined : { ...text(`refused: ${r.reason}`), isError: true }; };
  let rejectedKey: string | undefined;        // the key Devin answered 401/403 to; polling resumes only with a different one
  const keyRejected = () => !!rejectedKey && keyTag() === rejectedKey;
  const health = (): Health => ({ leased: leased(), keyRejected: keyRejected() });
  const board = boardOf(pi);
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

  /** the run record: events table + the task's vault index when one exists (a line, never a block — rule 6). */
  const record = (s: Session, line: string) => {
    const at = Date.now();
    (s.events ??= []).push({ at, text: line });
    try { store().devinEvent(s.id, at, line); } catch { /* the in-memory trail still paints */ }
    if (s.slug) { const idx = join(TASKS, s.slug, "index.md"); if (existsSync(idx)) { try { appendFileSync(idx, `- ${new Date(at).toISOString().slice(0, 10)} ${hhmm(at)} — ${line}\n`); } catch { /* vault is a projection */ } } }
  };
  const wake = (s: Session, body: string) => {
    pi.sendMessage(
      { customType: "devin_event", display: true, content: `[devin ${s.slug ?? s.id.slice(0, 8)}] ${body}\n${s.url}`, details: { session: s.id } },
      { deliverAs: "followUp", triggerTurn: true } as any,
    );
  };

  /** D96: the design conversation lands in the vault verbatim, by code, after every reply — the record Yong asked for. */
  const mirror = (s: Session, msgs: any[]) => {
    if (!s.mirror) return;
    try {
      mkdirSync(join(s.mirror, ".."), { recursive: true });
      const prev = existsSync(s.mirror) ? readFileSync(s.mirror, "utf8") : undefined;
      writeFileSync(s.mirror, renderTranscript(s, msgs, Date.now(), prev));
    } catch { /* vault is a projection */ }
  };

  const paint = () => {
    if (!alive || !ui?.hasUI) return;
    try {
      const now = Date.now();
      const h = health();
      const rows = [...sessions.values()].filter((s) => onBoard(s, me, now)).map((s) => rowFor(s, now, h));
      if (!rows.length) { board.remove(WIDGET); return; }
      board.section({ id: WIDGET, data: { title: "devin", noun: "session", hint: "/devin", rows } });   // the host paints, folds and cuts
    } catch { /* a projection; never fail a poll over it */ }
  };

  const onPr = async (s: Session, e: Extract<Event, { kind: "pr" }>) => {
    let report = `PR #${e.number} appeared: ${e.url}\nFirst pass now (/task §4): gh pr diff → plan parity · rulings held · proof real · red-first · conventions · blast radius → table in tasks/<slug>/design_review.md above the marker → report to Yong, and Devin's fixes via devin_say.`;
    if (s.kind === "design") report = `⚠️ a PR appeared in a DESIGN session — the footer forbade any repo write. Tell Devin to close it (devin_say) and check what it pushed.\n` + report;
    try {
      const { stdout } = await run("gh", ["pr", "view", String(e.number), "--repo", e.repo, "--json", "isDraft,headRefName,files,commits,additions,deletions"], { timeout: 30_000 });
      const pr = JSON.parse(stdout);
      const check = arrivalChecks(pr, s.expect ?? {});
      report += `\n${pr.isDraft ? "draft" : "NOT draft"} · ${pr.headRefName} · ${pr.files?.length ?? "?"} file(s) +${pr.additions}/−${pr.deletions}`;
      report += check.ok ? `\narrival checks: all ${Object.keys(s.expect ?? {}).length + 1} pass` : `\narrival checks FAILED:\n- ${check.failures.join("\n- ")}`;
      report += `\nfiles: ${(pr.files ?? []).map((f: any) => f.path).join(", ")}`;
    } catch (err) { report += `\n(gh pr view failed: ${(err as Error).message})`; }
    if (existsSync(PR_WATCH)) {
      execFile("bash", [PR_WATCH, "start", `${e.repo}#${e.number}`], () => {});
      report += `\npr_watch started (CI red / ready-to-merge → halo card). Un-draft and merge stay Yong's.`;
    }
    advance(s, { kind: "pr", number: e.number }, Date.now()); record(s, `PR #${e.number} opened — ${report.split("\n")[1] ?? ""}`);
    wake(s, report);
  };

  /** `force` (Yong's `/devin refresh`) polls every watched row now — the 10 min paused cadence is for the machine, not for him looking. */
  const poll = async (force = false) => {
    if (!alive) return;
    if (polling || !leased() || keyRejected()) { paint(); return; }
    polling = true;
    try {
      const now = Date.now();
      for (const s of sessions.values()) {
        if (!mine(s) || !watched(s) || (!force && !pollDue(s, now))) continue;
        const { code, data } = await api.session(s.id);
        if (code === 401 || code === 403) { rejectedKey = keyTag(); record(s, `Devin rejected the key (HTTP ${code}) — rotate the PAT, then secret_unlock devin`); break; }
        if (code !== 200) { record(s, `poll HTTP ${code}`); continue; }
        s.polledAt = now;
        const next: Snapshot = { status: data.status, status_detail: data.status_detail, acus_consumed: data.acus_consumed, pull_requests: data.pull_requests ?? [] };
        let msgs: any[] = [];
        const freshStop = next.status_detail === "waiting_for_user" && s.last?.status_detail !== "waiting_for_user";
        if (freshStop || (s.mirror && ENDED.has(next.status) && !ENDED.has(s.last?.status ?? ""))) {
          const m = await api.messages(s.id); if (m.code === 200) { msgs = m.data.items ?? []; s.lastMsgCount = msgs.length; mirror(s, msgs); }
        }
        const events = diff(s, s.last, next, msgs);
        s.last = next;
        for (const e of events) {
          if (e.kind === "stopped") {
            s.question = e.question; s.stoppedAt = now;
            // An acknowledgement stops the session too; waking main on it and replying makes another one, forever.
            if (s.kind === "design") {
              const v = verdictOf(msgs); advance(s, { kind: "design_reply", verdict: v }, now); record(s, `design reply${v ? ` · VERDICT ${v}` : ""}: ${e.question.split("\n")[0].slice(0, 100)}`);
              if (wakesOnStop(s.kind, e.question)) wake(s, `design review reply${v ? ` — VERDICT: ${v}` : " (no VERDICT line)"} (${data.acus_consumed ?? 0} ACU so far). Mirrored to ${s.mirror ?? "(no mirror)"}.\n\n${e.question}\n\nVerify every fact it asserts against origin/main before amending plan.md; reply with devin_say. agree + nothing open ⇒ show Yong the final plan (/task §3); otherwise next round (≤3).`);
            } else if (wakesOnStop(s.kind, e.question)) { advance(s, { kind: "asked" }, now); record(s, `stopped and asked: ${e.question.split("\n")[0]}`); wake(s, `stopped to ask (${data.acus_consumed ?? 0} ACU so far):\n\n${e.question}\n\nIf it states a fact, verify it against origin/main before answering; devin_say to reply, or leave it if no reply is owed.`); }
            else { advance(s, { kind: "paused" }, now); record(s, `paused after: ${e.question.split("\n")[0].slice(0, 100)}`); }
          }
          if (e.kind === "resumed") { s.question = undefined; s.stoppedAt = undefined; record(s, "resumed"); }
          if (e.kind === "pr") await onPr(s, e);
          if (e.kind === "paused") record(s, `${e.status}${next.status_detail && next.status_detail !== e.status ? ` · ${next.status_detail}` : ""} — row stays until /devin done ${s.slug ?? s.id.slice(0, 8)}`);   // D97: row only, no wake
          if (e.kind === "ended") { advance(s, { kind: "ended", status: e.status }, now); record(s, `session ${e.status} · ${data.acus_consumed ?? 0} ACU`); wake(s, `session ${e.status} · ${data.acus_consumed ?? 0} ACU · ${(s.last.pull_requests ?? []).map((p) => p.pr_url).join(" ") || "no PR"}`); }
        }
      }
      save(mine);
    } catch { /* transient; next tick */ } finally { polling = false; paint(); }
  };
  const ensureTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => { if (![...sessions.values()].some((s) => mine(s) && watched(s, Date.now()))) { clearInterval(ticker); ticker = undefined; } void poll(); }, POLL_MS);
    ticker.unref?.();
  };

  pi.on("session_start", async (_e, ctx) => {
    alive = true; ui = ctx as any;
    me = ctx.sessionManager.getSessionId() || undefined;
    try { importLegacy(store()); load(mine); } catch { /* no database yet: the board stays empty, tools say so */ }
    let moved = false;                                             // a resume lands in a new pane: re-stamp my rows' Spot
    for (const s of sessions.values()) if (mine(s) && s.owner!.pane !== process.env.TMUX_PANE) { s.owner = spot(); moved = true; }
    if (moved) save(mine);
    paint();
    if ([...sessions.values()].some((s) => mine(s) && watched(s, Date.now()))) { ensureTicker(); void poll(); }
  });
  // /reload builds a new instance; this one's timer must die with it. A paint on the old ctx is an uncaughtException
  // and pi EXITS (Yong had to `pi -c` twice on 2026-09-17).
  pi.on("session_shutdown", async () => { alive = false; ui = undefined; if (ticker) { clearInterval(ticker); ticker = undefined; } });

  pi.registerTool({
    name: "devin_watch", label: "Watch Devin session",
    description: "Put a Devin session on the board and poll it (30 s). A session another LIVE pi main owns is refused (takeover:true only when that session is gone). Main gets a follow-up turn only when Devin stops to ask (question text included), a PR appears (arrival checklist runs as code, pr_watch takes over), or the session ends. `expect` = facts the PR must satisfy. Sessions opened by devin_new are watched automatically; use this to claim a session another pi (or a teammate) opened, or to change slug/expect.",
    parameters: Type.Object({
      session_id: Type.String(), slug: Type.Optional(Type.String({ description: "short name for the row; also tasks/<slug>/index.md gets the timeline" })),
      title: Type.Optional(Type.String()),
      expect: Type.Optional(Type.Object({ branch: Type.Optional(Type.String()), authorEmail: Type.Optional(Type.String()), filesMatch: Type.Optional(Type.String({ description: "regex every changed file must match, e.g. \\\\.spec\\\\.ts$" })) })),
      takeover: Type.Optional(Type.Boolean({ description: "claim a session another LIVE pi main owns — only when that session is truly gone; its board row and wakes move here" })),
    }),
    async execute(_id, p) {
      const held = sessions.get(p.session_id); if (held) { const no = addressable(held, p.takeover); if (no) return no; }
      const s = held ?? { id: p.session_id, title: p.title ?? p.slug ?? p.session_id, kind: "build" as const, url: `https://app.devin.ai/sessions/${p.session_id}`, createdAt: Date.now(), watch: true, events: [] };
      if (p.slug) s.slug = p.slug; if (p.title) s.title = p.title; if (p.expect) s.expect = p.expect as Expect; s.watch = true;
      if (me) s.owner = spot();                                    // claiming: this session polls, is woken, paints
      sessions.set(s.id, s); save(mine); ensureTicker(); void poll();
      return text(`watching ${s.slug ?? s.id} — ${s.url}${leased() ? "" : "\n⚠ creds not leased: secret_unlock devin"}`);
    },
  });

  /** `gh api` as the freshness oracle — Devin reads origin/main, so the plan is checked against the remote, never this checkout. */
  const gh = async (path: string) => { const { stdout } = await run("gh", ["api", path], { timeout: 60_000, maxBuffer: 4 << 20 }); return JSON.parse(stdout); };
  const readPlan = (path: string) => readFileSync(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path, "utf8");
  const target = (p: { slug?: string; pr?: string; branch?: string; files_match?: string }): Target => ({ slug: p.slug, pr: p.pr, branch: p.branch, filesMatch: p.files_match });
  /** Create a session, own it, tag it, put it on the board. The row exists before the poller can see the session. */
  const open = async (prompt: string, title: string, kind: Session["kind"], slug: string, extra: Partial<Session>, tag: string) => {
    const { code, data } = await api.create(prompt, title);
    if (code < 200 || code >= 300) throw new Error(`create failed HTTP ${code}: ${JSON.stringify(data).slice(0, 300)}`);
    const id: string = data.session_id ?? data.id; const url: string = data.url ?? data.session_url ?? `https://app.devin.ai/sessions/${id}`;
    if (!id) throw new Error(`create returned no session id — ${JSON.stringify(data).slice(0, 300)}`);
    const now = Date.now();
    const s: Session = { id, title, kind, slug, url, createdAt: now, watch: true, owner: spot(), events: [], stage: { name: kind === "design" ? "design r1" : kind === "ask" ? "asked" : "building", move: "devin", at: now }, ...extra };
    sessions.set(id, s); save(mine); record(s, `created · ${kind}`);
    void api.tag(id, [tag]).catch(() => {});
    ensureTicker(); void poll();
    return s;
  };
  const MIRROR_DIR = join(homedir(), "notes/tasks");

  pi.registerTool({
    name: "devin_new", label: "Open Devin session",
    description: "Open a Devin session and put it on the board. kind=design: Devin reviews plan.md (CLAIMS · CHOICES · risks · VERDICT), no repo writes; the plan needs `## Claims to verify` + `## Design choices` (allow_shapeless overrides). kind=build: implement plan.md — new draft PR on <branchPrefix>/<slug>, or push to an existing PR (pr + branch). kind=ask: a read-only question. Plans naming a repo are checked for freshness against origin/main per named file (allow_stale overrides). dry_run returns the exact prompt without sending. Creds: secret_unlock devin.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("design"), Type.Literal("build"), Type.Literal("ask")]),
      title: Type.String(),
      plan: Type.Optional(Type.String({ description: "path to plan.md (design · build)" })),
      question: Type.Optional(Type.String({ description: "the question (ask)" })),
      slug: Type.Optional(Type.String({ description: "board name; build: branch = <branchPrefix>/<slug>; design: mirror = tasks/<slug>/design_review.md" })),
      pr: Type.Optional(Type.String({ description: "build into an existing PR (URL); needs branch" })), branch: Type.Optional(Type.String()),
      files_match: Type.Optional(Type.String({ description: "arrival check: regex every changed file must match" })),
      allow_stale: Type.Optional(Type.Boolean()), allow_shapeless: Type.Optional(Type.Boolean()), dry_run: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p) {
      try {
        if (p.kind === "ask") {
          if (!p.question) return { ...text("ask needs question"), isError: true };
          const prompt = p.question.trim() + "\n" + ASK_FOOTER, title = p.title || `pi-ask: ${p.question.trim().split("\n")[0].slice(0, 70)}`;
          if (p.dry_run) return text(prompt);
          const s = await open(prompt, title, "ask", askSlug(title), {}, "pi-ask");
          return text(`session_id=${s.id}\nurl=${s.url}\n(on the board as ${s.slug}; the reply wakes main)`);
        }
        if (!p.plan) return { ...text(`${p.kind} needs plan`), isError: true };
        if (!p.slug && !p.pr) return { ...text(`${p.kind} needs slug`), isError: true };
        const plan = readPlan(p.plan);
        const notes: string[] = [];
        if (p.kind === "design") {
          const missing = designShape(plan);
          if (missing.length && !p.allow_shapeless) return { ...text(`refusing: plan.md needs ${missing.map((h) => `\`${h}\``).join(" and ")} — numbered claims (each a fact Devin can read at origin/main) and lettered design choices (each with the alternative it rejected). allow_shapeless to send anyway.`), isError: true };
        }
        const rules = p.kind === "design" ? DESIGN_FOOTER : buildRules(target(p));
        if (!p.allow_stale) { const n = await freshness(plan, gh); if (n) notes.push(n); }
        const prompt = plan.trim() + "\n" + rules;
        if (p.dry_run) return text([...notes, prompt].join("\n\n"));
        if (p.kind === "design") {
          const mirror = join(MIRROR_DIR, p.slug!, "design_review.md");
          const s = await open(prompt, p.title, "design", p.slug!, { mirror, round: 1 }, "pi-design");
          return text([...notes, `session_id=${s.id}\nurl=${s.url}\nmirror=${mirror}\n(on the board as ${s.slug} · design; every reply wakes main; devin_go when both sides agree)`].join("\n"));
        }
        const s = await open(prompt, p.title, "build", p.slug ?? p.branch!, { expect: expectOf(target(p)) as Expect }, "pi-task");
        return text([...notes, `session_id=${s.id}\nurl=${s.url}\n(on the board as ${s.slug}; a PR wakes main and pr_watch takes over)`].join("\n"));
      } catch (e: any) { return { ...text(e.message ?? String(e)), isError: true }; }
    },
  });

  pi.registerTool({
    name: "devin_go", label: "Design agreed → build",
    description: "The design session agreed: send the FINAL plan + build rules into that same session and flip its row to build (new draft PR on <branchPrefix>/<slug>, or pr + branch for an existing PR). Refuses a non-design session; freshness check as devin_new (allow_stale). dry_run returns the message.",
    parameters: Type.Object({
      session_id: Type.String(), plan: Type.String(),
      slug: Type.Optional(Type.String()), pr: Type.Optional(Type.String()), branch: Type.Optional(Type.String()), files_match: Type.Optional(Type.String()),
      allow_stale: Type.Optional(Type.Boolean()), dry_run: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p) {
      try {
        load(mine);
        const s = sessions.get(p.session_id);
        if (!s) return { ...text(`refused: ${p.session_id} is not a session this machine created`), isError: true };
        { const no = addressable(s); if (no) return no; }
        if (s.kind !== "design") return { ...text(`refusing: ${s.slug ?? s.id} is a ${s.kind} session, not a design review — devin_new kind=build opens a build directly`), isError: true };
        const t = target({ ...p, slug: p.slug ?? s.slug });
        const rules = buildRules(t);
        const plan = readPlan(p.plan);
        const notes: string[] = [];
        if (!p.allow_stale) { const n = await freshness(plan, gh); if (n) notes.push(n); }
        const { message, note } = goMessage(plan, rules); if (note) notes.push(note);
        if (p.dry_run) return text([...notes, message].join("\n\n"));
        const { code, data } = await api.say(s.id, message);
        if (code < 200 || code >= 300) return { ...text(`go failed HTTP ${code}: ${JSON.stringify(data).slice(0, 300)}`), isError: true };
        s.kind = "build"; s.expect = expectOf(t) as Expect; s.watch = true; s.signedOffAt = undefined; if (t.slug) s.slug = t.slug;
        advance(s, { kind: "go" }, Date.now()); record(s, "go — design agreed, same session builds");
        if (mine(s)) save(mine); else { s.owner = spot(); save(mine); }
        void api.tag(s.id, ["pi-task"]).catch(() => {});
        ensureTicker(); void poll();
        return text([...notes, `sent — ${s.slug ?? s.id} is now a build session (branch ${s.expect?.branch ?? "?"}); the board follows it`].join("\n"));
      } catch (e: any) { return { ...text(e.message ?? String(e)), isError: true }; }
    },
  });

  pi.registerTool({
    name: "devin_say", label: "Steer Devin",
    description: "Send a message into a Devin session THIS pi session owns (a teammate's is refused; another live pi main's is refused — read it with devin_messages and let Yong speak in that tab). Use to answer a stop or steer. Never paste secrets.",
    parameters: Type.Object({ session_id: Type.String(), text: Type.String() }),
    async execute(_id, p) {
      load(mine);
      const s = sessions.get(p.session_id);
      if (!s) return { ...text(`refused: ${p.session_id} is not a session this machine created`), isError: true };
      { const no = addressable(s); if (no) return no; }
      const { code, data } = await api.say(s.id, p.text);
      if (code < 200 || code >= 300) return { ...text(`say failed HTTP ${code}: ${JSON.stringify(data).slice(0, 300)}`), isError: true };
      advance(s, { kind: "main_said" }, Date.now()); record(s, `main → devin: ${p.text.split("\n")[0].slice(0, 100)}`); s.question = undefined; if (mine(s)) save(mine); paint();
      return text("sent");
    },
  });

  pi.registerTool({
    name: "devin_messages", label: "Devin conversation",
    description: "Messages in a watched Devin session — by default only those since main last read (the initial prompt is skipped). `all` for the whole thread.",
    parameters: Type.Object({ session_id: Type.String(), all: Type.Optional(Type.Boolean()) }),
    async execute(_id, p) {
      const s = sessions.get(p.session_id);
      const { code, data } = await api.messages(p.session_id);
      if (code !== 200) return { ...text(`messages failed HTTP ${code}`), isError: true };
      const items: any[] = data.items ?? [];
      const from = p.all ? 0 : Math.max(1, s?.lastMsgCount ?? 1);
      if (s && mine(s)) { s.lastMsgCount = items.length; save(mine); }
      const shown = items.slice(from).map((m) => `[${m.user_id ? "me" : "devin"} · ${typeof m.created_at === "number" ? hhmm(m.created_at * 1000) : ""}]\n${m.message ?? ""}`);
      return text(shown.length ? shown.join("\n\n") : `(nothing new — ${items.length} messages total)`);
    },
  });

  pi.registerCommand("devin", {
    description: "Devin sessions (status · question · PR · events) · `/devin refresh` polls every row now and says what changed · `/devin go [slug]` jumps to the owner's tmux window · `/devin done <slug>` signs a row off the board (D97) · `/devin archive <slug>` archives the session at Devin · `/devin all` includes signed-off rows · `/devin notes` mirrors the org's Devin knowledge notes into the vault",
    handler: async (args, ctx) => {
      const now = Date.now();
      load(mine);
      const [verb, slug] = (args ?? "").trim().split(/\s+/);
      const match = (s: Session) => !!slug && (s.slug === slug || s.id.startsWith(slug));
      if (verb === "refresh") {
        if (!leased()) { ctx.ui.notify("no Devin key leased here — secret_unlock devin first", "warning"); return; }
        const before = new Map([...sessions.values()].filter(mine).map((s) => [s.id, `${s.last?.status ?? "?"}/${s.last?.pull_requests?.[0]?.pr_state ?? "-"}`]));
        await poll(true);
        const changed = [...sessions.values()].filter(mine).filter((s) => before.get(s.id) !== `${s.last?.status ?? "?"}/${s.last?.pull_requests?.[0]?.pr_state ?? "-"}`).map((s) => `${s.slug ?? s.id.slice(0, 8)} → ${s.last?.status}${s.last?.pull_requests?.[0] ? ` · PR ${s.last.pull_requests[0].pr_state}` : ""}`);
        ctx.ui.notify(`refreshed ${before.size} Devin row${before.size === 1 ? "" : "s"} · ${changed.length ? changed.join(" · ") : "no changes"}`, "info");
        return;
      }
      if (verb === "done") {
        const hits = [...sessions.values()].filter((s) => match(s) && !s.signedOffAt);
        if (hits.length !== 1) { ctx.ui.notify(hits.length ? `“${slug}” matches ${hits.length} rows — use the session id` : `no open Devin row matches “${slug ?? ""}”`, "warning"); return; }
        const s = hits[0];
        if (!store().devinSignOff(s.id, now)) { ctx.ui.notify(`${s.slug ?? s.id} was already signed off`, "info"); return; }
        s.signedOffAt = now; record(s, "signed off by Yong (/devin done)"); paint();
        ctx.ui.notify(`${s.slug ?? s.id} signed off — off the board; /devin all still lists it`, "info");
        return;
      }
      if (verb === "archive") {
        const hits = [...sessions.values()].filter(match);
        if (hits.length !== 1) { ctx.ui.notify(hits.length ? `“${slug}” matches ${hits.length} rows — use the session id` : `no Devin row matches “${slug ?? ""}” (only sessions this machine created can be archived)`, "warning"); return; }
        const { code, data } = await api.archive(hits[0].id);
        if (code < 200 || code >= 300) { ctx.ui.notify(`archive failed HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`, "error"); return; }
        record(hits[0], "archived at Devin"); ctx.ui.notify(`${hits[0].slug ?? hits[0].id} archived — the poller will end the row`, "info"); void poll();
        return;
      }
      if (verb === "notes") {
        const out = join(homedir(), "notes/resources/knowledge/devin_notes");
        mkdirSync(out, { recursive: true });
        let n = 0, cursor: string | undefined;
        do {
          const { code, data } = await api.notes(cursor);
          if (code !== 200) { ctx.ui.notify(`notes failed HTTP ${code}`, "error"); return; }
          for (const note of data.items ?? []) {
            const file = ((note.name ?? note.note_id) as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
            const fm = ["note_id", "name", "trigger", "folder_path", "pinned_repo", "is_enabled", "access_type", "updated_at"].map((k) => `${k}: ${JSON.stringify(note[k] ?? null)}`).join("\n");
            writeFileSync(join(out, `${file}.md`), `---\n${fm}\nmirrored: ${new Date().toISOString().slice(0, 10)}\nsource: devin knowledge (org-authored, read-only mirror — edit in Devin, not here)\n---\n# ${note.name ?? ""}\n\n> trigger: ${note.trigger || "—"}\n\n${note.body ?? ""}`);
            n++;
          }
          cursor = data.has_next_page ? data.end_cursor : undefined;
        } while (cursor);
        ctx.ui.notify(`mirrored ${n} notes → ${out}`, "info");
        return;
      }
      if (verb === "go") {
        const owned = [...sessions.values()].filter((s) => s.owner?.pane && !s.signedOffAt && (!slug || match(s)));
        let s = owned[0];
        if (owned.length > 1) { const pick = await ctx.ui.select("jump to the pi session watching…", owned.map((o) => `${o.slug ?? o.id.slice(0, 8)} — ${where(o.owner!)}`)); s = owned.find((o) => pick?.startsWith(o.slug ?? o.id.slice(0, 8))); }
        if (!s) { ctx.ui.notify(slug ? `no owned Devin row matches “${slug}”` : "no Devin row has an owner pane", "warning"); return; }
        try { await run("tmux", ["select-window", "-t", s.owner!.pane!]); await run("tmux", ["select-pane", "-t", s.owner!.pane!]); }
        catch { ctx.ui.notify(`owner pane ${s.owner!.pane} is gone — ${where(s.owner!)}`, "warning"); }
        return;
      }
      const items = [...sessions.values()].filter((s) => verb === "all" || !s.signedOffAt)
        .sort((a, b) => Number(mine(b)) - Number(mine(a)) || b.createdAt - a.createdAt)
        .map((s) => {
          const row = rowFor(s, now);
          if (s.signedOffAt) { row.state = "done"; row.detail = `signed off ${hhmm(s.signedOffAt)} · ${row.detail}`; }
          if (!mine(s)) row.detail = `${row.detail ? `${row.detail} · ` : ""}${s.owner ? `watched by ${where(s.owner)}` : "unowned — devin_watch to claim"}`;
          return { row, events: (s.events ?? []).map((e) => ({ at: e.at, text: e.text })) };
        });
      if (items.length === 0) { ctx.ui.notify(verb === "all" ? "no Devin sessions recorded" : "no open Devin sessions — /devin all for signed-off ones", "info"); return; }
      pi.appendEntry("devin_list", { items });   // TUI-only, durable, rendered in the board grammar below; never model context
    },
  });

  // The list is the board's rows with their event trail: same glyphs, same tones, same links (name → session, #N → PR).
  const URL_RE = /https?:\/\/\S+/g;
  pi.registerEntryRenderer("devin_list", (entry, { expanded }, theme) => {
    const data = entry.data as { items: Array<{ row: Row; events: Array<{ at: number; text: string }> }> };
    const pal: Palette = { fg: (t, x) => theme.fg(t, x), bold: (x) => theme.bold(x), link: getCapabilities().hyperlinks ? hyperlink : undefined };
    const linkify = (t: string) => t.replace(URL_RE, (u) => linkText(pal, u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40), u));
    const width = Math.max(40, (process.stdout.columns ?? 120) - 4);
    const lines: string[] = [];
    for (const { row, events } of data.items) {
      lines.push(styledRow(row, width, pal));
      for (const e of (expanded ? events : events.slice(-4))) lines.push(theme.fg("dim", `    ${hhmm(e.at)} `) + theme.fg("muted", linkify(e.text)));
    }
    if (!expanded && data.items.some((i) => i.events.length > 4)) lines.push(theme.fg("dim", "    … ctrl+o for the full trail"));
    return new Text(lines.join("\n"), 0, 0);
  });
}
