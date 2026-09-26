/**
 * The Governor — one supervising model per process, shared by every worker backend (D19, D34, D40).
 *
 *   - a tool-less in-memory AgentSession on `settings.<key>.governorModel` (a DIFFERENT family from main is
 *     the point: a second pair of eyes, not the same eyes twice); a bad model name FAILS start, never falls back
 *   - created once even when callers race (SingleFlight); no model call until a consult arrives
 *   - every turn serialized (TurnQueue) and bounded (boundedTurn always settles)
 *   - hooks are ADDITIVE: each caller attaches its own observers (crew: board paint, usage telemetry); none owns it
 *
 * pi imports live here; the primitives are pure (./lifecycle.ts) and tested.
 */
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GovernorReset, SingleFlight, TurnQueue, TurnTally, boundedTurn, governorState, type GovernorState } from "./lifecycle.ts";
import { GOVERNOR_SYSTEM_PROMPT, consultPrompt, parseReply, packetPrompt, parsePacket, type GovernorReply, type PacketReply } from "./prompt.ts";

export { GovernorReset } from "./lifecycle.ts";
export { parseReply, consultPrompt, packetPrompt, parsePacket, GOVERNOR_ANSWERABLE, GOVERNOR_SYSTEM_PROMPT, type GovernorReply, type PacketReply } from "./prompt.ts";

export interface GovernorHooks {
  /** the session exists (subscribe to its events here — e.g. observed activity) */
  onSession?: (g: AgentSession) => void;
  onTurnStart?: (run: string) => void;
  onTurnEnd?: (run: string) => void;
  /** creation failed (a GovernorReset is not reported) */
  onInitFailed?: (reason: string) => void;
  /** any state-relevant transition; cheap to repaint on */
  onChange?: () => void;
}

export interface GovernorOptions {
  /** where settings.json lives; default getAgentDir() */
  agentDir?: string;
  /** settings path to the model, e.g. "crew.governorModel" */
  settingsKey?: string;
  /** used when the setting is absent: typically main's current model */
  fallbackModel?: () => { provider: string; id: string } | undefined;
  cwd?: () => string;
}

export function resolveModel<M extends { provider: string; id: string }>(available: M[], want: string | undefined): M | undefined {
  if (!want) return undefined;
  const found = available.find((m) => `${m.provider}/${m.id}` === want || m.id === want);
  if (found) return found;
  const list = available.map((m) => `${m.provider}/${m.id}`);
  throw new Error(`model "${want}" not found (available: ${list.slice(0, 12).join(", ")}${list.length > 12 ? `, … +${list.length - 12}` : ""})`);
}

export class Governor {
  private readonly init: SingleFlight<AgentSession>;
  private readonly queue = new TurnQueue();
  private readonly turns = new TurnTally();
  private readonly hooks = new Set<GovernorHooks>();
  private readonly o: GovernorOptions;
  modelLabel = "";

  constructor(o: GovernorOptions = {}) {
    this.o = o;
    this.init = new SingleFlight<AgentSession>(() => this.create());
  }

  /** Attach observers. Returns a detach function. Additive: several backends may listen. */
  on(h: GovernorHooks): () => void { this.hooks.add(h); return () => this.hooks.delete(h); }
  private emit<K extends keyof GovernorHooks>(k: K, ...args: any[]) { for (const h of this.hooks) { try { (h[k] as any)?.(...args); } catch { /* an observer never breaks the governor */ } } }

  state(): GovernorState { return governorState(this.init, this.turns.count(this.init.current)); }
  get session(): AgentSession | undefined { return this.init.current; }

  private modelSetting(): string | undefined {
    if (!this.o.settingsKey) return undefined;
    try {
      const s = JSON.parse(readFileSync(join(this.o.agentDir ?? getAgentDir(), "settings.json"), "utf8"));
      return this.o.settingsKey.split(".").reduce((acc: any, k) => acc?.[k], s) || undefined;
    } catch { return undefined; }
  }

