/**
 * The exact text a worker receives for each console choice — the SAME wording main's TUI picker produces, so a
 * console answer and a `/crew_cli answer` are indistinguishable to the worker (design §5). Pure; no I/O.
 */
import { makeRequest, requestFromRecord, operationOf, decisionOptions, resolutionText, askFirstText, explicitDecision, type ConsultRequest, type ConsultKind, type DecisionPacket, type DecisionOption } from "../../../agent/lib/room/consult.ts";
import type { ConsultRecord } from "../../../agent/lib/database/consults.ts";

/** Rebuild the pure request from its record (classification is a function of kind + question, so it round-trips). */
export const requestOf = (r: ConsultRecord): ConsultRequest => requestFromRecord(r);

export function optionsOf(r: ConsultRecord): DecisionOption[] {
  const req = requestOf(r);
  return decisionOptions(req.classification.class, (r.packet ?? { whyHuman: req.classification.reason }) as DecisionPacket, req);
}

/** Which choices take a free-text follow-up, and what the field asks for (design §6: a question exists only under the action that needs it). */
export const FOLLOW_UP: Record<string, { label: string; required: boolean }> = {
  amend: { label: "Your amendment (relayed verbatim)", required: true },
  answer: { label: "Your explicit direction (not a bare yes)", required: true },
  ask: { label: "Your question to the worker", required: true },
  reject: { label: "Reason (one line, optional)", required: false },
};

export type Verdict = { ok: true; choice: string; text: string; wire: string } | { ok: false; error: string };

/** The answer text for a choice; `text` is the human's follow-up when the choice takes one. */
export function verdict(r: ConsultRecord, choice: string, text = ""): Verdict {
  const req = requestOf(r);
  const opts = optionsOf(r);
  const picked = opts.find((o) => o.key === choice);
  if (!picked) return { ok: false, error: `"${choice}" is not one of this consult's choices: ${opts.map((o) => o.key).join(", ")}` };
  const a = req.action;
  const actionText = a ? `${a.verb} — ${a.target}` : req.question;
  const t = text.trim();
  let out: string | undefined;
  if (picked.answer) out = picked.answer;                                            // packet option / "Get exact intent"
  else switch (choice) {
    case "approve": out = `APPROVED by Yong: ${actionText}. Do exactly this and nothing beyond it.`; break;
    case "self": out = `APPROVED by Yong: ${actionText}. Do exactly this and nothing beyond it. Yong will perform the auth step in your pane; wait for it.`; break;
    case "amend": if (!t) return { ok: false, error: "an amendment is required" }; out = `APPROVED by Yong WITH AMENDMENT — ${t}\nOriginal ask: ${actionText}. Apply the amendment exactly; nothing beyond it.`; break;
    case "answer": { const d = explicitDecision(t); if (!d) return { ok: false, error: "an explicit direction is required — a bare yes is not an answer" }; out = `DECIDED by Yong: ${d}\nOriginal request: ${req.question}`; break; }
    case "ask": if (!t) return { ok: false, error: "a question is required" }; out = askFirstText(req, t); break;
    case "later": out = `NOT NOW (Yong): do not ${actionText}. Continue other work; ask again only when told.`; break;
    case "skip": out = `SKIP (Yong): proceed without this step; mark the dependent part as not done in your report.`; break;
    case "reject": out = `REJECTED by Yong${t ? `: ${t}` : ""}. Do not ${actionText}. Keep the work on disk and report what you have.`; break;
    case "show": return { ok: false, error: "show is a console-side action (open the evidence drawer); it does not answer" };
  }
  if (!out) return { ok: false, error: `no answer text for choice "${choice}"` };
  return { ok: true, choice, text: out, wire: resolutionText({ id: r.id, actionHash: req.actionHash, by: "human", text: out, answeredAt: new Date().toISOString() }) };
}
