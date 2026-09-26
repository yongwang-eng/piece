/**
 * crew worker shim — loaded ONLY inside a crew worker process (`pi -e crew/runtime/worker.ts`).
 *
 * Job: when a turn ends, send the worker's final visible text to main over the room
 * as `[report from <name>@<run>]` and persist it to the run dir. The worker's model
 * never has to remember to report; main never has to poll. (Claude Code's "idle
 * notification with final answer", as a hook.)
 *
 * Env (set by crew/index.ts at spawn): PI_CREW_ROLE=worker, PI_CREW_NAME, PI_CREW_RUN,
 * PI_CREW_BRIEF.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { registerRoomCardRenderer, RoomClient, painter, cardWidth } from "../../../lib/room/client.ts";
import { RedisRoomBus } from "../../../lib/room/redis-bus.ts";
import { outlined, HEAVY, BOX, vlen } from "../../../lib/room/card.ts";
import { appendDecision } from "../../../lib/room/artifacts.ts";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ConsultKind } from "../../../lib/room/consult.ts";
import { colorFor, paneTitle, handle, needsAttention, ATTENTION } from "../../../lib/agent-ui/identity.ts";
import { fitFooter, visibleWidth, type FooterPart } from "../../../lib/agent-ui/footer-layout.ts";
import { elapsed } from "../../../lib/agent-ui/time.ts";
import { applyRoleRules, loadRoleGuard } from "../../../lib/guards/index.ts";
import { existsSync } from "node:fs";

function sessionCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const e of entries as Array<Record<string, any>>) {
    if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) total += e.message.usage?.cost?.total ?? 0;
    else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) total += e.usage.cost?.total ?? 0;
  }
  return total;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_CREW_ROLE !== "worker") return;
  const name = process.env.PI_CREW_NAME ?? "worker";
  const myId = Number(process.env.PI_CREW_ID) || undefined;
  const run = process.env.PI_CREW_RUN ?? "adhoc";
  const briefPath = process.env.PI_CREW_BRIEF ?? "";
  const childDir = briefPath ? dirname(briefPath) : "";
  const runDir = childDir ? `${childDir}/../..` : "";


  // Join the room (D42/D44): my card is my mandate, my peers' routing table, and the roster entry.
  // Main records the join; I only announce. Inbound room envelopes are lane-routed by RoomClient (D43).
  // consult: the worker's ONE question channel to authority (D40). It BLOCKS — a dependent worker may block; the
  // wait is honest, bounded and visible (presence → blocked, row ◆). The answer arrives on the `resolve` lane, bound
  // to the consult id + action hash, and becomes this tool call's result. HUMAN_REQUIRED is decided by main, not here.
  let awaitingId: string | undefined;
  const pending = new Map<string, (text: string) => void>();
  const pendingRequest = new Map<string, Parameters<RoomClient["send"]>[0]>();   // the exact request, for re-sending when main rejoins
  let consultSeq = 0;
  const CONSULT_TIMEOUT_MS = 30 * 60_000;   // the human may take a while; after this the worker gets an explicit timeout, never a yes
  let roomClient: RoomClient | undefined;
  registerRoomCardRenderer(pi, name, () => { try { return JSON.parse(readFileSync(`${runDir}/roster.json`, "utf8")); } catch { return undefined; } });

  if (runDir) {
    // The room rides pi-pubsub (local Redis). A JOIN reaches only members subscribed at that instant; main is, by
    // spawn's gate. `subscribers` on a directed message is the receipt: 1 = nobody but me heard it.
    const bus = new RedisRoomBus({ run, runDir,
      onError: (stage, e) => log("room_transport_error", { stage, error: e.message }),
      onPublish: (p: any, res) => log("room_publish", { id: p?.id, kind: p?.kind, to: p?.to, subscribers: res.subscribers, elapsedMs: res.elapsedMs }),
    });
    const client = roomClient = new RoomClient(pi, { run, runDir, isMain: false, tools: true, bus,
      awaiting: () => awaitingId,
      onResolve: (env) => { const r = env.re ? pending.get(env.re) : undefined; if (r) r(env.text); },
      // Pub/Sub is live-only and main's open-consult table is memory: a request published while main was between
      // shutdown and re-adopt (a /reload) reached nobody, and the worker would sit its full 30-min timeout. The worker
      // is the side that still knows it is waiting — on main's (re)join notice it re-sends the SAME request (same id, so
      // main's dedupe/answer path key on it).
      observe: (env) => {
        if (env.kind !== "notice" || env.from !== "room" || env.re !== "main" || !/^evt-(re)?joined-/.test(env.id)) return;
        for (const [id, req] of pendingRequest) { try { client.send(req); log("consult_resent", { id, why: "main rejoined" }); } catch (e) { log("consult_resend_failed", { id, error: (e as Error).message }); } }
      },
      card: {
        name, id: myId, backend: "crew", profile: process.env.PI_CREW_PROFILE || undefined,
        role: process.env.PI_CREW_ROLE_LINE || process.env.PI_CREW_PROFILE || "worker",
        responsibility: process.env.PI_CREW_RESPONSIBILITY || "", cwd: process.cwd(), pane: process.env.TMUX_PANE, address: `redis:${name}`,
        talksTo: process.env.PI_CREW_TALKS_TO ? process.env.PI_CREW_TALKS_TO.split(",").filter(Boolean) : undefined,
      } });

    // decide — the worker's "what I decided and why", appended to its vault decisions.md (reverse-chron). Not a message:
    // nobody is woken; it is the record a human (or the from-scratch auditor) reads later.
    const artifactsDir = process.env.PI_CREW_ARTIFACTS || "";
    if (artifactsDir) pi.registerTool({
      name: "decide",
      label: "Decide",
      description: "Record a non-obvious choice you made: WHAT you decided, WHY, what you chose it over, and the evidence. Appends to your decisions.md in the run's vault folder. Use it instead of explaining the choice in prose; a reviewer or a future run reads this file.",
      parameters: Type.Object({
        what: Type.String({ description: "the decision, one line" }),
        why: Type.String({ description: "the reason — the invariant or constraint that forced it" }),
        alternatives: Type.Optional(Type.String({ description: "what you chose it over, and why not" })),
        evidence: Type.Optional(Type.Array(Type.String({ description: "file:line · test output path · room seq" }))),
      }),
      async execute(_id, p: any) {
        try { appendDecision(artifactsDir, { what: p.what, why: p.why, alternatives: p.alternatives, evidence: p.evidence }); log("decided", { what: String(p.what).slice(0, 80) }); }
        catch (e) { return { content: [{ type: "text", text: `decide failed: ${(e as Error).message}` }], details: {}, isError: true } as any; }
        return { content: [{ type: "text", text: `recorded → ${artifactsDir}/decisions.md` }], details: { what: p.what } };
      },
      renderCall(args: any, theme: any) {
        const W = cardWidth(0);
        const capPlain = `✎ decide`;
        const cap = `${theme.fg("accent", "✎")} ${theme.bold("decide")}`;
        const rows: Array<{ text: string; plain?: string }> = [{ text: theme.bold(String(args.what ?? "")), plain: String(args.what ?? "") }, { text: `${theme.fg("muted", "why")} ${args.why ?? ""}`, plain: `why ${args.why ?? ""}` }];
        if (args.alternatives) rows.push({ text: `${theme.fg("muted", "instead of")} ${args.alternatives}`, plain: `instead of ${args.alternatives}` });
        return new Text(outlined(cap, vlen(capPlain), rows, W, painter(theme, "accent"), BOX).join("\n"), 0, 0);
      },
      renderResult(result: any, options: any, theme: any) { return new Text(theme.fg("dim", `  ↳ ${result.content?.[0]?.text ?? ""}`), options.outputPad ?? 0, 0); },
    });

    // progress: the milestone I REPORT, kept apart from the activity main OBSERVES. One call per meaningful step; the board
    // row shows the latest; `share` lets a finding reach main now (collaborative mode). Never blocks, never authorizes.
    pi.registerTool({
      name: "progress",
      label: "Progress",
      description:
        "Report a milestone to main's board: `phase` = what you are doing now, in ≤8 words (\"reviewing diff · 3/6 files\"). Call it when the phase CHANGES, when you learn something that " +
        "changes the plan (`finding`, with `evidence`), and when you decide what comes next (`next`). Not a heartbeat — never call it just because time passed. " +
        "`share: true` only in collaborative mode (your brief says `updates: collaborative`) and only for a finding main should hear before your report; it is an FYI, never a question — questions go to `consult`. " +
        "Progress is not your report and grants nothing.",
      parameters: Type.Object({
        phase: Type.String({ description: "what you are doing now, ≤8 words" }),
        finding: Type.Optional(Type.String({ description: "something learned that matters — one sentence" })),
        next: Type.Optional(Type.String({ description: "the next step, one line" })),
        evidence: Type.Optional(Type.Array(Type.String({ description: "file:line · test output · room seq" }))),
        share: Type.Optional(Type.Boolean({ description: "collaborative mode: main should hear this finding now" })),
      }),
      async execute(_id, p: any) {
        if (!roomClient) return { content: [{ type: "text", text: "not in a room yet" }], details: {}, isError: true } as any;
        try { roomClient.send({ to: ["main"], kind: "notice", task: "progress", text: JSON.stringify({ phase: p.phase, finding: p.finding, next: p.next, evidence: p.evidence, share: p.share === true }) }); }
        catch (e) { return { content: [{ type: "text", text: `not sent: ${(e as Error).message}` }], details: {}, isError: true } as any; }
        log("progress", { phase: String(p.phase).slice(0, 80), finding: !!p.finding, share: p.share === true });
        return { content: [{ type: "text", text: `noted · ${p.phase}${p.share ? " · shared with main" : ""}` }], details: { phase: p.phase } };
      },
      renderCall(args: any, theme: any) {
        const bits = [theme.bold(String(args.phase ?? ""))];
        if (args.finding) bits.push(theme.fg("muted", `found: ${args.finding}`));
        if (args.next) bits.push(theme.fg("dim", `→ ${args.next}`));
        return new Text(`${theme.fg("accent", "◆")} ${bits.join(theme.fg("dim", " · "))}${args.share ? theme.fg("warning", " · shared") : ""}`, 0, 0);
      },
      renderResult(result: any, options: any, theme: any) { return new Text(theme.fg("dim", `  ↳ ${result.content?.[0]?.text ?? ""}`), options.outputPad ?? 0, 0); },
    });
    pi.registerTool({
      name: "consult",
      label: "Consult",
      description:
        "Ask authority a question you cannot answer from your brief, the room, or a sibling. kind: `confirm` (is this OK?) · `clarify` (which of these?) · `stuck` (I cannot proceed because…) · " +
        "`query` (a fact only main knows) — these may be answered by the governor from the constitution and rulings. `auth` (a login/credential screen) · `irreversible` (delete/deploy/publish/start/stop) · " +
        "`notify` (message/ping/assign/review-request anyone) · `money` · `policy` · `scope` — these ALWAYS go to the human; wait for them. This call BLOCKS until answered; the answer starts with GOVERNOR: or HUMAN:. " +
        "Ask a sibling (room_who / room_send query) BEFORE consulting. One question per call; include evidence paths.",
      parameters: Type.Object({
        kind: Type.Optional(Type.Union(["confirm", "clarify", "stuck", "query", "auth", "irreversible", "notify", "money", "policy", "scope"].map((k) => Type.Literal(k)) as any, { description: "required for a new consult; omitted on a `re` reply" })),
        question: Type.Optional(Type.String({ description: "required for a new consult; omitted on a `re` reply" })),
        evidence: Type.Optional(Type.Array(Type.String())),
        action: Type.Optional(Type.Object({ verb: Type.String({ description: "commit · push · delete · send · deploy · login · …" }), target: Type.String({ description: "what exactly: branch/files, recipient, resource" }), detail: Type.Optional(Type.String({ description: "message text, file list, amount — whatever the human is approving verbatim" })) }, { description: "REQUIRED for auth/irreversible/notify/money/policy/scope: the exact act. The human approves THIS, not the prose." })),
        intent: Type.Optional(Type.Object({
          why: Type.String({ description: "the goal this act serves, tied to your brief — one sentence" }),
          exact: Type.String({ description: "the verbatim act: the command / HTTP request / message text / file list" }),
          effect: Type.Optional(Type.String({ description: "what will be true afterwards, and where (env, account, repo)" })),
          reversible: Type.Optional(Type.String({ description: "yes | partial | no — and how (the undo command, or 'cannot')" })),
          ifDenied: Type.Optional(Type.String({ description: "what you will do instead / what stays undone" })),
        }, { description: "REQUIRED for auth/irreversible/notify/money/policy/scope (auth: why + exact suffice). Without it the human is offered no Approve — only 'Get exact intent', which sends you back here." })),
        re: Type.Optional(Type.String({ description: "after 'QUESTION from Yong' on consult <id>: continue THAT consult — pass its id here with `reply`; kind/question/action/intent are ignored (the act is unchanged) and you block again on the same consult" })),
        reply: Type.Optional(Type.String({ description: "your one honest answer to Yong's question (with `re`)" })),
        followUpOf: Type.Optional(Type.String({ description: "ONLY when answering Yong's question means the ACT itself must change: a NEW consult (full kind/action/intent) that supersedes <id>" })),
      }),
      async execute(_id, p: any): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
        // #N never reuses within a run (D47), so it scopes the counter; a guessed fallback id could alias another lifetime's consult.
        if (!myId || !Number.isSafeInteger(myId) || myId < 1) {
          const message = "Cannot issue consult: PI_CREW_ID must be a positive roster ID; fix the worker spawn.";
          reportToMain("error", "aborted", message, elapsed(Date.now() - startedAt));
          throw new Error(message);
        }
        const continuing = typeof p.re === "string" && p.re.startsWith(`c-${name}-${myId}-`) && typeof p.reply === "string" && p.reply.trim();
        const id = continuing ? p.re : `c-${name}-${myId}-${++consultSeq}`;
        if (!continuing && p.re) return { content: [{ type: "text", text: `SYSTEM: \`re\` must be one of YOUR consult ids (c-${name}-${myId}-N) and \`reply\` must be non-empty. Nothing sent.` }], details: { consult: null } };
        if (!continuing && (!p.kind || !p.question)) return { content: [{ type: "text", text: "SYSTEM: a new consult needs `kind` and `question`. Nothing sent." }], details: { consult: null } };
        const text = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => { pending.delete(id); pendingRequest.delete(id); if (awaitingId === id) awaitingId = undefined; resolve("TIMEOUT: no answer within 30 min. Do NOT proceed with the action you asked about; report what you have and stop."); }, CONSULT_TIMEOUT_MS);
          pending.set(id, (t) => { clearTimeout(timer); pending.delete(id); pendingRequest.delete(id); if (awaitingId === id) awaitingId = undefined; setPresence("working"); resolve(t); });
          awaitingId = id; setPresence("blocked");
          try {
            const consult = continuing ? { id, re: id, reply: p.reply.trim() } : { id, kind: p.kind, question: p.question, evidence: p.evidence ?? [], action: p.action, intent: p.intent, followUpOf: p.followUpOf };
            const req: Parameters<RoomClient["send"]>[0] = { to: ["main"], kind: "request", re: id, text: JSON.stringify({ consult }), task: "consult" };
            pendingRequest.set(id, req);
            client.send(req);
            log(continuing ? "consult_replied" : "consult_asked", { id, kind: p.kind });
          } catch (e) { clearTimeout(timer); pending.delete(id); pendingRequest.delete(id); awaitingId = undefined; resolve(`SYSTEM: consult could not be sent (${(e as Error).message}) — stop and report.`); }
        });
        log("consult_answered", { id, by: text.split(":")[0] });
        // D40 bound approval → the guard may admit exactly this act, this turn. Cleared at agent_end so it never leaks.
        if (/^HUMAN:\s*APPROVED/i.test(text) && p.action?.verb) guardState.approvedAction = `${p.action.verb} — ${p.action.target}`;
        return { content: [{ type: "text", text }], details: { consult: id, kind: p.kind, question: p.question, action: p.action, answeredBy: text.split(":")[0] } };
      },
      // HEAVY frame: the one thing in the pane that stops the worker. Asked = amber ◆; answered = green ✓ / red ✗ by who answered.
      renderCall(args: any, theme: any) {
        const W = cardWidth(0);
        const capPlain = `◆ consult · ${args.kind}`;
        const cap = `${theme.fg("warning", "◆")} ${theme.bold("consult")} ${theme.fg("warning", `· ${args.kind}`)}`;
        const rows: Array<{ text: string; plain?: string }> = [{ text: String(args.question ?? "") }];
        if (args.action) rows.unshift({ text: `${theme.fg("accent", theme.bold("Action"))}${theme.fg("dim", ":")} ${args.action.verb} — ${args.action.target}${args.action.detail ? ` (${args.action.detail})` : ""}`, plain: `Action: ${args.action.verb} — ${args.action.target}${args.action.detail ? ` (${args.action.detail})` : ""}` });
        const p = painter(theme, "warning"); p.border = (s: string) => theme.fg("warning", s);
        return new Text(outlined(cap, vlen(capPlain), rows, W, p, HEAVY).join("\n"), 0, 0);
      },
      renderResult(result: any, options: any, theme: any) {
        const d = result.details ?? {}; const text = result.content?.[0]?.text ?? "";
        const by = String(d.answeredBy ?? "").toUpperCase();
        const bad = /^(TIMEOUT|SYSTEM)/.test(by) || /REJECTED|NOT NOW|do not proceed/i.test(text);
        const tone = bad ? "error" : "success"; const glyph = bad ? "✗" : "✓";
        const W = cardWidth(options.outputPad ?? 0);
        const who = by === "HUMAN" ? "Yong" : by === "GOVERNOR" ? "governor" : by.toLowerCase() || "answer";
        const capPlain = `${glyph} ${who} answered · ${d.consult ?? ""}`;
        const cap = `${theme.fg(tone, glyph)} ${theme.bold(who)} ${theme.fg(tone, "answered")} ${theme.fg("dim", `· ${d.consult ?? ""}`)}`;
        const body = text.replace(/^(HUMAN|GOVERNOR|TIMEOUT|SYSTEM|BUDGET)\s*:\s*/i, "");
        const p = painter(theme, tone); p.border = (s: string) => theme.fg(tone, s);
        return new Text(outlined(cap, vlen(capPlain), [{ text: body }], W, p, HEAVY).join("\n"), options.outputPad ?? 0, 0);
      },
    });
  }

  // ── identity: the loudest thing in the pane, same colour everywhere (lib/agent-ui/identity) ──
  const myRole = process.env.PI_CREW_ROLE_LINE || process.env.PI_CREW_PROFILE || "worker";
  const myModel = process.env.PI_CREW_MODEL || undefined;
  const startedAt = Date.now();
  let toolsTotal = 0;
  let myPresence = "starting";
  let preCompactionPresence: "working" | "idle" | undefined;
  let uiCtx: any;
  const hexToAnsi = (hex: string, bg = false) => `\x1b[${bg ? 48 : 38};2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
  const identity = () => ({ id: myId, name, role: myRole, presence: myPresence, run, model: myModel, tools: toolsTotal, elapsedText: elapsed(Date.now() - startedAt) });
  const paintTitle = () => { try { uiCtx?.ui?.setTitle?.(paneTitle(identity())); } catch { /* cosmetic */ } };
  const setPresence = (p: string) => { if (myPresence === p) return; myPresence = p; paintTitle(); };

  pi.on("session_start", (_e, ctx: any) => {
    uiCtx = ctx;
    if (!ctx.hasUI) return;
    paintTitle();
    // Main's footer shape (compact-footer): handle · model · context bar · cost · turns · uptime. Quiet — the tab is the highlight.
    ctx.ui.setFooter((tui: any, theme: any) => ({
      invalidate() {},
      dispose() {},
      render(width: number): string[] {
        const i = identity();
        const usage = ctx.getContextUsage?.(); const used = usage?.tokens ?? 0; const limit = ctx.model?.contextWindow ?? 0;
        const pct = limit > 0 ? (used / limit) * 100 : 0;
        const ctxColor = pct >= 85 ? "error" : pct >= 60 ? "warning" : "success";
        const human = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
        const bar = "▓".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
        const contextFull = `${bar} ${pct.toFixed(0)}% (${human(used)}/${human(limit)})`;
        const cost = sessionCost(ctx.sessionManager?.getEntries?.() ?? []);
        const hex = needsAttention(i.presence) ? ATTENTION : colorFor(i.id, i.name);
        const parts: FooterPart[] = [
          { key: "handle", variants: [`${hexToAnsi(hex)}\x1b[1m${handle(i)}\x1b[0m`], required: true },
          { key: "model", variants: [theme.bold(theme.fg("muted", (i.model ?? ctx.model?.id ?? "no-model").replace(/^[^/]+\//, "")))], required: true },
          { key: "context", variants: [contextFull, `${bar} ${pct.toFixed(0)}%`, `${pct.toFixed(0)}%`].map((t) => `\x1b[2m${theme.fg(ctxColor, t)}\x1b[22m`), required: true },
          { key: "cost", variants: [theme.fg("dim", `$${cost.toFixed(2)}`)] },
          { key: "turns", variants: [theme.fg("dim", `${turns} turn${turns === 1 ? "" : "s"}`)] },
          { key: "uptime", variants: [theme.fg("dim", `↑ ${i.elapsedText}`)] },
        ];
        return [fitFooter(parts, width, { separator: theme.fg("dim", " │ "), measure: visibleWidth, truncate: (t: string, w: number) => t.slice(0, Math.max(0, w - 1)) + theme.fg("dim", "…") })];
      },
    }));
    setInterval(() => { try { uiCtx?.ui?.requestRender?.(); } catch { /* */ } }, 5_000).unref?.();
  });
  let turns = 0;
  let firstTokenStartedAt: number | undefined;
  const firstTokenSamples: number[] = [];
  const firstTokenMedian = () => {
    if (firstTokenSamples.length < 3) return undefined;
    const sorted = [...firstTokenSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  // Board status, the shape the board already reads: idle · thinking · tool:<name>. Published on change only.
  let wireStatus = "";
  const publishStatus = (status: string) => {
    if (status === wireStatus) return; wireStatus = status;
    try { roomClient?.send({ to: ["main"], kind: "notice", task: "state", text: status }); } catch { /* best effort; main's liveness check is CLIENT LIST, not this */ }
  };
  pi.on("agent_start", () => publishStatus("thinking"));
  pi.on("tool_execution_start", (ev: any) => publishStatus(`tool:${ev?.toolName ?? "?"}`));
  pi.on("tool_execution_end", () => publishStatus("thinking"));
  pi.on("agent_end", () => publishStatus("idle"));
  pi.on("agent_start", () => { firstTokenStartedAt = Date.now(); setPresence("working"); });
  pi.on("agent_end", () => { firstTokenStartedAt = undefined; turns++; setPresence("idle"); delete guardState.approvedAction; });
  pi.on("message_update", (event) => {
    if (firstTokenStartedAt === undefined || !["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)) return;
    firstTokenSamples.push(Math.max(0, Date.now() - firstTokenStartedAt));
    if (firstTokenSamples.length > 20) firstTokenSamples.shift();
    firstTokenStartedAt = undefined;
    sendVitals(true);
  });
  const compactionPresence = (state: "compacting" | "restored", prior: "working" | "idle") => {
    try { roomClient?.send({ to: ["main"], kind: "notice", task: "presence", text: JSON.stringify({ state, prior }) }); } catch { /* best effort */ }
  };
  pi.on("session_before_compact", () => {
    if (preCompactionPresence !== undefined) return;
    preCompactionPresence = myPresence === "working" ? "working" : "idle";
    setPresence("compacting");
    compactionPresence("compacting", preCompactionPresence);
  });
  const restoreCompactionPresence = () => {
    if (preCompactionPresence === undefined) return;
    const prior = preCompactionPresence;
    preCompactionPresence = undefined;
    setPresence(prior);
    compactionPresence("restored", prior);
  };
  pi.on("session_compact", restoreCompactionPresence);
  pi.on("session_compact_failed", (event) => {
    restoreCompactionPresence();
    try { roomClient?.send({ to: ["main"], kind: "notice", task: "compact_failed", text: JSON.stringify({ errorMessage: event.errorMessage, aborted: event.aborted }) }); } catch { /* best effort */ }
  });
  // Vitals → main as a log-only notice (no turn, no card) whenever context % crosses a 5-point step. Main uses it for
  // the pressure steer (checkpoint + /compact at 60 %) and to explain a stall ("silent at 71 % = prefill, not death").
  let lastVitalsStep = -1;
  const sendVitals = (force = false) => {
    const c = uiCtx as any; const usage = c?.getContextUsage?.(); const used = usage?.tokens ?? 0; const limit = c?.model?.contextWindow ?? 0;
    if (!limit || !roomClient) return;
    const pct = Math.round((used / limit) * 100); const step = Math.floor(pct / 5);
    if (!force && step === lastVitalsStep) return; lastVitalsStep = step;
    try { roomClient.send({ to: ["main"], kind: "notice", task: "vitals", text: JSON.stringify({ contextPct: pct, tools: toolsTotal, turns, model: myModel, firstTokenMedianMs: firstTokenMedian() }) }); } catch { /* best effort */ }
  };
  pi.on("tool_execution_end", () => sendVitals());
  pi.on("agent_end", () => sendVitals());
  pi.on("tool_execution_end", () => { toolsTotal++; });

  let turnText = "";
  let turnTools = 0;
  let turnStop = "";
  let turnError = "";
  let faultPending = process.env.PI_CREW_FAULT === "dead_request";
  let turnStartedAt = Date.now();
  /** end-of-turn report as a room envelope (card: `beta · reviewer ▸ done · 3 tools · 41s`). The room is the only path:
   *  if it is down the failure is logged, not hidden behind a second transport. */
  const reportToMain = (kind: "result" | "inform" | "error", report: "done" | "aborted", text: string, elapsedText: string, verdict?: { stop: string; error: string; contextPct?: number }) => {
    try { roomClient?.send({ to: ["main"], kind, text, ...( { report, tools: turnTools, elapsedText, verdict } as any) }); }
    catch (e) { log("report_delivery_failed", { error: (e as Error).message }); }
  };   // last assistant stopReason: stop | aborted | error | …
  let turnOrigin: "main" | "human" | "harness" | "unknown" = "unknown";

  const log = (event: string, extra: Record<string, unknown> = {}) => {
    if (!childDir) return;
    try {
      mkdirSync(`${childDir}/../..`, { recursive: true });
      appendFileSync(`${childDir}/../../log.jsonl`, JSON.stringify({ at: new Date().toISOString(), actor: "worker", worker: name, run, event, ...extra }) + "\n");
    } catch { /* logging never breaks the worker */ }
  };

  if (process.env.PI_CREW_FAULT !== undefined && process.env.PI_CREW_FAULT !== "dead_request") log("fault_ignored", { value: process.env.PI_CREW_FAULT });

  // Role guard — the structural refusals this role carries (profiles/<role>/guard.ts), on top of the global law
  // (guard/index.ts). Loaded async; a tool_call that arrives before it resolves is not blocked by the role rules —
  // the window is the import of one small file, before the first model turn. A missing guard file = no role rules.
  const profile = process.env.PI_CREW_PROFILE || undefined;
  const agentDir = `${process.env.HOME}/.pi/agent`;
  const guardState: Record<string, string> = {};
  void loadRoleGuard(agentDir, profile, existsSync).then((rules) => {
    if (!rules) return;
    applyRoleRules(pi as any, rules, { worktree: process.cwd(), artifactsDir: process.env.PI_CREW_ARTIFACTS || undefined, state: guardState });
    log("role_guard_loaded", { profile, rules: Object.keys(rules) });
  }).catch((e) => log("role_guard_failed", { profile, error: String(e) }));


  pi.on("agent_start", () => { turnText = ""; turnTools = 0; turnStop = ""; turnStartedAt = Date.now(); });

  // Intercom-injected messages carry `details.from`; a plain typed prompt does not.
  pi.on("message_start", (event) => {
    const m: any = event.message;
    if (m?.role !== "user") return;
    const text = typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : "";
    turnOrigin = m?.details?.from ? "main" : /^\[harness\]/.test(text.trim()) ? "harness" : "human";
  });

  pi.on("message_end", (event) => {
    const m: any = event.message;
    if (m?.role !== "assistant") return;
    const content: any[] = Array.isArray(m.content) ? m.content : [];
    turnStop = String(m.stopReason ?? "");
    turnError = String(m.errorMessage ?? "");
    turnTools += content.filter((c) => c.type === "toolCall").length;
    const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n").trim();
    if (text) turnText = text;   // last visible text of the turn wins
  });

  pi.on("agent_end", () => {
    if (faultPending) {
      faultPending = false;
      turnStop = "error";
      turnError = "FAULT: injected";
    }
    // Report even suppressed harness/duplicate turns so main can reset consecutive-error history.
    try { roomClient?.send({ to: ["main"], kind: "notice", task: "turn_end", text: JSON.stringify({ stop: turnStop }) }); } catch { /* best effort */ }
    const turnElapsed = elapsed(Date.now() - turnStartedAt);
    // An interrupted or errored turn is not a result: label it so main never mistakes it for one.
    if (turnStop === "aborted" || turnStop === "error") {
      log(turnStop, { tools: turnTools, error: turnError.slice(0, 120) });
      // pi's verdict on the turn, not our guess from silence (D54): `error` = the request was DEAD (retries exhausted);
      // `aborted` = a human pressed Esc. Main acts on `error` only — compact → failover → respawn — never on silence.
      const c = uiCtx as any; const usage = c?.getContextUsage?.(); const limit = c?.model?.contextWindow ?? 0;
      const contextPct = limit ? Math.round(((usage?.tokens ?? 0) / limit) * 100) : undefined;
      reportToMain("error", "aborted", turnText ? `turn ${turnStop} · last text: ${turnText.slice(0, 300)}` : `turn ${turnStop}`, turnElapsed, { stop: turnStop, error: turnError.slice(0, 200), contextPct });
      return;
    }
    if (turnOrigin === "harness") { log("harness_turn", { tools: turnTools }); return; }   // e.g. the silent-turn nudge: local housekeeping, not a result
    const body = turnText || "(turn ended with no visible text)";
    if (childDir) {
      try { writeFileSync(`${childDir}/report.md`, `# ${name}@${run} · done · ${turnTools} tool${turnTools === 1 ? "" : "s"}\n\n${body}\n`); } catch { /* best effort */ }
    }
    log(turnOrigin === "human" ? "update" : "report", { tools: turnTools, chars: body.length });
    // The worker's own room_send → main this turn IS the report; the auto-report exists for workers that did not.
    if (roomClient?.sentToMainThisTurn) { log("report_skipped_dup", {}); return; }
    reportToMain(turnOrigin === "human" ? "inform" : "result", "done", turnOrigin === "human" ? `(answering direct input in the pane)\n${body}` : body, turnElapsed);
  });

  pi.on("session_start", () => log("worker_ready", { pid: process.pid, pane: process.env.TMUX_PANE }));
  pi.on("session_shutdown", () => { log("worker_shutdown"); void roomClient?.detachBus(); });
}
