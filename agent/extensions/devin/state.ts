/**
 * Pure Devin-session state — a Devin session is a worker whose pane is a URL.
 * REST snapshots in, board rows + events out. No pi imports, no network: `node --test` loads it.
 */
import type { Row } from "../../lib/agent-ui/board.ts";
import { elapsed } from "../../lib/agent-ui/time.ts";

export interface Snapshot { status: string; status_detail?: string; acus_consumed?: number; pull_requests?: Array<{ pr_url: string; pr_state?: string }>; }
export interface Message { user_id?: string | null; message?: string; created_at?: number | string; }

export interface Session {
  id: string; slug?: string; title: string; url: string; kind: "build" | "ask" | "design";
  createdAt: number; watch: boolean;
  /** design review (D96): the vault file the conversation is mirrored to, verbatim, after every Devin reply */
  mirror?: string;
  /** where the /task flow is and whose move it is — set at each transition by `advance`, never inferred from event prose */
  stage?: Stage;
  round?: number;
  /** the pi session that claimed the watch (polls it, is woken by it, paints it) and where that session runs */
  owner?: Owner;
  /** what the PR must look like when it appears; every row is a fact `gh pr view` returns */
  expect?: Expect;
  last?: Snapshot; question?: string; stoppedAt?: number; lastMsgCount?: number;
  /** last successful poll; the row shows "stale" once it is older than STALE_MS */
  polledAt?: number;
  /** D97: Yong's `/devin done` — the row leaves the board; nothing else about the session changes */
  signedOffAt?: number;
  events?: Array<{ at: number; text: string }>;
}
export interface Expect { branch?: string; authorEmail?: string; filesMatch?: string; }
export interface Owner { session: string; pane?: string; pid?: number; cwd?: string }

const CLOSED_PR = new Set(["merged", "closed"]);
const prsClosed = (s: Snapshot | undefined) => !!s?.pull_requests?.length && s.pull_requests.every((p) => CLOSED_PR.has(p.pr_state ?? ""));
const GRACE_MS = 600_000;
export const POLL_MS = 30_000, PAUSED_POLL_MS = 600_000;
/** D97: a pause is Devin finishing a turn, an end is the session's death. Only ENDED (or a sign-off) takes a row off the board. */
export const ENDED = new Set(["finished", "archived", "expired"]);
export const PAUSED = new Set(["suspended", "stopped", "blocked"]);
/** Ended = Devin closed the session, OR every PR it opened is merged/closed (D97: "its PR closes") — Devin itself stays `suspended` after a PR closes, so its status alone never ends a row. */
export const ended = (s: Session) => ENDED.has(s.last?.status ?? "") || prsClosed(s.last);
export const paused = (s: Session) => PAUSED.has(s.last?.status ?? "");
export const watched = (s: Session, _now?: number) => s.watch && !s.signedOffAt && !ended(s);
/** A paused session is polled rarely: a REST call per row every 30 s for a week buys nothing. */
export const pollDue = (s: Session, now: number) => watched(s) && now - (s.polledAt ?? 0) >= (paused(s) ? PAUSED_POLL_MS : POLL_MS);
/** A row belongs on THIS session's board only if this session owns it: watched (live or paused), or ended within the grace window. */
export function onBoard(s: Session, me: string | undefined, now: number): boolean {
  if (!me || s.owner?.session !== me || s.signedOffAt) return false;
  return watched(s) || (ended(s) && now - (s.events?.at(-1)?.at ?? 0) < GRACE_MS);
}

/** A Devin session is ONE conversation with ONE pi main (D70: cross-session is advice, never force). Another live main may read
 *  it, never speak into it or take the watch — two authors in one thread and the owner's poller reports a `main_said` it never
 *  said. The owner's death (no pid in a tmux pane) opens the claim. `ownerAlive` is the caller's liveness oracle. */
