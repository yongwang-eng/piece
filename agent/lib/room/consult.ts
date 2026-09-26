/**
 * Consults in the room — pure (no pi imports). The escalation contract is D40 (hybrid B):
 *
 *   worker ──consult──▶ main ──┬─ HUMAN_REQUIRED ─────────────────▶ the human (◆; /crew_cli answer <id>)
 *                              └─ judgment (confirm/clarify/stuck/query) ─▶ governor ─▶ ANSWER | ESCALATE ─▶ human
 *
 *   • HUMAN_REQUIRED is decided HERE, deterministically, before any model sees the consult; no model output can
 *     clear it. Classes: auth · irreversible · notify/publish/send · money · policy · scope change.
 *   • The answer is bound to the consult id (and its action hash): a bare "yes" typed anywhere resolves nothing.
 *   • Timeouts escalate, never assent. Governor SLA → human. Human silence → still blocked (+ reminder).
 *   • Budget (count + minutes) per worker per run → over budget escalates to the human with the tally.
 */
import { createHash } from "node:crypto";
import type { PacketReply } from "../governor/prompt.ts";

export type ConsultKind = "confirm" | "clarify" | "stuck" | "query" | "auth" | "irreversible" | "notify" | "money" | "policy" | "scope";

/** Kinds that are human-only by declaration. */
export const HUMAN_KINDS: ReadonlySet<ConsultKind> = new Set(["auth", "irreversible", "notify", "money", "policy", "scope"]);

/** Wording that makes a "judgment" consult human-required anyway — the class is about the ACT, not the label the worker chose. */
const HUMAN_PATTERNS: Array<[RegExp, ConsultKind]> = [
  [/\b(log ?in|sign ?in|sso|okta|mfa|otp|2fa|password|credential|api[ -]?key|token)\b/i, "auth"],
  [/\b(delete|drop|truncate|rm -rf|destroy|wipe|purge|force[- ]push|reset --hard|revoke|rotate)\b/i, "irreversible"],
  // `start|stop|restart` need an OBJECT to be an act: "start the service" is irreversible, "item 2 cannot start" is a status
  // (live 2026-09-11: a `stuck` consult about being blocked was classified irreversible because the word "start" appeared).
  [/\b(deploy|release|ship to prod|production|merge to main|publish|submit|terminate)\b/i, "irreversible"],
  [/\b(start|stop|restart)\b(?:\s+(?:the|a|an|my|our|this|that))?(?:\s+[\w./-]+){0,3}\s+(service|server|worker|job|task|deployment|instance|container|pipeline|migration|cluster|database|queue|consumer|process|daemon|crawl|run)s?\b/i, "irreversible"],
  [/\b(notify|ping|@-?mention|dm|slack|email|comment on|request (a )?review|assign|post to|announce|send (a )?message)\b/i, "notify"],
  [/\b(pay|purchase|buy|charge|invoice|billing|spend|budget increase|upgrade plan)\b/i, "money"],
  [/\b(change the (rule|policy|constitution)|amend|override the (rule|policy)|exception to)\b/i, "policy"],
  [/\b(out of scope|expand (the )?scope|beyond (my|the) (brief|task|responsibility)|take over)\b/i, "scope"],
];

export interface Classification { humanRequired: boolean; class: ConsultKind; reason: string }

export function classify(kind: ConsultKind, question: string): Classification {
  if (HUMAN_KINDS.has(kind)) return { humanRequired: true, class: kind, reason: `kind=${kind} is human-only` };
  for (const [re, cls] of HUMAN_PATTERNS) {
    const m = re.exec(question);
    if (m) return { humanRequired: true, class: cls, reason: `question mentions "${m[0]}" (${cls})` };
  }
  return { humanRequired: false, class: kind, reason: "judgment call — governor may answer from constitution/rulings/brief" };
}

/** The exact thing the worker wants to do — what the human is approving. Required for human classes; derived from the
 *  question (verb sniffed) when a worker omits it, so the card never shows a bare id. */