  private async create(): Promise<AgentSession> {
    const cwd = this.o.cwd?.() ?? process.cwd();
    const rl = new DefaultResourceLoader({ cwd, agentDir: this.o.agentDir ?? getAgentDir(), noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, systemPrompt: GOVERNOR_SYSTEM_PROMPT });
    await rl.reload();
    const created = await createAgentSession({ cwd, resourceLoader: rl, sessionManager: SessionManager.inMemory(cwd), tools: [] });
    const g = created.session;
    const want = this.modelSetting();
    try {
      // An explicit governorModel that does not resolve is an error, never a silent fallback to main's family.
      const chosen = resolveModel(g.modelRuntime.getAvailableSnapshot() as any[], want) ?? this.o.fallbackModel?.();
      if (chosen) await g.setModel(chosen as any);
    } catch (err) {
      g.dispose();
      throw new Error(`governor ${err instanceof Error ? err.message : String(err)} — fix settings.${this.o.settingsKey ?? "<governorModel>"}`);
    }
    this.modelLabel = g.model ? `${g.model.provider}/${g.model.id}` : "?";
    this.emit("onSession", g);
    return g;
  }

  /** Create the session now (no model call). Errors are reported through onInitFailed, never thrown. */
  warm(): Promise<AgentSession | undefined> {
    const p = this.init.get(); this.emit("onChange");
    return p.then((g) => { this.emit("onChange"); return g; }, (e) => {
      this.emit("onChange");
      if (!(e instanceof GovernorReset)) this.emit("onInitFailed", String(e?.message ?? e));
      return undefined;
    });
  }

  /** One serialized, bounded governor turn. Throws if the governor cannot start. */
  turn(prompt: string, run: string): Promise<string> {
    return this.queue.run(async () => {
      const g = await this.init.get();
      this.emit("onTurnStart", run);
      this.turns.bump(g, +1); this.emit("onChange");
      try { return await boundedTurn(g, prompt); }
      finally { this.turns.bump(g, -1); this.emit("onTurnEnd", run); this.emit("onChange"); }
    });
  }

  /**
   * Adjudicate a worker's consult. `context` = constitution + run rulings + brief + inbox (+ room log), assembled by
   * the caller (each backend knows where its files are). A governor that cannot start → escalate, never throw.
   */
  /** Brief the human on a HUMAN-ONLY consult: verified facts, risk, recommendation. Never an answer. Unavailable → empty packet. */
  async packet(c: { id: string | number; run: string; worker: string; kind: string; question: string; evidence?: string[]; action?: { verb: string; target: string; detail?: string } }, context: string): Promise<PacketReply> {
    try { return parsePacket(await this.turn(`${context}\n\n${packetPrompt(c)}`, c.run)); }
    catch { return { checked: [] }; }
  }

  async ask(c: { id: string | number; run: string; worker: string; kind: string; question: string; evidence?: string[] }, context: string): Promise<GovernorReply> {
    let raw = "";
    try { raw = await this.turn(`${context}\n\n${consultPrompt(c)}`, c.run); }
    catch (e: any) { return { kind: "escalate", text: `governor unavailable (${String(e?.message ?? e).slice(0, 120)})` }; }
    return parseReply(raw || "ESCALATE: governor gave no reply");
  }

  /** Dispose and forget; the next call recreates. Detaches the queue so a wedged turn never blocks the next. */
  reset() { this.init.reset(); this.queue.reset(); this.emit("onChange"); }
}

// ── one per process ────────────────────────────────────────────────────────────
// Both backends ask the same governor: one constitution, one set of rulings, one model bill. The first caller's
// options win (settings key etc.); later callers only attach hooks. Reset by whoever clears.
let shared: Governor | undefined;
export function sharedGovernor(o?: GovernorOptions): Governor {
  if (!shared) shared = new Governor(o);
  return shared;
}
export function resetSharedGovernor() { shared?.reset(); shared = undefined; }