export function mayAddress(s: Session, me: string | undefined, ownerAlive: (o: Owner) => boolean): { ok: true } | { ok: false; reason: string } {
  const o = s.owner;
  if (!o || o.session === me) return { ok: true };
  if (!ownerAlive(o)) return { ok: true };
  return { ok: false, reason: `${s.slug ?? s.id} is owned by a live pi session (${o.pane ?? o.session}, pid ${o.pid ?? "?"}); read it with devin_messages, and say what you would tell it — Yong types it in the owner's tab. devin_watch takeover:true only if that session is truly gone.` };
}

export type Event =
  | { kind: "stopped"; question: string }
  | { kind: "resumed" }
  | { kind: "pr"; url: string; number: number; repo: string }
  | { kind: "paused"; status: string }      // row only, never a wake
  | { kind: "ended"; status: string };

const stopped = (s: Snapshot | undefined) => s?.status_detail === "waiting_for_user";
const prsOf = (s: Snapshot | undefined) => (s?.pull_requests ?? []).map((p) => p.pr_url);

export function lastDevinQuestion(msgs: Message[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) if (!msgs[i].user_id) return msgs[i].message?.trim() || undefined;
  return undefined;
}

/**
 * Does a stop need main? `waiting_for_user` also fires on plain acknowledgements ("Understood — staying attached"),
 * and answering one produces another, forever. A message asks when it contains a question, opens with an ask verb,
 * or declares itself blocked. A miss is visible: the row still shows ↩ and /devin shows the text.
 */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  if (/^(should|shall|can|could|would|do|does|did|is|are|which|what|where|when|how|why|may|need)\b/i.test(t)) return true;
  return /\b(blocked|cannot proceed|can't proceed|need(s)? (your|a) (decision|answer|input)|please (confirm|advise|choose|decide))\b/i.test(t);
}

/** A design session is a conversation: every reply is owed an answer, question mark or not. A build stops for many
 *  reasons ("Understood — staying attached"); only a question wakes main there. */
export const wakesOnStop = (kind: Session["kind"], text: string): boolean => !!text.trim() && (kind === "design" || isQuestion(text));

/** Devin's last verdict — the `VERDICT: agree|amend|disagree` line the design footer asks for — or undefined. */
export function verdictOf(msgs: Message[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].user_id) continue;
    const m = /^\s*\**VERDICT\**\s*:\s*\**(agree|amend|disagree)\b/im.exec(msgs[i].message ?? "");
    return m ? m[1].toLowerCase() : undefined;
  }
  return undefined;
}

export type Move = "you" | "main" | "devin" | "none";
export interface Stage { name: string; move: Move; at: number }
export type Transition =
  | { kind: "design_reply"; verdict?: string } | { kind: "main_said" } | { kind: "go" } | { kind: "asked" } | { kind: "paused" }
  | { kind: "pr"; number: number } | { kind: "ended"; status: string };

/** The current stage; a row written before stages existed reads as the flow's first rung for its kind. */
export function stageOf(s: Session): Stage {
  return s.stage ?? (s.kind === "design" ? { name: "design r1", move: "devin", at: s.createdAt } : { name: s.kind === "ask" ? "asked" : "building", move: "devin", at: s.createdAt });
}

/** One rung at a time. `paused` after a PR is Devin's "pushed" — the PR is the thing to look at, so the move is Yong's. */
export function advance(s: Session, t: Transition, now: number): void {
  const cur = stageOf(s);
  const pr = /^PR #(\d+)/.exec(cur.name)?.[1];
  const set = (name: string, move: Move) => { s.stage = { name, move, at: now }; };
  switch (t.kind) {
    case "design_reply": {
      const r = (s.round ??= 1);
      return t.verdict === "agree" ? set(`design r${r} · agreed`, "you") : set(`design r${r}${t.verdict ? ` · VERDICT ${t.verdict}` : ""}`, "main");
    }
    case "main_said":
      if (s.kind === "design") { s.round = (s.round ?? 1) + 1; return set(`design r${s.round}`, "devin"); }
      return pr ? set(`PR #${pr} · Devin fixing`, "devin") : set("building", "devin");
    case "go": return set("building", "devin");
    case "asked": return set(pr ? `PR #${pr} · Devin asks` : "Devin asks", "main");
    case "paused": return pr ? set(`PR #${pr} · pushed · your un-draft`, "you") : undefined;
    case "pr": return set(`PR #${t.number} · first pass owed`, "main");
    case "ended": return set(t.status, "none");
  }
}

