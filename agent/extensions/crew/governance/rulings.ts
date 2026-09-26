/**
 * Read-before-rule (D58). On 2026-09-11 main ruled in parallel with an OPEN human consult TWICE — items 4 and 5 — and both
 * times Yong's answer superseded the ruling and the crew redid finished, reviewed work. The second time main *did* check
 * the record first; it searched ANSWERED consults and found nothing, because the question was still sitting with Yong.
 *
 * So the fact that matters is not "what has been answered" but "what is currently ASKED": an open consult means that topic
 * belongs to whoever was asked, and main must wait rather than settle it in parallel. Propagation is not authorization
 * (historian, #685). Pure so the two incidents stay as regression tests.
 */
import { existsSync, globSync, readFileSync } from "node:fs";

export interface RulingRow { id: string; worker: string; kind?: string; at?: string; q: string; a: string }
export interface Rulings { open: RulingRow[]; human: RulingRow[]; gov: RulingRow[]; rulings: string[]; blocked: boolean; text: string }

/** Words ≤3 chars are not selective enough to narrow anything — a topic of only short words matches everything. */
const termsOf = (topic: string) => topic.toLowerCase().split(/\s+/).filter((t) => t.length > 3);

export function selectRulings(runDir: string, topic = "", planText?: string): Rulings {
  const terms = termsOf(topic);
  const hit = (text: string) => !terms.length || terms.some((t) => text.toLowerCase().includes(t));
  const open: RulingRow[] = [], human: RulingRow[] = [], gov: RulingRow[] = [];

  for (const f of globSync(`${runDir}/children/*/consults.jsonl`)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }   // a truncated last line is normal for a killed worker
      const text = `${d.question ?? ""} ${d.answer ?? ""} ${JSON.stringify(d.action ?? "")}`;
      if (!hit(text)) continue;
      const row: RulingRow = { id: d.id, worker: d.worker ?? f.split("/").at(-2) ?? "?", kind: d.kind, at: d.at, q: String(d.question ?? "").slice(0, 200), a: String(d.answer ?? "").slice(0, 200) };
      if (!d.answer) open.push(row);
      else if (d.answeredBy === "human") human.push(row);
      else gov.push(row);
    }
  }

  const rulings = (planText ?? "").split("\n").filter((l) => /\*\*(ruling|resolution|adjudication)\*\*/.test(l) && hit(l)).map((l) => l.slice(0, 300));

  const lines: string[] = [];
  if (open.length) lines.push(
    `⛔ ${open.length} OPEN consult(s) on this topic — NOT yours to rule; the question is with whoever was asked:`,
    ...open.map((o) => `   ${o.id} · ${o.worker} · ${o.kind} · asked ${o.at}\n     ${o.q}`), "");
  if (human.length) lines.push(
    `HUMAN answers (these GOVERN — a later human answer supersedes an earlier one and any main ruling):`,
    ...human.map((h) => `   ${h.id} · ${h.at}\n     Q ${h.q}\n     A ${h.a}`), "");
  if (gov.length) lines.push(`governor answers (${gov.length}):`, ...gov.map((g) => `   ${g.id} · ${g.at} · ${g.q}`), "");
  if (rulings.length) lines.push(`recorded rulings in plan.md (${rulings.length}):`, ...rulings.map((r) => `   ${r}`));
  if (!lines.length) lines.push(`nothing decided on "${topic || "(everything)"}" — no open consult, no human answer, no ruling. Safe to rule.`);

  return { open, human, gov, rulings, blocked: open.length > 0, text: lines.join("\n") };
}

export const planTextOf = (planPath?: string) => planPath && existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
