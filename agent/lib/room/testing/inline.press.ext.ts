/**
 * PRESS-TEST (pi/design/crew_design/front_door.md §4): can an INLINE worker (createAgentSession in main's process) join
 * the room with ZERO room-side branching? Loaded as a throwaway extension into `pi -p` by inline.press.mjs.
 *
 * Pass = the inline child: appears on the roster (backend "inline") · answers room_who · its room_send lands on main
 * as an envelope · its consult(confirm) reaches main's intercept as a consult request and the answer resolves it.
 * Fail loudly if any step needs `if (backend === "inline")` inside lib/room.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RoomClient } from "../client.ts";
import { LocalBus } from "../local-bus.ts";
import type { Envelope } from "../types.ts";

const RUN = `press-inline-${Date.now()}`;
const RUN_DIR = `${getAgentDir()}/workers/runs/${RUN}`;
const OUT = process.env.PRESS_OUT ?? "/tmp/inline-press.json";

export default function (pi: ExtensionAPI) {
  const result: Record<string, unknown> = { run: RUN, steps: {} as Record<string, unknown> };
  const step = (k: string, v: unknown) => { (result.steps as any)[k] = v; };
  const finish = (ok: boolean, why?: string) => { result.ok = ok; if (why) result.why = why; writeFileSync(OUT, JSON.stringify(result, null, 2)); };

  pi.on("session_start", async () => {
    mkdirSync(RUN_DIR, { recursive: true });
    const bus = new LocalBus(`room/${RUN}`);
    const seenOnMain: Envelope[] = [];
    let consultReq: Envelope | undefined;
    let mainRoom!: RoomClient;

    // ── main side: same RoomClient crew uses, transport = bus ─────────────────────────────────────────────────────
    let mainOnEvent: ((ev: any) => void) | undefined;
    const mainChannel = bus.attach("main", (ev) => mainOnEvent?.(ev));
    mainRoom = new RoomClient(pi, {
      run: RUN, runDir: RUN_DIR, isMain: true, registerNow: true, channel: mainChannel,
      card: { name: "main", backend: "main" as any, role: "coordinator", responsibility: "press-test coordinator" },
      intercept: (env) => {
        seenOnMain.push(env);
        if (env.kind === "request" && env.task === "consult" && env.re) {
          consultReq = env;
          // answer exactly as crew's resolveConsult does: a result re: the consult id, addressed to the asker
          setTimeout(() => mainRoom.send({ to: [env.from], kind: "result", re: env.re!, text: "GOVERNOR: proceed — press-test answer" }), 50);
          return true;
        }
        return false;
      },
    });
    // RoomClient.register() emits the intercom event first; with `channel` set it short-circuits. Route bus events in.
    mainOnEvent = (ev) => (mainRoom as any).onEvent(ev);
    step("main_joined", mainRoom.roster().members.some((m) => m.name === "main"));

    // ── inline child ──────────────────────────────────────────────────────────────────────────────────────────────
    const name = "inline_probe";
    let childRoom: RoomClient | undefined;
    let awaiting: string | undefined;
    const pending = new Map<string, (t: string) => void>();
    const childFactory = (cpi: ExtensionAPI) => {
      let childOnEvent: ((ev: any) => void) | undefined;
      const ch = bus.attach(name, (ev) => childOnEvent?.(ev));
      childRoom = new RoomClient(cpi, {
        run: RUN, runDir: RUN_DIR, isMain: false, registerNow: true, tools: true, channel: ch,
        card: { name, backend: "inline" as any, role: "probe", responsibility: "prove an inline worker can live in the room" },
        awaiting: () => awaiting,
        onResolve: (env) => { const r = env.re ? pending.get(env.re) : undefined; if (r) r(env.text); },
      });
      childOnEvent = (ev) => (childRoom as any).onEvent(ev);
      cpi.registerTool({
        name: "consult", label: "consult", description: "ask authority; blocks",
        parameters: Type.Object({ kind: Type.String(), question: Type.String() }),
        async execute(_id, p: any) {
          const id = `c-${name}-1-1`;
          const text = await new Promise<string>((resolve) => {
            pending.set(id, (t) => { pending.delete(id); awaiting = undefined; resolve(t); });
            awaiting = id;
            childRoom!.send({ to: ["main"], kind: "request", re: id, text: JSON.stringify({ consult: { id, kind: p.kind, question: p.question } }), task: "consult" });
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve("SYSTEM: timeout"); } }, 20_000);
          });
          return { content: [{ type: "text", text }], details: {} };
        },
      });
    };

    const loader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: getAgentDir(), noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [childFactory],
      appendSystemPrompt: ["You are a probe worker in a room. Do EXACTLY: (1) call room_who; (2) call room_send with to:['main'], kind:'inform', text:'probe here: I see <N> members'; (3) call consult with kind:'confirm', question:'may I finish?'; (4) reply with the consult answer verbatim and stop."] } as any);
    await loader.reload();
    const t0 = Date.now();
    let session: any;
    try {
      session = (await createAgentSession({ cwd: "/tmp", resourceLoader: loader, sessionManager: SessionManager.inMemory("/tmp"), tools: ["room_who", "room_send", "consult"] as any })).session;
      await session.bindExtensions({ mode: "headless" });
      const models = session.modelRuntime.getAvailableSnapshot() as any[];
      const m = models.find((x) => /gpt-6-astra|gpt-5/.test(x.id)) ?? models[0];
      if (m) await session.setModel(m);
      step("child_session", { model: m ? `${m.provider}/${m.id}` : "default", ms: Date.now() - t0 });
    } catch (e) { finish(false, `createAgentSession failed: ${(e as Error).message}`); return; }

    // give the join notice a tick, then check the roster: the room must show the inline member with NO special casing
    await new Promise((r) => setTimeout(r, 300));
    const member = mainRoom.roster().members.find((m) => m.name === name);
    step("child_on_roster", member ? { backend: (member as any).backend, role: member.role, presence: member.presence } : false);
    if (!member) { finish(false, "inline child never appeared on the roster (join notice not delivered over the bus)"); session.dispose(); return; }

    // run the child's turn
    let finalText = "";
    session.subscribe((ev: any) => { if (ev.type === "message_end" && ev.message?.role === "assistant") { const c = ev.message.content; finalText = Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : String(c ?? ""); } });
    try { await session.prompt("go"); } catch (e) { step("turn_error", (e as Error).message); }
    await new Promise((r) => setTimeout(r, 300));

    const inform = seenOnMain.find((e) => e.from === name && e.kind === "inform");
    step("inform_reached_main", inform ? inform.text : false);
    step("consult_reached_main", consultReq ? { id: consultReq.re, kind: JSON.parse(consultReq.text).consult.kind } : false);
    step("consult_resolved", /GOVERNOR: proceed/.test(finalText));
    step("child_final_text", finalText.slice(0, 300));
    step("room_log_lines", mainRoom.roster().revision);
    const ok = !!member && !!inform && !!consultReq && /GOVERNOR: proceed/.test(finalText);
    finish(ok, ok ? "inline worker joined the room with zero room-side branching" : "see steps");
    session.dispose(); bus.detach(name);
  });
}