export interface ConsultAction { verb: string; target: string; detail?: string }

/** What exactly the human is approving — beyond the act: why, what will be true after, can it be undone, and what
 *  happens if refused. Required for human-tier kinds (`auth` needs only why + exact: a login has no undo story). */
export interface ConsultIntent { why?: string; exact?: string; effect?: string; reversible?: string; ifDenied?: string }
const INTENT_FIELDS: Array<keyof ConsultIntent> = ["why", "exact", "effect", "reversible", "ifDenied"];
const AUTH_INTENT_FIELDS: Array<keyof ConsultIntent> = ["why", "exact"];

/** The reserved room member the console joins as; a consult for Yong is a `request` addressed here (D69). */
export const HUMAN_MEMBER = "human";
export interface ConsultTurn { who: "human" | "worker"; text: string; at: string }

export interface ConsultRequest {
  id: string;                 // `c-<worker>-<roster-id>-<n>` (D50: roster IDs are not reused within a run)
  run: string;
  worker: string;
  kind: ConsultKind;
  question: string;
  evidence?: string[];
  action?: ConsultAction;
  actionExplicit?: boolean;
  intent?: ConsultIntent;
  /** The conversation under ONE act: the human's questions and the worker's replies, oldest first. The act
   *  (action, intent, actionHash) never changes inside a thread — a changed act is a NEW consult (`followUpOf`). */
  thread?: ConsultTurn[];
  /** A new consult that supersedes an earlier one because the ACT changed after a question. */
  followUpOf?: string;
  reply?: string;
  askedAt: string;
  /** sha256 of (worker · kind · normalized question) — the answer must match this hash to resolve */
  actionHash: string;
  classification: Classification;
}

