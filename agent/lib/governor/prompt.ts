/**
 * Governor prompts and reply parsing — pure, shared by every backend.
 *
 * The governor is the SUPERVISOR (D40): it answers a worker's consult on the human's behalf when the
 * constitution + run rulings + brief cover it, and ESCALATES the rest. It never approves a
 * HUMAN_REQUIRED class — that is enforced by the caller before the governor is even asked.
 */

export const GOVERNOR_SYSTEM_PROMPT = [
  "You are the GOVERNOR of a multi-agent run. Three request modes:",
  "1) Specialist WORKER agents consult you mid-task. Answer ONLY from the documents given (constitution, run rulings, the worker's brief and inbox, the room log). Relay decisions; never invent facts about systems. Reply with exactly one line: ANSWER: <instruction> or ESCALATE: <the precise question only the human can answer>.",
  "2) MAIN (the agent talking to the human) asks you for a second opinion. You are advisory, never authoritative: point at the unproven leap, the missed failure mode, the contradiction with a ruling, the thing the constitution forbids. Reply with one of: AGREE: <why> | CONCERN: <specific> | OPINION: <alternative>. Be terse and concrete.",
  "3) A PACKET request asks you to brief the human, not answer the consult. Reply with the requested JSON object instead of either one-line format above. Describe grounded alternatives only for non-human judgment classes without an explicit requested act; otherwise omit options and preserve the exact act. Recommendations are advisory, never permission.",
  "You cannot authorize anything the constitution reserves for the human (auth, credentials, notifying/publishing, irreversible actions, money, policy changes). If asked to authorize, ESCALATE; a PACKET only briefs the human who decides.",
].join("\n");

export interface GovernorReply { kind: "answer" | "escalate"; text: string }

/** `ANSWER: …` → answer · `ESCALATE: …` → escalate · anything else → escalate with the raw text (fail closed). */
export function parseReply(raw: string): GovernorReply {
  const line = raw.trim().split("\n").find((l) => /^(ANSWER|ESCALATE)\s*:/i.test(l.trim())) ?? raw.trim();
  const m = /^(ANSWER|ESCALATE)\s*:\s*(.*)$/is.exec(line.trim());
  if (!m) return { kind: "escalate", text: raw.trim() || "governor gave no parseable reply" };
  return { kind: m[1].toUpperCase() === "ANSWER" ? "answer" : "escalate", text: m[2].trim() };
}

/** Kinds that the governor may answer at all. auth/irreversible are HUMAN_REQUIRED and never reach it (D40). */
export const GOVERNOR_ANSWERABLE = new Set(["confirm", "clarify", "stuck", "query"]);

export function consultPrompt(c: { id: string | number; worker: string; kind: string; question: string; evidence?: string[] }): string {
  return [
    `# CONSULT #${c.id} from worker ${c.worker} (kind: ${c.kind})`,
    c.question.trim(),
    c.evidence?.length ? `\nevidence:\n${c.evidence.map((e) => `- ${e}`).join("\n")}` : "",
    "",
    "Reply with exactly one line: ANSWER: <instruction> | ESCALATE: <precise question for the human>",
  ].join("\n");
}

// ── HUMAN_REQUIRED: the governor does not decide, it BRIEFS the one who does (D40 "packages") ────────────────────────

export interface PacketOption { key: string; label: string; action: string; consequence: string }
export interface PacketReply {
  question?: string;
  context?: string;
  options?: PacketOption[];
  recommendedOption?: string;
  recommendation?: "approve" | "reject" | "needs-info";
  why?: string;
  checked: string[];
  risk?: string;
}

