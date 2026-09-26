/**
 * crew-console — loopback daemon (D69). One page for every crew, live and past, and the inbox where Yong answers
 * human-tier consults. Speaks the room as reserved member "human": a decision is published `result to:[worker]
 * cc:[main] re:<consult id>` on the run's Redis topic (the worker's blocking call resolves on it; main only records).
 *
 *   security  127.0.0.1 only · per-launch token in the path · Origin + Sec-Fetch-Site checked on every POST
 *   truth     agent.sqlite (consults · crews · usage); Redis is the wake-up and the delivery, never the record
 *   writes    exactly one statement: consults.answered — claimed BEFORE publishing, so two answers cannot both land
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCrewStore, agentDbPath, type CrewId } from "../../../agent/lib/database/store.ts";
import { RedisRoomBus } from "../../../agent/lib/room/redis-bus.ts";
import { createPubSub, loadPubSubConfig, type PubSub } from "../../../packages/pi-pubsub/src/index.ts";
import { HUMAN_MEMBER, awaitingWorker, operationOf, humanResultRoute } from "../../../agent/lib/room/consult.ts";
import type { Envelope } from "../../../agent/lib/room/types.ts";
import { verdict, optionsOf, requestOf, FOLLOW_UP } from "./answers.ts";
import { roster, timeline, artifacts, outcome, evidence, children, topology, ownerWindow } from "./crews.ts";
import { producerToken, makeSyncer, parseCardId, parseTwoKeyCardId } from "./halo.ts";

const HOME = process.env.HOME ?? "";
const AGENT_DIR = process.env.PI_AGENT_DIR ?? `${HOME}/.pi/agent`;
const RUNS = `${AGENT_DIR}/workers/runs`;
const LEASES = `${AGENT_DIR}/state/session-leases`;
const HOST = "127.0.0.1";
const PORT = Number(process.env.CREW_CONSOLE_PORT ?? 9900);
const LAUNCH = `${new Date().toISOString()}#${randomBytes(3).toString("hex")}`;
const ORIGIN = `http://${HOST}:${PORT}`;
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const BASE = "";
const WEB = resolve(fileURLToPath(new URL("../web/dist/", import.meta.url)));

const store = openCrewStore(agentDbPath(AGENT_DIR));
const runDir = (run: string) => `${RUNS}/${store.namespace}/${run}`;

// ── liveness: one plain client for CLIENT LIST (D68: presence is observed from the kernel, never claimed) ─────────────
let names: PubSub | undefined;
const liveNames = async (): Promise<Set<string>> => {
  try {
    if (!names) { names = createPubSub({ ...loadPubSubConfig(), clientName: "crew-console:names" }); await names.connect(); }
    return new Set(await names.clientNames());
  } catch { return new Set(); }
};
const liveMembers = (run: string, all: Set<string>) => [...all].filter((n) => n.startsWith(`crew:${run}:`)).map((n) => n.slice(`crew:${run}:`.length));

// ── the human's seat in each live room: attach lazily, keep while the run has anyone on it ────────────────────────────
const buses = new Map<string, { bus: RedisRoomBus; channel: ReturnType<RedisRoomBus["attach"]>; ready: Promise<void> }>();
const seat = (run: string) => {
  let b = buses.get(run);
  if (b) return b;
  const bus = new RedisRoomBus({ run, runDir: runDir(run), onError: (stage, e) => console.error(`[console] ${run} ${stage}: ${e.message}`) });
  let ready!: () => void; const p = new Promise<void>((r) => { ready = r; });
  const channel = bus.attach(HUMAN_MEMBER, (ev) => onRoom(run, ev.payload as Envelope), () => ready());
  b = { bus, channel, ready: p }; buses.set(run, b);
  return b;
};
const onRoom = (run: string, env: Envelope) => {
  if (!env || typeof env !== "object") return;
  // The request to the human is the wake-up; sqlite is the truth. Any traffic on a run with our seat refreshes the page.
  if (env.kind === "request" && env.to?.includes(HUMAN_MEMBER)) push("consult", { run, id: env.re });
  else if (env.kind === "result" && env.from !== HUMAN_MEMBER) push("room", { run });
};

// ── SSE ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const clients = new Set<express.Response>();
const push = (event: string, data: unknown) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };

// ── read model ───────────────────────────────────────────────────────────────────────────────────────────────────────
const crewList = async () => {
  const all = await liveNames();
  const open = store.openConsults();
  return store.listCrews().map((c) => {
    const dir = runDir(c.id);
    const live = liveMembers(c.id, all);
    const members = roster(dir);
    const openCount = open.filter((o) => o.run === c.id).length;
    const usage = (() => { try { return store.usageSummary(c.id); } catch { return null; } })();
    // A crew main has CLOSED is finished whatever the room says (main's own seat may linger); otherwise liveness decides.
    const isLive = !c.closedAt && live.length > 0;
    const status = c.closedAt ? "closed" : isLive ? (openCount ? "blocked" : live.every((n) => n === "main") ? "idle" : "working") : existsSync(dir) ? outcome(dir) : "ended";
    const owner = (() => { try { return ownerWindow(LEASES, store.getAgent(c.ownerId).sessionId); } catch { return null; } })();
    return { id: c.id, slug: c.slug, goal: c.goal, createdAt: c.createdAt, closedAt: c.closedAt, outcome: c.outcome, live: isLive, status, openCount, owner, workers: children(dir).length, cost: usage?.totals.estimatedCost ?? null, calls: usage?.totals.calls ?? 0,
      members: members.map((m) => ({ name: m.name, role: m.role, presence: live.includes(m.name) ? "present" : m.presence === "gone" ? "left" : m.presence, profile: m.profile })) };
  });
};
const stateOf = async () => {
  const open = store.openConsults().map((c) => ({ ...c, options: optionsOf(c), operation: operationOf(requestOf(c)) ?? null, followUp: FOLLOW_UP }));
  for (const c of open) { const s = seat(c.run); void s.ready; }                // hold a seat wherever a decision is pending
  return { launch: LAUNCH, open, crews: await crewList(), decisions: store.consultHistory({ limit: 200 }).filter((c) => c.state !== "open") };
};

// ── http ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
const guard: express.RequestHandler = (req, res, next) => {
  // Host pins the page to loopback names (DNS rebinding lands on the wrong Host); Origin pins every write to our own page.
  if (!HOSTS.has(req.get("host") ?? "")) { console.error(`[console] refused host=${req.get("host")}`); return res.status(421).json({ error: "misdirected" }); }
  if (req.method !== "GET") {
    const origin = req.get("origin"); const site = req.get("sec-fetch-site");
    if (!origin || !ORIGINS.has(origin) || (site && site !== "same-origin")) { console.error(`[console] refused ${req.method} ${req.path} origin=${origin} site=${site}`); return res.status(403).json({ error: "forbidden" }); }
  }
  next();
};
const api = express.Router();
api.get("/state", async (_req, res) => res.json(await stateOf()));
api.get("/events", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ launch: LAUNCH })}\n\n`);
  // Chrome allows 6 connections per host; a stream per tab starves a new tab behind them ("connecting…"). Keep at most
  // TWO streams: the oldest are told to stop (event: bye) and closed — a tab that loses its stream falls back to polling.
  clients.add(res); req.on("close", () => clients.delete(res));
  while (clients.size > 2) { const oldest = clients.values().next().value!; clients.delete(oldest); try { oldest.write("event: bye\ndata: {}\n\n"); oldest.end(); } catch { /* gone */ } }
});
api.get("/crews/:run", async (req, res) => {
  const run = req.params.run as CrewId; const dir = runDir(run);
  let crew; try { crew = store.getCrew(run); } catch { return res.status(404).json({ error: "unknown crew" }); }
  const all = await liveNames(); const live = liveMembers(run, all);
  const usage = (() => { try { return store.usageSummary(run); } catch { return null; } })();
  res.json({ ...crew, live: !crew.closedAt && live.length > 0, status: crew.closedAt ? "closed" : undefined, liveMembers: live, roster: roster(dir), timeline: timeline(dir), topology: topology(dir), artifacts: artifacts(dir), children: children(dir), usage, consults: store.consultHistory({ run }) });
});
api.get("/consults/:run/:id/evidence", (req, res) => {
  const run = req.params.run as CrewId;
  const c = store.consultHistory({ run }).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "unknown consult" });
  res.json(evidence(runDir(run), c.worker));
});
/** The one answer path — the browser and the halo callback both land here. `by` names the face for the record. */
type Answered = { status: number; body: Record<string, unknown> };
const answer = async (run: CrewId, id: string, choice: string, text: string, by: string, agent?: string): Promise<Answered> => {
  const c = store.openConsults(run).find((x) => x.id === id);
  if (!c) return { status: 409, body: { error: "not open — already answered or withdrawn" } };
  const v = verdict(c, choice, text);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const s = seat(run);
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, 4000))]);
  if (!s.bus.isConnected()) return { status: 503, body: { error: "not connected to the run's room — is Redis up and the run live?" } };
  if (awaitingWorker(c)) return { status: 409, body: { error: `waiting for ${c.worker}'s reply to your question — it is not blocked right now, so an answer would be lost` } };
  // Claim first: exactly one answer ever lands in the record; publish only after the claim. A question is a TURN under
  // the same open consult (the act is unchanged), not a settlement.
  const claimed = v.choice === "ask"
    ? store.appendConsultTurn(run, id, { who: "human", text: text.trim(), at: new Date().toISOString() })
    : store.answerConsult(run, id, { by, choice: v.choice, answer: v.text, at: Date.now(), launch: LAUNCH, agent });
  if (!claimed) return { status: 409, body: { error: "answered elsewhere a moment ago" } };
  // An OPERATION (op:// read, sign-in) is approved to MAIN, which performs Yong's part and then releases the worker.
  const route = humanResultRoute({ worker: c.worker, operation: operationOf(requestOf(c)) }, v.choice);
  const env: Envelope = { id: `human-${randomBytes(4).toString("hex")}`, run, at: new Date().toISOString(), from: HUMAN_MEMBER, ...route, kind: "result", re: id, text: v.wire };
  try { s.channel.publish(env); } catch (e) { console.error(`[console] publish failed ${run}/${id}: ${String(e)}`); return { status: 502, body: { error: "recorded, but the room publish failed — main can relay with /crew_cli answer" } }; }
  push(v.choice === "ask" ? "consult" : "answered", { run, id, choice: v.choice });
  return { status: 200, body: { ok: true, choice: v.choice, text: v.text } };
};
/** D73 veto: Yong reverses a two-key settlement. The record flips to `vetoed` and the worker gets a directed [VETO] —
 *  stop, report, wait. Nothing is undone by machinery: what to unwind is Yong's next instruction. */