export const TRANSCRIPT_MARK = "<!-- transcript -->";

/** The mirror file has two authors: main writes the rulings ABOVE the marker (finding · checked · ruling), code rewrites
 *  the verbatim transcript BELOW it. `prev` is the file as it stands; its head survives, its tail is replaced whole. */
export function renderTranscript(s: { title: string; url: string; kind: string }, msgs: Message[], now: number, prev?: string): string {
  const when = (t: Message["created_at"]) => {
    const d = typeof t === "number" ? new Date(t * (t > 1e12 ? 1 : 1000)) : t ? new Date(t) : undefined;
    return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "";
  };
  const i = prev?.indexOf(TRANSCRIPT_MARK) ?? -1;
  const head = i >= 0 ? prev!.slice(0, i) : [
    `# Design review with Devin — ${s.title}`,
    ``,
    `> [!info] Devin session [${s.url}](${s.url}) (now: ${s.kind}). Above the marker: main's rulings per round — Devin's finding · what main checked at origin/main · the ruling. Below it: the conversation verbatim, rewritten by the pi \`devin\` extension after every reply. The plan that resulted is \`plan.md\`.`,
    ``,
    `## Rulings`,
    ``,
    `| # | Devin's finding | checked (file:line, grep, package) | ruling |`,
    `|---|---|---|---|`,
    ``,
  ].join("\n");
  // headings inside a message would read as new turns; demote them (text unchanged)
  const body = msgs.map((m, i) => `## ${i + 1} · ${m.user_id ? "pi → Devin" : "Devin → pi"} · ${when(m.created_at)}\n\n${(m.message ?? "").trim().replace(/^#{1,3} /gm, "#### ")}\n`);
  return head + [TRANSCRIPT_MARK, ``, `## The exchange, verbatim — last ${when(now / 1000)} UTC`, ``].concat(body).join("\n");
}

export function parsePr(url: string): { repo: string; number: number } | undefined {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1], number: Number(m[2]) } : undefined;
}

/** Events between two snapshots. `msgs` is only consulted on a fresh stop, to carry the question. */
export function diff(_s: Session, prev: Snapshot | undefined, next: Snapshot, msgs: Message[]): Event[] {
  const out: Event[] = [];
  const live = (s: Snapshot | undefined) => !!s && !PAUSED.has(s.status) && !ENDED.has(s.status);
  if (!stopped(prev) && stopped(next)) out.push({ kind: "stopped", question: lastDevinQuestion(msgs) ?? "(no message — open the session)" });
  if ((stopped(prev) || PAUSED.has(prev?.status ?? "")) && !stopped(next) && live(next)) out.push({ kind: "resumed" });
  const seen = new Set(prsOf(prev));
  for (const url of prsOf(next)) if (!seen.has(url)) { const p = parsePr(url); if (p) out.push({ kind: "pr", url, ...p }); }
  if (!PAUSED.has(prev?.status ?? "") && PAUSED.has(next.status)) out.push({ kind: "paused", status: next.status });
  if (!ENDED.has(prev?.status ?? "") && ENDED.has(next.status)) out.push({ kind: "ended", status: next.status });
  else if (!prsClosed(prev) && prsClosed(next)) out.push({ kind: "ended", status: `PR ${next.pull_requests![0].pr_state}` });
  return out;
}

/** What the owner's process knows that the registry cannot: is a key leased, and has Devin rejected it. */
export interface Health { leased: boolean; keyRejected?: boolean }
export const STALE_MS = 90_000;   // three polls