export function actionHash(worker: string, kind: string, question: string): string {
  return createHash("sha256").update(`${worker}\u0000${kind}\u0000${question.replace(/\s+/g, " ").trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

export function makeRequest(p: { id: string; run: string; worker: string; kind: ConsultKind; question: string; evidence?: string[]; action?: ConsultAction; intent?: ConsultIntent; thread?: ConsultTurn[]; followUpOf?: string; reply?: string; now?: Date }): ConsultRequest {
  return {
    id: p.id, run: p.run, worker: p.worker, kind: p.kind, question: p.question, evidence: p.evidence,
    thread: Array.isArray(p.thread) && p.thread.length ? p.thread : undefined,
    followUpOf: typeof p.followUpOf === "string" && p.followUpOf ? p.followUpOf : undefined,
    reply: typeof p.reply === "string" && p.reply.trim() ? p.reply.trim() : undefined,
    action: p.action ?? deriveAction(p.kind, p.question),
    actionExplicit: !!p.action,
    intent: p.intent && typeof p.intent === "object" ? p.intent : undefined,
    askedAt: (p.now ?? new Date()).toISOString(),
    actionHash: actionHash(p.worker, p.kind, p.question),
    classification: classify(p.kind, p.question),
  };
}

export type AnsweredBy = "governor" | "human" | "two-key" | "budget" | "timeout" | "system";   // two-key: main + governor on a listed mistake-class act (D73)

export interface ConsultAnswer {
  id: string;
  actionHash: string;
  by: AnsweredBy;
  text: string;
  answeredAt: string;
}

/** A human/governor answer resolves a consult only if it names the consult AND the action hash still matches. */
export function answerMatches(req: ConsultRequest, ans: { id: string; actionHash?: string }): string | undefined {
  if (ans.id !== req.id) return `answer is for ${ans.id}, not ${req.id}`;
  if (ans.actionHash && ans.actionHash !== req.actionHash) return "action hash mismatch — the question changed since this answer was written";
  return undefined;
}

// ── budget ───────────────────────────────────────────────────────────────────

export interface Budget { maxConsults: number; maxMinutes: number }
export const DEFAULT_BUDGET: Budget = { maxConsults: 8, maxMinutes: 30 };

export function overBudget(priorCount: number, firstAskedAt: string | undefined, now: Date, b: Budget = DEFAULT_BUDGET): string | undefined {
  if (priorCount >= b.maxConsults) return `${priorCount} consults used (budget ${b.maxConsults})`;
  if (firstAskedAt) {
    const minutes = (now.getTime() - Date.parse(firstAskedAt)) / 60_000;
    if (minutes >= b.maxMinutes) return `${Math.floor(minutes)} min since first consult (budget ${b.maxMinutes})`;
  }
  return undefined;
}

// ── SLAs ─────────────────────────────────────────────────────────────────────

export const GOVERNOR_SLA_MS = 60_000;      // governor silent this long → the typed request goes to the human anyway
export const HUMAN_REMINDER_MS = 5 * 60_000; // human silent this long → remind (◆ again + notification); NEVER assent

/** The text a worker's blocking consult call receives. */
export function resolutionText(a: ConsultAnswer): string {
  const who = a.by === "human" ? "HUMAN" : a.by === "governor" ? "GOVERNOR" : a.by.toUpperCase();
  return `${who}: ${a.text}`;
}

/** A worker re-sent a consult main has ALREADY settled (the answer was published while the worker could not hear — a
 *  /reload gap). The text to deliver again, from the record; undefined while the row is still open. */
export function replayText(rec: { id: string; state: string; answeredBy: string | null; answer: string | null }): string | undefined {
  if (rec.state === "answered" && rec.answer) return resolutionText({ by: (rec.answeredBy ?? "system").split(":")[0] as AnsweredBy, text: rec.answer } as ConsultAnswer);
  if (rec.state === "withdrawn") return `SYSTEM: consult ${rec.id} was withdrawn${rec.answer ? ` (${rec.answer})` : ""}. Do NOT proceed with the action you asked about; report what you have and stop.`;
  return undefined;
}

/** Which intent fields a human-tier consult still lacks (comma list), or undefined when complete / not human-tier. */
export function intentGap(req: ConsultRequest): string | undefined {
  const cls = req.classification.class;
  if (!HUMAN_KINDS.has(cls)) return undefined;
  const need = cls === "auth" ? AUTH_INTENT_FIELDS : INTENT_FIELDS;
  const missing = need.filter((f) => !String(req.intent?.[f] ?? "").trim());
  return missing.length ? missing.join(", ") : undefined;
}

/** The hop to the human: main re-addresses the classified consult, with its briefing, to the reserved member. The
 *  worker is cc'd (it learns the ask reached Yong; cc never wakes it). The console answers with `result re:<id>`. */
export function humanRequest(req: ConsultRequest, packet: DecisionPacket): { to: string[]; cc: string[]; kind: "request"; re: string; task: "consult"; text: string; cites?: string[] } {
  const body = { id: req.id, run: req.run, worker: req.worker, kind: req.kind, class: req.classification.class, question: req.question, action: req.action, actionExplicit: req.actionExplicit, intent: req.intent, thread: req.thread, followUpOf: req.followUpOf, reply: req.reply, evidence: req.evidence, askedAt: req.askedAt, actionHash: req.actionHash, operation: operationOf(req), packet, options: decisionOptions(req.classification.class, packet, req) };
  return { to: [HUMAN_MEMBER], cc: [req.worker], kind: "request", re: req.id, task: "consult", text: JSON.stringify({ consult: body }), cites: req.evidence?.length ? req.evidence : undefined };
}

/** ACK vs OPERATE (Yong, 2026-09-14). An ACK is a decision the worker can act on alone (rm, worktree remove, commit). An
 *  OPERATION needs Yong to ACT after approving — Touch ID for a 1Password read, a browser sign-in — so main performs it
 *  and only then releases the worker. Classified from facts on the act, never judged: kind=auth, or an op:// reference. */
export interface Operation { type: "op" | "auth"; refs: string[] }
export function operationOf(req: Pick<ConsultRequest, "kind" | "question" | "action" | "intent">): Operation | undefined {
  const text = [req.question, req.action?.verb, req.action?.target, req.action?.detail, ...Object.values(req.intent ?? {})].filter(Boolean).join("\n");
  const refs = [...new Set(text.match(/op:\/\/[^\s"'`)\]]+/g) ?? [])];
  if (refs.length) return { type: "op", refs };
  if (req.kind === "auth") return { type: "auth", refs: [] };
  return undefined;
}