const veto = async (run: CrewId, id: string, by: string): Promise<Answered> => {
  const c = store.consult(run, id);
  if (!c || c.state !== "answered" || c.answeredBy !== "two-key") return { status: 409, body: { error: "not a two-key decision" } };
  if (c.choice === "vetoed") return { status: 409, body: { error: "already vetoed" } };
  const s = seat(run);
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, 4000))]);
  if (!s.bus.isConnected()) return { status: 503, body: { error: "not connected to the run's room — is Redis up and the run live?" } };
  if (!store.vetoConsult(run, id)) return { status: 409, body: { error: "vetoed elsewhere a moment ago" } };
  const what = c.action ? `${c.action.verb} — ${c.action.target}` : c.question;
  const env: Envelope = { id: `human-${randomBytes(4).toString("hex")}`, run, at: new Date().toISOString(), from: HUMAN_MEMBER, to: [c.worker], kind: "request",
    text: `[VETO] Yong reversed the two-key decision ${id} (${what}). STOP this act now and do not continue it. If any part already happened, report exactly what — do not undo anything on your own — and wait for direction.` };
  try { s.channel.publish(env); } catch (e) { console.error(`[console] veto publish failed ${run}/${id}: ${String(e)}`); return { status: 502, body: { error: "recorded, but the room publish failed" } }; }
  console.log(`[console] veto ${run}/${id} by ${by}`);
  push("answered", { run, id, choice: "vetoed" });
  return { status: 200, body: { ok: true, choice: "vetoed" } };
};
api.post("/consults/:run/:id/veto", async (req, res) => { const r = await veto(req.params.run as CrewId, req.params.id, "human:console"); res.status(r.status).json(r.body); });
api.post("/consults/:run/:id/answer", async (req, res) => {
  const r = await answer(req.params.run as CrewId, req.params.id, String(req.body?.choice ?? ""), String(req.body?.text ?? ""), "human:console", req.get("user-agent") ?? undefined);
  res.status(r.status).json(r.body);
});
// ── halo_pill: the console is a PRODUCER (src/halo.ts). The hub's callback is its own caller class — the producer token
//    it was registered with — not a browser, so it bypasses the Origin guard and never spoofs one.
const haloToken = producerToken();
const halo = haloToken ? makeSyncer({ token: haloToken, consoleUrl: `${ORIGIN}/`, log: (l) => console.error(`[console] halo: ${l}`) }) : null;
app.post("/api/halo/callback", async (req, res) => {
  if (!haloToken || req.get("authorization") !== `Bearer ${haloToken}`) return res.status(401).json({ error: "hub token required" });
  if (req.body?.action === "expired") return res.json({ ok: true });
  const tk = parseTwoKeyCardId(String(req.body?.card_id ?? ""));
  if (tk) { const r = await veto(tk.run as CrewId, tk.id, `human:halo:${req.body?.actor?.face ?? "face"}`); return res.status(r.status === 200 ? 200 : 409).json(r.body); }
  const ref = parseCardId(String(req.body?.card_id ?? ""));
  if (!ref) return res.status(400).json({ error: "not a crew card" });
  const r = await answer(ref.run as CrewId, ref.id, String(req.body?.action ?? ""), String(req.body?.input ?? ""), `human:halo:${req.body?.actor?.face ?? "face"}`);
  res.status(r.status === 400 ? 400 : r.status === 200 ? 200 : 409).json(r.body);   // non-2xx/409 would make the hub retry a decision that cannot land
});
app.use(guard);
app.use("/api", api);
app.use(express.static(WEB, { index: false, fallthrough: true }));
// the SPA is built with relative asset URLs; under a nested route (/crews/x) they must still resolve from the token root
const indexHtml = () => existsSync(join(WEB, "index.html")) ? readFileSync(join(WEB, "index.html"), "utf8").replace("<head>", `<head><base href="/">`) : null;
app.get(/^\/(.*)?$/, (_req, res) => { const html = indexHtml(); html ? res.type("html").send(html) : res.status(200).type("text/plain").send("crew-console: web/dist not built — run `npm run build:web`"); });