/** The stage IS the row: detail names it, the glyph is whose move, the wait clock is time in the stage. */
function stageRow(s: Session, now: number): Row {
  const st = s.stage!; const last = s.last;
  const prUrl = prsOf(last).find((u) => parsePr(u));
  const acu = last?.acus_consumed ? ` · ${last.acus_consumed} ACU` : "";
  const base = { name: s.slug ?? s.title.slice(0, 24), pane: "devin", profile: s.kind === "build" ? undefined : s.kind, ageMs: now - s.createdAt, url: s.url, prUrl };
  const since = now - st.at;
  if (st.move === "none") return { ...base, state: "done", detail: `${st.name}${acu}` };
  if (paused(s) && st.move !== "you") return { ...base, state: "idle", detail: `${last!.status} · ${st.name} · ${elapsed(since)}${acu}` };
  if (st.move === "devin") return { ...base, state: "working", detail: `${st.name} · ${last?.status_detail ?? last?.status ?? "starting"} · ${elapsed(since)}${acu}` };
  return { ...base, state: "waiting", waiting: { on: st.move, why: st.name, sinceMs: since }, detail: `${st.name} · ${elapsed(since)}${acu}` };
}

export function rowFor(s: Session, now: number, health?: Health): Row {
  const row = baseRow(s, now);
  if (!health || !watched(s, now)) return row;
  if (health.keyRejected) return { ...row, state: "stalled", detail: "key rejected (401) — rotate the Devin PAT, then secret_unlock devin" };
  const staleMs = now - (s.polledAt ?? s.createdAt);
  if (!health.leased) return { ...row, state: "idle", detail: `stale ${elapsed(staleMs)} — secret_unlock devin` };
  if (staleMs > STALE_MS) return { ...row, detail: `${row.detail} · stale ${elapsed(staleMs)}` };
  return row;
}

function baseRow(s: Session, now: number): Row {
  const last = s.last;
  if (s.stage) return stageRow(s, now);
  const prUrl = prsOf(last).find((u) => parsePr(u));
  const pr = prUrl ? parsePr(prUrl) : undefined;
  const acu = last?.acus_consumed ? ` · ${last.acus_consumed} ACU` : "";
  const base = { name: s.slug ?? s.title.slice(0, 24), pane: "devin", profile: s.kind === "build" ? undefined : s.kind, ageMs: now - s.createdAt, url: s.url, prUrl };
  if (!last) return { ...base, state: "starting", detail: "starting…" };
  if (ENDED.has(last.status)) return { ...base, state: "done", detail: `${last.status}${pr ? ` · #${pr.number}` : ""}${acu}` };
  if (PAUSED.has(last.status)) return { ...base, state: "idle", detail: `${last.status}${pr ? ` · PR #${pr.number}` : ""}${acu}` };
  if (stopped(last)) {
    const since = now - (s.stoppedAt ?? now);
    const head = (s.question ?? "").split("\n")[0];
    // Only a real question is owed an answer; an acknowledgement stop is idle with its last words on the row.
    if (!s.question || !wakesOnStop(s.kind, s.question)) return { ...base, state: "idle", detail: `paused · ${head || "no message"}${pr ? ` · PR #${pr.number}` : ""}${acu}` };
    return { ...base, state: "waiting", waiting: { on: "main", why: head, sinceMs: since }, detail: `waiting on main · ${head} · ${elapsed(since)}` };
  }
  return { ...base, state: "working", detail: `${pr ? `PR #${pr.number} ${last.pull_requests?.[0]?.pr_state ?? ""} · ` : ""}${last.status_detail ?? last.status}${acu}` };
}

/** The arrival checklist as code. `pr` is `gh pr view --json isDraft,headRefName,files,commits`. */
export function arrivalChecks(pr: { isDraft?: boolean; headRefName?: string; files?: Array<{ path: string }>; commits?: Array<{ authors?: Array<{ email?: string }> }> }, expect: Expect): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!pr.isDraft) failures.push("not a draft");
  if (expect.branch && pr.headRefName !== expect.branch) failures.push(`branch ${pr.headRefName} ≠ ${expect.branch}`);
  if (expect.authorEmail) for (const c of pr.commits ?? []) for (const a of c.authors ?? []) if (a.email && a.email !== expect.authorEmail) failures.push(`commit author ${a.email} ≠ ${expect.authorEmail}`);
  if (expect.filesMatch) { const re = new RegExp(expect.filesMatch); for (const f of pr.files ?? []) if (!re.test(f.path)) failures.push(`file outside /${expect.filesMatch}/: ${f.path}`); }
  return { ok: failures.length === 0, failures };
}
