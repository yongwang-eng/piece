/**
 * Lane router — the recipient's rules decide (D43). Pure; no pi imports.
 *
 *   Interrupt only what needs MY action. Inform me of what I should KNOW at a boundary.
 *   Never wake me for what merely happens AROUND me.
 *
 * Rank is human > main > peer, expressed as lane choice, never as a priority number: no surveyed
 * system ranks by sender seniority (Claude Code, pi, AutoGen, MetaGPT, CAMEL — research 2026-09-10).
 * The sender's urgency is evidence, not authorization (Matrix push rules, Apple interruption levels).
 */
import type { Envelope, Lane, Presence } from "./types.ts";

export interface RecipientState {
  me: string;
  presence: Presence;
  /** id of the request/consult I am currently blocked on, if any */
  awaiting?: string;
}

/** Is this envelope addressed to me (named), as opposed to cc'd or broadcast? */
export function addressedToMe(env: Envelope, me: string): boolean {
  return env.to.includes(me);
}

export function isBroadcast(env: Envelope): boolean {
  return env.to.includes("*");
}

/**
 * May `from` address every name in `to`? One rule: talksTo absent → anyone; set → main + members whose ROLE is listed.
 * Roles, not names, so `reviewer_2` matches `reviewer` and a member joining later needs no update. Never filters
 * receiving or `notice` to `*` (ambient; asks nothing). Returns the refusal text, or undefined.
 */
export function checkTalksTo(from: { talksTo?: string[] }, to: string[], roleOf: (name: string) => string | undefined, allRoles?: Set<string>): string | undefined {
  if (!from.talksTo) return undefined;
  if (to.includes("*")) return undefined;
  // An entry matches a recipient by ROLE, or by exact NAME. `-` and `_` are the same character (yong-voice: the list said
  // `researcher_4`, the worker was `researcher-4`; nine "please relay" messages went to main). A name never stands in
  // for a role: if the entry is some member's ROLE, only that role matches — a member merely NAMED that word does not
  // (the reviewer's bypass: a member named "historian" with role implementer).
  const norm = (x: string) => x.toLowerCase().replace(/-/g, "_");
  const allowed = new Set(from.talksTo.map(norm));
  const roles = allRoles ?? new Set<string>();
  const ok = (n: string) => {
    if (n === "main") return true;
    const role = norm(roleOf(n) ?? "");
    if (allowed.has(role)) return true;                                   // by role
    const asName = norm(n);
    return allowed.has(asName) && !roles.has(asName) && roleOf(n) !== undefined;   // by exact name of a real member, not a role word
  };
  const bad = to.filter((n) => !ok(n));
  if (!bad.length) return undefined;
  return `your role may only address: main, ${from.talksTo.join(", ")} — not ${bad.join(", ")}. If you must answer them: write the answer into THEIR folder (evidence/) and \`inform\` main with the path — never route the content through main's context.`;
}

/** Only `notice` may go to `*`; a `request` to everyone is refused ("assign response narrowly; broadcast awareness"). */
export function validateAddressing(env: Envelope): string | undefined {
  if (env.to.length === 0) return "envelope has no addressee (use to:['*'] for a notice)";
  if (isBroadcast(env) && env.kind !== "notice") return `only \`notice\` may broadcast to '*' — a ${env.kind} must name its addressees`;
  if (env.from && env.to.includes(env.from)) return "self-delivery is refused";
  if (env.kind === "inform" && looksLikeCodeClaim(env.text) && !(env.cites && env.cites.length)) {
    return "an `inform` about code/state must cite an artifact (file:line, test output, report path) or be sent as `propose` (D41)";
  }
  return undefined;
}

/** Cheap heuristic: mentions a path-ish token or a test/assert/bug word. Deliberately loose; false negatives are fine. */
export function looksLikeCodeClaim(text: string): boolean {
  return /[\w./-]+\.(ts|js|mjs|py|go|rs|md|json|sql)\b|\b(test|spec|assert|fails?|bug|regression|line \d+)\b/i.test(text);
}

/**
 * The delivery table (D43 §4.3). Main's requests rank like anyone's — the room has no sender privilege.
 *
 *                        working      idle     blocked
 *  request/query → me    steer        wake     followUp
 *  inform/result → me    followUp     wake     followUp (the answer to what I await → resolve)
 *  notice / cc-only      log          log      log
 *  propose (to room)     followUp     wake     followUp
 */
export function laneFor(env: Envelope, r: RecipientState): Lane {
  const toMe = addressedToMe(env, r.me);
  if (env.kind === "notice" || !toMe) return "log";           // ambient, cc-only, or broadcast (only notice may be *)
  // The answer to what I am blocked on is not mail: it resolves the waiting call. Only an answer ADDRESSED to me —
  // a cc'd or mis-addressed reply quoting my consult id must not unblock me. A request is never an answer.
  if (r.awaiting && env.re === r.awaiting && (env.kind === "result" || env.kind === "refuse" || env.kind === "inform" || env.kind === "error")) {
    return "resolve";
  }

  const needsMyAction = env.kind === "request" || env.kind === "query";
  if (r.presence === "idle") return "wake";
  if (r.presence === "blocked" || r.presence === "stalled") return "followUp";   // a stalled turn gets no steer piled on it; queue behind
  // working
  if (needsMyAction) return "steer";
  return "followUp";                                            // inform · result · error · propose · accept · refuse
}

/** One guidance line the runtime appends to a steered request so the model finishes its step first. */
export function steerGuidance(env: Envelope): string {
  if (env.kind === "query") return "— You may finish your current step first. Reply `inform` (cite file:line) or `refuse` if outside your responsibility.";
  return "— You may finish your current step first. Reply `result`/`refuse` to the sender, or `propose` if you would do it differently.";
}

/** Attribution-first, minimal envelope header — never the sender's context (Claude Code: "not from you"). */
export function renderHeader(env: Envelope, senderRole?: string): string {
  const to = env.to.join(",");
  const re = env.re ? ` · re ${env.re}` : "";
  const task = env.task ? ` · task ${env.task}` : "";
  const role = senderRole ? ` (${senderRole})` : "";
  return `[room · ${env.kind} · from ${env.from}${role} → ${to} · #${env.seq ?? env.id.slice(0, 6)}${re}${task}]`;
}
