/**
 * The console as a halo_pill PRODUCER (design: pi/design/halo.md §2d). Every open human-tier consult is one card on the
 * hub; the hub calls back when a face acts; the console answers through the same path the browser uses. Nothing about
 * "consult" leaks into the hub — it sees a card with actions, and reports which one was pressed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ConsultRecord } from "../../../agent/lib/database/consults.ts";
import { optionsOf, FOLLOW_UP } from "./answers.ts";

export const HUB = process.env.HALO_HUB ?? "http://127.0.0.1:9901";
const SOURCE = "pi-crew";

/** The producer token — the same file the hub reads; both are Yong's local processes. Absent ⇒ producer disabled. */
export function producerToken(path = `${homedir()}/.config/halo_pill/sources.json`): string | undefined {
  try { return (JSON.parse(readFileSync(path, "utf8")).sources as Array<{ name: string; token: string }>).find((s) => s.name === SOURCE)?.token; } catch { return undefined; }
}

export const cardId = (c: { run: string; id: string }) => `crew:${c.run}:${c.id}`;
export const parseCardId = (id: string): { run: string; id: string } | undefined => { const m = /^crew:([^:]+):(.+)$/.exec(id); return m ? { run: m[1], id: m[2] } : undefined; };
/** Main's "Decided for you" note (D73) carries one action, veto; its id is `crew-two-key:<run>:<consult>`. */
export const parseTwoKeyCardId = (id: string): { run: string; id: string } | undefined => { const m = /^crew-two-key:([^:]+):(.+)$/.exec(id); return m ? { run: m[1], id: m[2] } : undefined; };
/** A consult main is settling by two keys (D73) must not flare an `act` card — it is about to decide itself, or main
 *  will rewrite its packet (`pending: false`) and it appears on the next tick. */
export const pendingTwoKey = (c: { packet: Record<string, unknown> | null }) => (c.packet?.twoKey as { pending?: boolean } | undefined)?.pending === true;

/** Pure: the card for an open consult. Actions mirror the console's options key-for-key so a callback maps 1:1. */
export function cardOf(c: ConsultRecord, consoleUrl: string, stats: Record<string, unknown>) {
  const opts = optionsOf(c);
  const packet = (c.packet ?? {}) as { question?: string; assessment?: { risk: string; recommendation: string; why?: string } };
  // Markdown (halo §3g): the question as paragraph 1, main's assessment as a `> ` callout whose leading glyph sets the tone —
  // ✓ low · ⚠ medium · ✗ high — so the one line that says what to do is the most visible thing on the card, not the faintest.
  const a = packet.assessment;
  const glyph = a ? ({ low: "✓", medium: "⚠", high: "✗" } as Record<string, string>)[a.risk] ?? "" : "";
  const body = [packet.question ?? c.question, a ? `> ${glyph} **${a.risk}** — ${a.recommendation}${a.why ? `\n> ${a.why}` : ""}` : undefined].filter(Boolean).join("\n\n");
  return {
    v: 1 as const, id: cardId(c), source: SOURCE, urgency: "act" as const,
    title: `${c.worker} · ${c.kind}${c.action ? ` · ${c.action.verb} ${c.action.target}` : ""}`.slice(0, 140),
    body: body.slice(0, 600), format: "markdown" as const,
    detail_url: `${consoleUrl}crews/${c.run}#consults`,
    links: c.evidence.filter((e) => /^https?:\/\//.test(e)).slice(0, 4).map((url) => ({ label: url.replace(/^https?:\/\//, "").slice(0, 40), url })),
    actions: opts.slice(0, 5).map((o) => ({ id: o.key, label: o.label, style: o.recommended ? "primary" : o.key === "reject" ? "destructive" : FOLLOW_UP[o.key]?.required ? "text-input" : "default" })),
    callback_url: `${consoleUrl}api/halo/callback`,
    stats,
  };
}

/** Keeps the hub's open cards equal to the console's open consults. Posts only on change; deletes what settled. */
export function makeSyncer(deps: { token: string; consoleUrl: string; log: (l: string) => void }) {
  const posted = new Map<string, string>();   // card id → last posted signature
  const headers = { "content-type": "application/json", authorization: `Bearer ${deps.token}` };
  let warned = false;
  const call = async (method: string, path: string, body?: unknown) => {
    try { const r = await fetch(`${HUB}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2000) }); if (!r.ok && r.status !== 404) deps.log(`hub ${method} ${path} → ${r.status}`); warned = false; return r.ok; }
    catch (e) { if (!warned) { deps.log(`hub unreachable at ${HUB}: ${String(e).slice(0, 60)}`); warned = true; } return false; }
  };
  return {
    async sync(open: ConsultRecord[], stats: Record<string, unknown>) {
      const seen = new Set<string>();
      for (const c of open) {
        if (pendingTwoKey(c)) continue;
        const card = cardOf(c, deps.consoleUrl, stats); seen.add(card.id);
        const sig = JSON.stringify([card.title, card.body, card.actions, card.links]);
        if (posted.get(card.id) === sig) continue;
        if (await call("POST", "/v1/cards", card)) posted.set(card.id, sig);
      }
      for (const id of [...posted.keys()]) if (!seen.has(id)) { posted.delete(id); await call("DELETE", `/v1/cards/${encodeURIComponent(id)}`, { reason: "settled in the console or by main" }); }
      if (open.length === 0) await call("POST", "/v1/stats", stats);
    },
  };
}