export function packetPrompt(c: { id: string | number; worker: string; kind: string; question: string; evidence?: string[]; action?: { verb: string; target: string; detail?: string } }): string {
  return [
    `A worker's consult is HUMAN-ONLY (class ${c.kind}); you may NOT answer it. Brief the human instead.`,
    `Worker: ${c.worker} · consult ${c.id}`,
    c.action ? `Action requested: ${c.action.verb} — ${c.action.target}${c.action.detail ? ` (${c.action.detail})` : ""}` : "",
    `Question: ${c.question}`,
    c.evidence?.length ? `Evidence offered: ${c.evidence.join(" · ")}` : "Evidence offered: none",
    "",
    "Reply with one JSON object (this PACKET format takes precedence over the one-line consult format):",
    '{"question":"plain-language question, one sentence","context":"why this choice matters, 1-2 sentences","options":[{"key":"stable_id","label":"at most four words","action":"exact instruction the human would authorize","consequence":"what changes, cost or trade-off"}],"recommendedOption":"option key, or omit","why":"reason for that recommendation","checked":["only relevant facts established from supplied evidence"],"risk":"what remains uncertain"}',
    "For a genuine choice, give 2-4 distinct options grounded in the request and record. Never turn an either/or into approve/reject. Do not invent alternatives or broaden the requested act. Every action is shown verbatim and sent only if the human selects it.",
    "If you cannot establish the alternatives, omit options and explain what is missing. For a single concrete permission request, omit options and use recommendation: approve|reject|needs-info with why; the existing class-specific choices remain available.",
    "If Action requested is present, always omit options: you may clarify its implications but must not replace or broaden that exact act. For auth, irreversible, notify, money, policy or scope classes, always omit options; the runtime owns those action choices and a missing exact action must be supplied by the worker, not invented by you. Do not infer permission from this briefing. Separate documented facts from uncertainty; do not claim to have inspected a file just because its path was supplied.",
  ].filter(Boolean).join("\n");
}

/** Lenient parse; a missing or garbled field is simply absent — the card says so. Never invents a recommendation.
 *  Splits on the KEYWORDS, not on newlines: the governor put all three on one line once and the card read "none". */
export function parsePacket(raw: string): PacketReply {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (json.startsWith("{")) {
    try {
      const value = JSON.parse(json);
      const out: PacketReply = { checked: Array.isArray(value.checked) ? value.checked.filter((v: unknown) => typeof v === "string") : [] };
      for (const key of ["question", "context", "why", "risk"] as const) if (typeof value[key] === "string" && value[key].trim()) out[key] = value[key].trim();
      if (["approve", "reject", "needs-info"].includes(value.recommendation)) out.recommendation = value.recommendation;
      const options = value.options;
      if (Array.isArray(options) && options.length >= 2 && options.length <= 4 &&
          options.every((o: any) => o && typeof o.key === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(o.key) &&
            [o.label, o.action, o.consequence].every((v: unknown) => typeof v === "string" && v.trim().length > 0) && o.label.trim().split(/\s+/).length <= 4) &&
          new Set(options.map((o: any) => o.key)).size === options.length && new Set(options.map((o: any) => o.label.trim())).size === options.length) {
        out.options = options.map((o: PacketOption) => ({ key: o.key, label: o.label.trim(), action: o.action.trim(), consequence: o.consequence.trim() }));
        if (out.why && out.options!.some((o) => o.key === value.recommendedOption)) out.recommendedOption = value.recommendedOption;
      }
      return out;
    } catch { return { checked: [] }; }
  }
  const out: PacketReply = { checked: [] };
  const parts = raw.split(/(?=\b(?:CHECKED|RISK|RECOMMEND)\s*:)/i);
  for (const part of parts) {
    const m = /^\s*(CHECKED|RISK|RECOMMEND)\s*:\s*([\s\S]*)$/i.exec(part); if (!m) continue;
    const v = m[2].trim().replace(/\s+/g, " ");
    if (/^checked$/i.test(m[1])) out.checked = /^nothing/i.test(v) ? [] : v.split(/\s*;\s*/).filter(Boolean);
    else if (/^risk$/i.test(m[1])) out.risk = v || undefined;
    else { const r = /^(approve|reject|needs-info)\b\s*(?:—|–|-|:)?\s*([\s\S]*)$/i.exec(v); if (r) { out.recommendation = r[1].toLowerCase() as any; out.why = r[2].trim() || undefined; } }
  }
  return out;
}
