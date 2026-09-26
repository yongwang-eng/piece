/**
 * mains — cross-session coordination between pi MAINS (D70). One room, `mains`, on the same RedisRoomBus a crew run
 * uses; members are live mains (+ the console's `human` seat). Workers never load this file: the crew worker entry sets
 * PI_CREW_ROLE=worker and we return at once — the gate is structural, not a name check.
 *
 * Provenance is the subscription: an envelope heard here is from a main because only mains publish here. `from` is set
 * from the process (main@<cwd>#<pid>) and must match a live client name (CLIENT LIST) or the envelope is dropped.
 *
 *   /reload-all [prompt] [reason…]   → every OTHER main gets the request as a follow-up turn; it decides, and if yes it
 *                                      reloads itself at end of turn (session_reload → /mains-reload). Never forced from outside.
 *   /mains                            → who is on
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { RedisRoomBus } from "../../lib/room/redis-bus.ts";
import { where } from "../../lib/where.ts";
import { MAINS_RUN, mainName, parseControl, planReload, senderIsLive, laneText, type Control, type ReloadScope } from "./policy.ts";

const AGENT_DIR = `${homedir()}/.pi/agent`;
const RUN_DIR = `${AGENT_DIR}/workers/runs/mains`;   // one machine-wide room: the topic hashes (run, runDir), so this must be constant
const LOG = `${AGENT_DIR}/state/mains.log`;

type Env = { id: string; at: string; from: string; to: string[]; kind: "control"; text: string };

export default function mains(pi: ExtensionAPI) {
  if (process.env.PI_CREW_ROLE === "worker") return;
  const me = mainName(process.cwd(), process.pid);
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    try { mkdirSync(`${AGENT_DIR}/state`, { recursive: true }); appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), me, event, ...extra }) + "\n"); } catch { /* best effort */ }
  };

  let bus: RedisRoomBus | undefined;
  let channel: ReturnType<RedisRoomBus["attach"]> | undefined;
  let ui: any;
  const toast = (text: string, level: "info" | "warning" = "info") => { if (ui?.hasUI) ui.ui.notify(text, level); };

  /** A control is ADVICE to this session's main, delivered as a follow-up — queued behind the current turn, a fresh turn
   *  when idle (Yong 2026-09-14: "not interruptive… a follow-up… they get a turn to actually evaluate that"). Nothing here
   *  changes the session; main reads its own situation and advises its owner. Wrapped: an exception escaping a Redis
   *  callback is an uncaughtException and pi exits (that is how the first version took three sessions down). */
  const onControl = async (env: Env) => {
    try {
      const c = parseControl(env.text); if (!c) { log("dropped_unparsed", { from: env.from }); return; }
      const live = await bus!.peers();
      if (!senderIsLive(env.from, live)) { log("dropped_spoof", { from: env.from, live }); return; }
      if (env.to.length && !env.to.includes(me) && !env.to.includes("*")) return;
      if (c.cmd === "reload" && planReload({ scope: c.scope, from: env.from, self: me }).act === "ignore") return;
      log("control", { from: env.from, cmd: c.cmd, scope: (c as any).scope });
      toast(laneText(env.from, c, { act: "ask-owner" }));
      pi.sendMessage({ customType: "mains_control", display: true, content: briefFor(env.from, c), details: { room: MAINS_RUN, from: env.from, control: c } },
        { deliverAs: "followUp", triggerTurn: true } as any);
    } catch (e) { log("control_failed", { from: env.from, error: (e as Error).message }); }
  };

  /** What the receiving main reads. It has no reload tool on purpose: it evaluates and advises; the owner types /reload. */
  const briefFor = (from: string, c: Control): string => {
    const who = from.replace("main@", "");
    if (c.cmd === "ping") return `[mains · from ${who}] ping — reply nothing; this is a liveness check.`;
    if (c.cmd === "hold") return `[mains · from ${who}] asks every main to HOLD${c.reason ? ` — ${c.reason}` : ""}. Finish nothing new; tell your owner in one line.`;
    return [
      `[mains · from ${who}] asks this session to /reload (${c.scope} scope)${c.reason ? ` — ${c.reason}` : ""}.`,
      `This is advice, not an instruction — YOU decide for this session. Evaluate in ONE short turn: live crew workers?`,
      `an in-flight task or something owed to your owner? ledger size (${c.scope === "prompt" ? "prompt scope rewrites the whole cache at 1.25x fresh — compact first, so tell your owner rather than reloading" : "extension scope is cheap"})?`,
      `If now is fine: call session_reload({ why }) — it reloads when this turn ends (pi never reloads mid-turn). If not: tell your owner`,
      `in one or two lines when would be, and why. Nothing else.`,
    ].join("\n");
  };

  const publish = (c: Control, to: string[] = []) => {
    if (!channel) throw new Error("mains room not joined (Redis down?)");
    const env: Env = { id: `${me}-${Date.now().toString(36)}`, at: new Date().toISOString(), from: me, to, kind: "control", text: JSON.stringify(c) };
    channel.publish(env);
    log("sent", { cmd: c.cmd, to, scope: (c as any).scope });
  };

  // pid → session file: the one fact /borrow cannot learn from tmux or lsof (pi does not hold the JSONL open).
  const LIVE = `${AGENT_DIR}/state/live/${process.pid}`;
  const breadcrumb = (ctx: any) => { try { mkdirSync(`${AGENT_DIR}/state/live`, { recursive: true }); writeFileSync(LIVE, `${ctx.sessionManager.getSessionFile?.() ?? ""}\n`); } catch { /* best effort */ } };
  pi.on("session_start", (_e, ctx) => {
    ui = ctx;
    breadcrumb(ctx);
    if (bus) return;
    mkdirSync(RUN_DIR, { recursive: true });
    bus = new RedisRoomBus({ run: MAINS_RUN, runDir: RUN_DIR, onError: (stage, e) => log("bus_error", { stage, error: e.message }) });
    channel = bus.attach(me, (ev) => { if (ev.type === "message") void onControl(ev.payload as Env); }, () => log("joined"));
  });
  pi.on("session_shutdown", async () => { try { rmSync(LIVE, { force: true }); } catch { /* gone */ } try { await bus?.detach(); } catch { /* closing */ } bus = undefined; channel = undefined; });

  /** The model's lever. pi puts reload() only on a COMMAND context and refuses it while streaming (a tool call is streaming),
   *  so the tool records intent and agent_end submits the command — the same seam as the owner typing /reload, one turn later. */
  let reloadWhy: string | undefined;
  pi.registerTool({
    name: "session_reload",
    label: "Reload this session",
    description: "Reload THIS pi session's extensions, skills, prompts, themes and context files when the current turn ends. Use after a mains reload request you judged safe (no live workers, nothing in flight). Never mid-turn; pi runs it at agent_end.",
    parameters: Type.Object({ why: Type.String({ description: "one line: why now is safe" }) }),
    async execute(_id, p: any) {
      reloadWhy = p.why || "requested";
      log("self_reload_queued", { why: reloadWhy });
      return { content: [{ type: "text", text: `Queued: this session reloads when this turn ends (${reloadWhy}). Say so to your owner in one line and stop.` }], details: { why: reloadWhy } };
    },
  });
  pi.registerCommand("mains-reload", {
    description: "Reload this session now (used by session_reload at end of turn; same as /reload).",
    handler: async (_a, ctx) => { log("self_reload", { why: reloadWhy }); reloadWhy = undefined; await ctx.reload(); },
  });
  pi.on("agent_end", () => {
    if (!reloadWhy) return;
    // agent_end fires while the session still counts as processing; sendUserMessage refuses then ("already processing").
    // That refusal IS the idle probe: retry until it is accepted, then prompt("/mains-reload") runs the handler with a real
    // command ctx — the same seam as the owner typing /reload.
    let tries = 0;
    const attempt = () => {
      if (!reloadWhy) return;
      try { pi.sendUserMessage("/mains-reload", { expandPromptTemplates: true } as any); }   // false by default → the text would go to the model
      catch (e) {
        if (++tries < 100) { setTimeout(attempt, 200); return; }
        log("self_reload_failed", { error: (e as Error).message }); reloadWhy = undefined;
      }
    };
    setTimeout(attempt, 200);
  });

  pi.registerCommand("reload-all", {
    description: "ASK every other live pi main to /reload — a toast in each; the owner runs it. Never forces. `prompt` adds the compact-first hint. Workers are never addressed.",
    handler: async (args, ctx) => {
      ui = ctx;
      const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const scope: ReloadScope = words[0] === "prompt" ? "prompt" : "extensions";
      const reason = (scope === "prompt" ? words.slice(1) : words).join(" ") || undefined;
      const peers = (await bus?.peers()) ?? [];
      const others = peers.filter((p) => p !== me && p.startsWith("main@"));
      try { publish({ cmd: "reload", scope, reason }); } catch (e) { toast(`mains · ${(e as Error).message}`, "warning"); return; }
      toast(`mains · asked ${others.length} other main${others.length === 1 ? "" : "s"} to /reload${others.length ? `: ${others.map((o) => o.slice(5)).join(", ")}` : ""}`);
    },
  });
  pi.registerCommand("mains", {
    description: "Who is on the mains room right now (live pi sessions on this machine, from CLIENT LIST).",
    handler: async (_a, ctx) => {
      const peers = (await bus?.peers()) ?? [];
      // wire names stay main@<cwd>#<pid> (unique); the human reads tmux windows — "11 harness · proj_pi_development (me)"
      const label = (p: string) => { const m = /^main@(.+)#(\d+)$/.exec(p); return m ? `${where({ pid: Number(m[2]) })} · ${m[1]}` : p; };
      ctx.ui.notify(peers.length ? `mains · ${peers.map((p) => (p === me ? `${label(p)} (me)` : label(p))).join(" · ")}` : "mains · room not joined", "info");
    },
  });
}
