// Post a `note` card (no actions) to the halo hub. The ONE notifier for "you should know" (Yong 2026-09-15: route only
// through halo pill — no macOS banner fallback): an unreachable hub is reported to `problem`, never retried, never printed.
// `postAlert` is the needs-you tier (Yong 2026-09-22: "make it bigger and eye-catching when a real-time prompt … needs my
// attention"): an `act` with no actions — the pill holds it on the working screen until the producer `retire`s it or the TTL ends.
import { readFileSync } from "node:fs";

export const HALO_HUB = "http://127.0.0.1:9901";
const SOURCES = `${process.env.HOME ?? ""}/.config/halo_pill/sources.json`;
const tokens = new Map<string, string | null>();

/** The producer's bearer from ~/.config/halo_pill/sources.json, read once per source; null when absent. */
export function producerToken(source: string, path = SOURCES): string | null {
  if (!tokens.has(source)) {
    try { tokens.set(source, (JSON.parse(readFileSync(path, "utf8")).sources as { name: string; token: string }[]).find((x) => x.name === source)?.token ?? null); }
    catch { tokens.set(source, null); }
  }
  return tokens.get(source)!;
}

export type Note = { id: string; source: string; title: string; body: string; open?: string; extra?: Record<string, unknown> };
export type Problem = (key: string, message: string, err?: unknown) => void;

export function postNote(n: Note, problem: Problem, doFetch: typeof fetch = fetch): void {
  const token = producerToken(n.source);
  if (!token) { problem("halo:token", `notice dropped — no ${n.source} token in ${SOURCES}: ${n.title}`); return; }
  const card = { v: 1, id: cardId(n.id), source: n.source, urgency: "note", title: n.title, body: n.body, ...(n.open ? { detail_url: n.open, links: [{ label: "console", url: n.open }] } : {}), ...(n.extra ?? {}) };
  doFetch(`${HALO_HUB}/v1/cards`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(card), signal: AbortSignal.timeout(2000) })
    .then((r) => { if (!r.ok) problem("halo:hub", `halo hub refused a notice (${r.status}) — ${n.title}`); })
    .catch((e) => problem("halo:hub", `halo hub unreachable at ${HALO_HUB} — notice dropped: ${n.title}`, e));
}

export type Alert = Note & { ttlMs: number };
/** An `act` with no buttons: persists on the pill until `retire` — the answer happens elsewhere (a Touch ID dialog, a tmux pane). */
export function postAlert(a: Alert, problem: Problem, doFetch: typeof fetch = fetch): void {
  const token = producerToken(a.source);
  if (!token) { problem("halo:token", `alert dropped — no ${a.source} token in ${SOURCES}: ${a.title}`); return; }
  const card = { v: 1, id: cardId(a.id), source: a.source, urgency: "act", title: a.title, body: a.body, expires_at: new Date(Date.now() + a.ttlMs).toISOString(), ...(a.open ? { detail_url: a.open } : {}), ...a.extra };
  doFetch(`${HALO_HUB}/v1/cards`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(card), signal: AbortSignal.timeout(2000) })
    .then((r) => { if (!r.ok) problem("halo:hub", `halo hub refused an alert (${r.status}) — ${a.title}`); })
    .catch((e) => problem("halo:hub", `halo hub unreachable at ${HALO_HUB} — alert dropped: ${a.title}`, e));
}
/** The producer takes its card back (the dialog closed, the prompt was answered). A miss is not a problem: the TTL is the backstop. */
export function retire(r: { id: string; source: string; reason: string }, problem: Problem, doFetch: typeof fetch = fetch): void {
  const token = producerToken(r.source);
  if (!token) return;
  doFetch(`${HALO_HUB}/v1/cards/${encodeURIComponent(cardId(r.id))}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reason: r.reason }), signal: AbortSignal.timeout(2000) })
    .catch((e) => problem("halo:hub", `halo hub unreachable at ${HALO_HUB} — retire dropped: ${r.id}`, e));
}
const cardId = (id: string) => id.replace(/[^\w:.-]/g, "_");