/** Where a human result goes. Approving an operation detours through main (it must act first); everything else — a
 *  refusal, a question, an ACK — goes straight to the worker with main on cc. A list, not a judgment. */
export function humanResultRoute(c: { worker: string; operation?: Operation | null }, choice: string | null): { to: string[]; cc: string[] } {
  if (c.operation && (choice === "approve" || choice === "amend" || choice === "self")) return { to: ["main"], cc: [] };
  return { to: [c.worker], cc: ["main"] };
}

/** The ONE result a worker gets after an operation — approved + all set, or approved + failed. Never two messages. */
export function operationDoneText(approval: string, op: Operation, outcome: { ok: true; files?: Record<string, string> } | { ok: false; error: string }): string {
  if (!outcome.ok) return `${approval}\nBUT the operation FAILED (${outcome.error}). Do NOT proceed with the act; report what you have and what you would have done.`;
  const lines = [approval, `All set — main obtained the permission.${op.type === "auth" ? " The browser identity is signed in; continue with the same session." : ""}`];
  for (const ref of op.refs) {
    const f = outcome.files?.[ref];
    if (f) lines.push(`${ref} → ${f} (use inline: "$(cat ${f})"; never echo, print or paste it; the file is removed when you report)`);
  }
  return lines.join("\n");
}

/** `HUMAN: APPROVED by Yong: …` → `APPROVED by Yong: …` (what the record stores; the wire keeps the prefix). */
export function stripWho(text: string): string { return text.replace(/^(HUMAN|GOVERNOR|BUDGET|TIMEOUT|SYSTEM):\s*/, ""); }