// ── wake-ups: sqlite is polled cheaply; Redis traffic pushes sooner ─────────────────────────────────────────────────
let lastSig = "";
setInterval(async () => {
  try {
    const open = store.openConsults();
    const all = await liveNames();
    const sig = `${open.map((o) => o.id).join(",")}|${[...all].filter((n) => n.startsWith("crew:")).sort().join(",")}`;
    if (sig !== lastSig) { lastSig = sig; push("state", { open: open.length }); }
    for (const o of open) seat(o.run);
    if (halo) await halo.sync(open, { "◆": open.length, workers: [...all].filter((n) => n.startsWith("crew:")).length });
  } catch (e) { console.error(`[console] tick: ${String(e)}`); }
}, 2000).unref();

const server = app.listen(PORT, HOST, () => {
  const url = `${ORIGIN}/`;
  mkdirSync(`${AGENT_DIR}/state`, { recursive: true });
  writeFileSync(`${AGENT_DIR}/state/crew-console.url`, url + "\n");   // main reads this for the card + notification (P4)
  try { rmSync(`${AGENT_DIR}/state/crew-console.token`, { force: true }); } catch { /* pre-token-less launches */ }
  console.log(`crew-console ${url}`);
});
server.on("error", (e) => { console.error(`[console] listen: ${String(e)}`); process.exit(1); });
const bye = async () => { server.close(); for (const b of buses.values()) await b.bus.detach().catch(() => {}); await names?.close().catch(() => {}); store.close(); process.exit(0); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);
