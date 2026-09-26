// Same-origin under /t/<token>/ — the token is in the page URL, never in code.
export const API = "/api";

export type Option = { key: string; label: string; description: string; recommended?: boolean; answer?: string };
export type Intent = { why?: string; exact?: string; effect?: string; reversible?: string; ifDenied?: string };
export type Consult = {
  id: string; run: string; worker: string; kind: string; class: string; humanRequired: boolean; question: string;
  action: { verb: string; target: string; detail?: string } | null; evidence: string[]; intent: Intent | null;
  packet: { whyHuman?: string; recommendation?: string; why?: string; question?: string; context?: string; risk?: string; checked?: string[]; priorDecisions?: string[]; preauthorized?: string; assessment?: { risk: "low" | "medium" | "high"; recommendation: string; why: string; by: string; at: string } } | null;
  operation?: { type: "op" | "auth"; refs: string[] } | null;
  followUpOf: string | null; reply: string | null; thread: Array<{ who: "human" | "worker"; text: string; at: string }>;
  state: "open" | "answered" | "withdrawn"; askedAt: number; answeredAt: number | null; answeredBy: string | null; choice: string | null; answer: string | null; latencyMs: number | null;
  options?: Option[]; followUp?: Record<string, { label: string; required: boolean }>;
};
export type Member = { name: string; role: string; presence: string; profile?: string };
export type Crew = { id: string; slug: string; goal: string; createdAt: number; closedAt: number | null; outcome: string | null; live: boolean; status: string; owner: string | null; openCount: number; workers: number; cost: number | null; calls: number; members: Member[] };
export type State = { launch: string; open: Consult[]; crews: Crew[]; decisions: Consult[] };
export type TopoNode = { name: string; role: string; kind: "main" | "worker" | "governor" | "human"; sent: number; received: number; consults: number; talksTo?: string[] };
export type TopoEdge = { from: string; to: string; count: number; kinds: Record<string, number>; last: string };
export type Detail = Crew & { liveMembers: string[]; topology: { nodes: TopoNode[]; edges: TopoEdge[] }; roster: Array<Member & { responsibility?: string; model?: string; joinedAt?: string }>; timeline: Array<{ at: string; icon: string; text: string; worker?: string; consult?: string }>; artifacts: { dir: string; project?: string; name?: string } | null; children: string[]; usage: { totals: { calls: number; estimatedCost: number | null; totalTokens: number | null } } | null; consults: Consult[] };
export type Evidence = { brief: string | null; report: string | null; roomTail: Array<{ at: string; from: string; to: string[]; kind: string; text: string }> };

const j = async <T>(r: Response): Promise<T> => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`); return r.json(); };
export const getState = () => fetch(`${API}/state`).then((r) => j<State>(r));
export const getCrew = (run: string) => fetch(`${API}/crews/${run}`).then((r) => j<Detail>(r));
export const getEvidence = (run: string, id: string) => fetch(`${API}/consults/${run}/${id}/evidence`).then((r) => j<Evidence>(r));
export const answer = (run: string, id: string, choice: string, text?: string) =>
  fetch(`${API}/consults/${run}/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice, text }), signal: AbortSignal.timeout(10_000) })
    .then((r) => j<{ ok: true; choice: string; text: string }>(r), (e) => { throw new Error(e?.name === "TimeoutError" ? "no reply in 10 s — is the console daemon up? (pm2 crew_console)" : String(e?.message ?? e)); });

/** ONE live stream per browser, not per tab: Chrome allows 6 connections per host, and a stream per tab starved the
 *  Approve POST behind them (spinner forever). The tab holding the stream re-broadcasts events; the others listen, and
 *  any tab takes over when the holder goes away. */
const EVENTS = ["consult", "room", "state", "answered"];
export const events = (onEvent: (name: string) => void) => {
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("crew-console-events") : null;
  let es: EventSource | null = null; let claim: number | undefined; let alive = true;
  const key = "crew-console-sse-holder"; const me = Math.random().toString(36).slice(2);
  const holderAlive = () => { const v = localStorage.getItem(key); if (!v) return false; const [, at] = v.split(":"); return Date.now() - Number(at) < 6_000; };
  const hold = () => {
    if (es || !alive) return;
    localStorage.setItem(key, `${me}:${Date.now()}`);
    es = new EventSource(`${API}/events`);
    for (const n of EVENTS) es.addEventListener(n, () => { onEvent(n); bc?.postMessage(n); });
    es.addEventListener("bye", () => release());   // the server capped its streams; this tab becomes a listener/poller
    es.onerror = () => { if (es?.readyState === EventSource.CLOSED) release(); };
    claim = window.setInterval(() => localStorage.setItem(key, `${me}:${Date.now()}`), 2_000);
  };
  const release = () => { es?.close(); es = null; if (claim) clearInterval(claim); claim = undefined; if (localStorage.getItem(key)?.startsWith(me)) localStorage.removeItem(key); };
  let lastPoll = 0;
  const tick = () => {
    if (!alive) return;
    if (!es && (!bc || !holderAlive())) hold();
    if (!es && Date.now() - lastPoll > 15_000) { lastPoll = Date.now(); onEvent("poll"); }   // a listener with no live holder still refreshes
  };
  bc?.addEventListener("message", (m) => { if (!es) onEvent(String(m.data)); });
  tick(); const poll = window.setInterval(tick, 3_000 + Math.random() * 2_000);
  return () => { alive = false; es?.close(); es = null; if (claim) clearInterval(claim); clearInterval(poll); bc?.close(); if (localStorage.getItem(key)?.startsWith(me)) localStorage.removeItem(key); };
};

export const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.round(s / 60); if (m < 60) return `${m} min`; const h = Math.floor(m / 60); return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`; };
export const clock = (t: number | string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const money = (n: number | null) => (n === null ? "—" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 2 : 1)}`);