/** The choice a human answer encodes, from its leading verb — null when free text. */
export function humanChoice(text: string): string | null {
  const t = stripWho(text);
  if (/^APPROVED by Yong WITH AMENDMENT/.test(t)) return "amend";
  if (/^APPROVED by Yong/.test(t)) return "approve";
  if (/^REJECTED by Yong/.test(t)) return "reject";
  if (/^DECIDED by Yong/.test(t)) return "decide";
  if (/^NOT NOW/.test(t)) return "later";
  if (/^SKIP/.test(t)) return "skip";
  if (/^I'll do it/.test(t)) return "self";
  if (/^QUESTION from Yong/.test(t)) return "ask";
  return null;
}

/** "Ask first" is a VERDICT, not a side channel: a blocked worker cannot answer a query, so the call resolves with the
 *  question and the worker continues the SAME consult with its reply (`consult({re, reply})`). The act is unchanged and
 *  nothing is authorized in between; if answering the question changes the act, that is a new consult (`followUpOf`). */
export function askFirstText(req: ConsultRequest, question: string): string {
  return `QUESTION from Yong: ${question.trim()}\nNot decided. Reply with consult({ re: "${req.id}", reply: "…" }) — one honest answer, nothing else changes; you will block again on the same consult. If the answer means the ACT must change, issue a new consult with followUpOf: "${req.id}" instead. Do NOT perform the act.`;
}

/** The durable row → the in-flight request. Main rebuilds its open consults from this after a reload: the record is the
 *  truth, memory is a cache. Field names mirror `ConsultRecord` (lib/database/consults.ts) without importing it. */
export function requestFromRecord(r: { id: string; run: string; worker: string; kind: string; question: string; evidence?: string[] | null; action?: ConsultAction | null; intent?: ConsultIntent | null; thread?: ConsultTurn[] | null; followUpOf?: string | null; reply?: string | null; askedAt: number | string }): ConsultRequest {
  return makeRequest({ id: r.id, run: r.run, worker: r.worker, kind: r.kind as ConsultKind, question: r.question, evidence: r.evidence ?? undefined, action: r.action ?? undefined, intent: r.intent ?? undefined, thread: r.thread ?? undefined, followUpOf: r.followUpOf ?? undefined, reply: r.reply ?? undefined, now: new Date(r.askedAt) });
}

/** The human asked and the worker has not yet replied: the consult stays open but is not decidable. */
export function awaitingWorker(req: Pick<ConsultRequest, "thread">): boolean { return req.thread?.at(-1)?.who === "human"; }

/** The same consult with one more turn — immutable, so a recorded request is never edited in place. */
export function withTurn(req: ConsultRequest, turn: ConsultTurn): ConsultRequest & { thread: ConsultTurn[] } {
  return { ...req, thread: [...(req.thread ?? []), turn] };
}
const ASK: DecisionOption = { key: "ask", label: "Ask first", description: "Send the worker one question. It answers by re-consulting with the same request; nothing is authorized until then." };

/** What the human sees for a pending consult (one line, actionable). */
export function humanLine(req: ConsultRequest): string {
  const q = req.question.replace(/\s+/g, " ").trim();
  return `◆ ${req.worker} · ${req.id} · ${req.classification.class}: ${q.length > 140 ? q.slice(0, 139) + "…" : q}  → /crew_cli answer ${req.id} <text>`;
}

// ── the human's decision: card + options ─────────────────────────────────────────────────────────────────────────────

const VERBS = /\b(git )?(commit|push|force[- ]push|merge|rebase|delete|remove|drop|deploy|release|publish|send|post|email|notify|@mention|assign|request review|pay|purchase|login|log in|sign in|authenticate|rotate|revoke)\b/i;

/** When the worker gave no `action`, sniff the verb and use the question as the target — the card still says WHAT. */
export function deriveAction(kind: ConsultKind, question: string): ConsultAction | undefined {
  if (!HUMAN_KINDS.has(kind)) return undefined;
  const m = VERBS.exec(question);
  const verb = m ? m[0].toLowerCase().replace(/^git /, "") : kind;
  const q = question.replace(/\s+/g, " ").trim();
  return { verb, target: q.length > 160 ? q.slice(0, 159) + "…" : q, detail: undefined };
}

/** What the governor adds before escalating (D40 "packages"): not a decision, a briefing for the one who decides. */
/** Main's own judgment, written with the session's context the governor never sees. Advisory; never a decision. */
export interface Assessment { risk: "low" | "medium" | "high"; recommendation: string; why: string; by: string; at: string }

export interface DecisionPacket extends Partial<PacketReply> {
  priorDecisions?: string[];
  twoKey?: { pending: boolean; outcome?: "settled" | "escalated"; keys?: string; why: string };
  assessment?: Assessment;
  /** why the governor could not clear it itself */
  whyHuman: string;
}

export interface DecisionOption { key: string; label: string; description: string; recommended?: boolean; answer?: string }

/** Explicit acts keep class controls; advisory alternatives never replace a submitted action. */
export function decisionOptions(cls: ConsultKind, packet?: DecisionPacket, req?: ConsultRequest): DecisionOption[] {
  if (req && HUMAN_KINDS.has(cls) && !req.actionExplicit) {
    // No submitted act ⇒ nothing to APPROVE, but the human may still STATE the act in his own words (relayed verbatim,
    // a bare yes refused). Without this the only exits were "make the worker re-ask" and "no" (c-reviewer-193-1).
    return [
      { key: "answer", label: "Give direction", description: "State exactly what is authorized, in your own words — it reaches the worker verbatim. A bare yes is refused." },
      { key: "show", label: "Get exact action", description: "This human-only request is missing its submitted exact action. Ask the worker to specify the verb, target, and relevant details before authorization." },
      { key: "reject", label: "Do not proceed", description: "Decline this incomplete request. No action is authorized." },
    ];
  }
  const gap = req ? intentGap(req) : undefined;
  if (req && gap) {
    // Approval must be of a stated intent, never of a paraphrase. Resolving (not just showing) is deliberate: a blocked
    // worker cannot act on a query, so the only way it can supply the intent is to re-consult.
    return [
      { key: "intent", label: "Get exact intent", description: `This human-only request lacks its intent (${gap}). The worker is told to re-consult with it; nothing is authorized.`,
        answer: `INCOMPLETE — not decided. Re-issue this consult with \`intent\` filled in: ${gap}. State why (the goal), exact (the verbatim act), effect (what will be true afterwards, where), reversible (yes/partial/no and how), ifDenied (what you do instead). Nothing is authorized.` },
      { key: "reject", label: "Do not proceed", description: "Decline this incomplete request. No action is authorized." },
    ];
  }
  if (req && req.actionExplicit === false && !HUMAN_KINDS.has(cls) && packet?.options?.length) {
    return [
      ...packet.options.map((o) => ({ key: `choice:${o.key}`, label: o.label,
        description: `Action: ${o.action}\nImplication: ${o.consequence}`,
        recommended: !!packet.why && packet.recommendedOption === o.key,
        answer: `DECIDED by Yong: ${o.label}\nAction: ${o.action}\nImplication discussed: ${o.consequence}\nOnly the selected action is authorized; nothing beyond it.` })),
      { key: "answer", label: "Something else", description: "Give a precise direction in your own words. Nothing is authorized until you submit it." },
      { key: "show", label: "Need more evidence", description: "Inspect the evidence before choosing. The worker stays blocked." },
    ];
  }
  // Decidable = the WORKER stated the act (explicit action + complete intent, checked above). The governor's rephrased
  // question is presentation; requiring it made a card un-approvable whenever the packet had not landed yet.
  if (req && cls !== "auth" && cls !== "notify" && (!req.actionExplicit || !HUMAN_KINDS.has(req.kind))) {
    return [
      { key: "answer", label: "Give direction", description: "The alternatives are not sufficiently structured for one-click approval. Type an explicit decision; a bare yes is not an answer." },
      { key: "show", label: "Need more evidence", description: "Inspect the evidence or ask for clearer alternatives. The worker stays blocked." },
      { key: "reject", label: "Do not proceed", description: "Decline the request. The worker must not perform the proposed action." },
    ];
  }
  const rec = packet?.recommendation;
  const star = (key: string, def = false) => (rec ? (rec === "approve" && key === "approve") || (rec === "reject" && key === "reject") || (rec === "needs-info" && key === "show") : def);
  switch (cls) {
    case "notify":
      return [
        { key: "approve", label: "Send it", description: "The worker sends/pings exactly as described. This notifies a person; it cannot be unsent.", recommended: star("approve") },
        { key: "amend", label: "Edit, then send", description: "You dictate the wording; the worker sends your text verbatim." },
        ASK,
        { key: "later", label: "Not now", description: "Hold. The worker continues other work and asks again when you say." },
        { key: "reject", label: "Don't", description: "No notification. Give a one-line reason and the worker takes another route.", recommended: star("reject") },
      ];
    case "auth":
      return [
        { key: "self", label: "I'll do it", description: "You perform the login/credential step in the worker's pane yourself; the worker waits.", recommended: star("approve", true) },
        ASK,
        { key: "skip", label: "Skip this step", description: "The worker continues without it and marks the dependent part as not done." },
        { key: "reject", label: "Abort the task", description: "Stop here; the worker reports what it has.", recommended: star("reject") },
      ];
    case "money":
    case "scope":
    case "policy":
      return [
        { key: "approve", label: "Yes", description: "Approve exactly what is described, no more.", recommended: star("approve") },
        { key: "amend", label: "Yes, with a cap", description: "Approve with a limit or condition you type; the worker treats it as binding." },
        ASK,
        { key: "show", label: "Tell me more", description: "The worker stays blocked while you ask it a question or look at its evidence.", recommended: star("show") },
        { key: "reject", label: "No", description: "Decline with a one-line reason.", recommended: star("reject") },
      ];
    default: // irreversible + anything escalated
      return [
        { key: "approve", label: "Approve", description: "The worker performs exactly the action described — nothing beyond it.", recommended: star("approve") },
        { key: "amend", label: "Approve, amended", description: "Approve with a change you dictate (a commit message, a narrower file list, a condition)." },
        ASK,
        { key: "show", label: "Show me first", description: "See the diff/plan and evidence here before deciding; the worker stays blocked.", recommended: star("show") },
        { key: "reject", label: "Reject", description: "No. Give a one-line reason; the work stays on disk for you.", recommended: star("reject") },
      ];
  }
}

/** The decision card: everything a decision needs, nothing else. Plain lines; the caller paints. */
export function decisionCard(req: ConsultRequest, packet: DecisionPacket | undefined, extras?: { evidenceNotes?: string[] }): string[] {
  const options = decisionOptions(req.classification.class, packet, req);
  const lines = [`${req.worker} needs your decision · ${req.id} · ${req.classification.class}`];
  lines.push(`Question: ${packet?.question ?? req.question}`);
  if (packet?.context) lines.push("", `Context: ${packet.context}`);
  lines.push("", `Why yours: ${packet?.whyHuman ?? req.classification.reason}`);
  if (req.actionExplicit && req.action) lines.push("", `Action: ${req.action.verb} — ${req.action.target}${req.action.detail ? ` (${req.action.detail})` : ""}`);
  if (req.followUpOf) lines.push("", `Follow-up to ${req.followUpOf}${req.reply ? ` — worker's reply: ${req.reply}` : ""}`);
  if (req.thread?.length) {
    lines.push("", "Thread");
    for (const t of req.thread) lines.push(`  ${(t.who === "human" ? "you" : req.worker).padEnd(11)}${t.text}`);
  }
  if (req.intent && Object.values(req.intent).some((v) => String(v ?? "").trim())) {
    lines.push("", "Intent");
    const label: Record<keyof ConsultIntent, string> = { why: "why", exact: "exact", effect: "effect", reversible: "reversible", ifDenied: "if denied" };
    for (const f of INTENT_FIELDS) { const v = String(req.intent[f] ?? "").trim(); if (v) lines.push(`  ${label[f].padEnd(11)}${v}`); }
  }
  // Jane: evaluate FIRST, then one recommendation block as the last thing before the buttons — main's judgment on top,
  // the governor's under it — with room around it. Nothing advisory appears after the choices.
  const recommendation = options.find((o) => o.recommended);
  lines.push("", "");
  if (packet?.assessment) { const a = packet.assessment; lines.push(`▶ Main recommends: ${a.recommendation}   · risk ${a.risk.toUpperCase()}`, `  ${a.why}`); }
  lines.push(`${packet?.assessment ? "  governor" : "▶ Governor"}: ${recommendation ? `${recommendation.label}${packet?.why ? ` — ${packet.why}` : ""}` : "clarify before deciding (safe fallback; no usable recommendation provided)"}`);
  if (packet?.risk) lines.push(`  uncertainty: ${packet.risk}`);
  lines.push("");
  lines.push("", "Choices:");
  for (const option of options) lines.push("", `${option.label}${option.recommended ? " ⭐" : ""}`, option.description);
  if (packet?.checked?.length) lines.push("", `Governor checked: ${packet.checked.join(" · ")}`);
  if (packet?.priorDecisions?.length) lines.push("", `Related prior decisions (check applicability): ${packet.priorDecisions.join(" · ")}`);
  const evidence = [...(req.evidence ?? []), ...(extras?.evidenceNotes ?? [])];
  if (evidence.length) lines.push("", `Evidence: ${evidence.join(" · ")}`);
  lines.push("", `Original request: ${req.question}`);
  return lines;
}

export function explicitDecision(text: string | undefined): string | undefined {
  const value = text?.trim();
  return value && !/^(yes|ok|okay|approve|approved|sure|go ahead|do it)[.!]*$/i.test(value.replace(/\s+/g, " ")) ? value : undefined;
}

/** Board row / notification text: the ACTION in words, never the bare id. */
export function needsYouLine(req: ConsultRequest): string {
  const a = req.action ?? deriveAction(req.classification.class, req.question);
  const what = a ? `${a.verb}${a.verb === req.classification.class ? "" : ` · ${a.target.length > 60 ? a.target.slice(0, 59) + "…" : a.target}`}` : req.classification.class;
  return `needs you: ${what}`;
}

// ── the merge gate (D57): main merges; the governor authorizes it on Yong's standing ruling; the implementer never does ──

export interface SignOff {
  /** every member whose role is a reviewer-ish lens, and whether its latest verdict covers the branch's CURRENT state */
  reviewers: Array<{ name: string; verdict: "result" | "propose" | "refuse" | "none" | "stale"; seq?: number; sawAt?: string }>;
  complete: boolean;
  missing: string[];
}

/**
 * Reviewers are the members whose ROLE contains "review" or "test" — the team's shape decides the set, not a constant.
 *
 * **A commit is a checkpoint; "ready" is an event (D57).** An approval is bound to the state the reviewer saw: the review
 * `request` it answers. If a commit landed on the branch AFTER that request, the approval is **stale** — the reviewer signed
 * off on something else. No new protocol: the request's timestamp and the branch's last commit time are already recorded.
 */
export function signOff(
  members: Array<{ name: string; role?: string }>,
  verdicts: Array<{ from: string; kind: string; seq?: number; at?: string; re?: string }>,
  freshness?: { lastCommitAt?: string; requestAt?: (re: string | undefined) => string | undefined },
): SignOff {
  const lenses = members.filter((m) => /review|test/i.test(m.role ?? ""));
  const lastCommit = freshness?.lastCommitAt ? Date.parse(freshness.lastCommitAt) : undefined;
  const reviewers = lenses.map((m) => {
    const last = [...verdicts].reverse().find((v) => v.from === m.name);
    let verdict = (last?.kind === "result" || last?.kind === "propose" || last?.kind === "refuse" ? last.kind : "none") as SignOff["reviewers"][number]["verdict"];
    // the state this approval saw: the review request it answers (or, absent an `re`, the verdict's own time)
    const sawAt = (last?.re ? freshness?.requestAt?.(last.re) : undefined) ?? last?.at;
    if (verdict === "result" && lastCommit !== undefined && sawAt !== undefined && Date.parse(sawAt) < lastCommit) verdict = "stale";
    return { name: m.name, verdict, seq: last?.seq, sawAt };
  });
  const missing = reviewers.filter((r) => r.verdict !== "result").map((r) => `${r.name} (${r.verdict})`);
  return { reviewers, complete: reviewers.length >= 1 && missing.length === 0, missing };
}

/** The question main puts to the governor. It verifies preconditions; it does not decide policy — the policy is Yong's ruling. */
export function mergePrompt(p: { branch: string; repo: string; commits: Array<{ sha: string; message: string }>; sign: SignOff; suite: string }): string {
  return [
    `MERGE REQUEST — main asks you to authorize a merge on Yong's STANDING RULING for his own repo (${p.repo}).`,
    `Ruling: "in my own repo, a merge to main is pre-authorized once every reviewer in the run has signed off on the final state and the suite is green. The governor approves it on my behalf; do not wake me."`,
    `Branch: ${p.branch} → main. Commits (${p.commits.length}):`,
    ...p.commits.map((c) => `  - ${c.sha.slice(0, 7)} ${c.message}`),
    `Sign-off: ${p.sign.reviewers.map((r) => `${r.name}=${r.verdict}${r.seq ? `(#${r.seq})` : ""}`).join(" · ") || "none"}   (\`stale\` = it approved an earlier state; a commit landed after the review it answered)`,
    `Suite: ${p.suite}`,
    ``,
    `Your job is to VERIFY, not to decide policy: is every reviewer's latest verdict a \`result\`? is the suite green? do the commits match the branch named in the run's plan? Reply with exactly one line:`,
    `ANSWER: merge approved — <what you verified>`,
    `ESCALATE: <the precise thing that is missing or inconsistent>`,
  ].join("\n");
}
