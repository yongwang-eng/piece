/**
 * tmux-status — this pi session's dot in its tmux window tab (lib/tmux-dot). Events are applied in order on one chain
 * and never awaited by the agent loop; the daemon (started here if absent) paints. A slash command's own selector
 * waiting on Yong shows the red ◆ like any other "needs a human" — and so does a turn that ends with a question for
 * him, when main says so through `waiting_on_you` (an owed answer is a fact main knows and the harness cannot infer).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { apply, isSeen } from "../../lib/tmux-dot/tmux.ts";
import { ensureDaemon } from "../../lib/tmux-dot/daemon.ts";
import type { DotEvent } from "../../lib/tmux-dot/state.ts";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { EVENT_TO_STATUS, owedCard, owedProblem, settle, type Owed } from "./lifecycle.ts";
import { postAlert, retire } from "../../lib/halo/note.ts";
import { where } from "../../lib/where.ts";

const CLI = `${homedir()}/.pi/agent/bin/tmux-dot.ts`;

export default function (pi: ExtensionAPI) {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  let chain: Promise<unknown> = Promise.resolve();
  let owed: string | undefined;   // armed by waiting_on_you for the turn that is ending; the next prompt disarms it
  let owedBody = "this pi is waiting on you · answer in its pane";   // the options, so the pill alert is answerable on its own
  const report = (ev: DotEvent) => { chain = chain.then(() => apply(pane, ev)).catch(() => {}); };
  for (const [event, status] of Object.entries(EVENT_TO_STATUS)) {
    pi.on(event as any, () => {
      if (status === "done") { const reason = owed; owed = undefined; chain = chain.then(async () => { const seen = await isSeen(pane); for (const ev of settle(seen, reason)) await apply(pane, ev); if (reason && !seen) alert(reason, owedBody); }).catch(() => {}); }
      else { if (status === "working") retire({ id: alertId, source: "pi-crew", reason: "next prompt" }, () => {}); report({ type: status } as DotEvent); }
      if (status === "end") return chain;   // the process exits right after session_shutdown; an un-awaited write is lost
    });
  }
  pi.on("ui_prompt_start", (e: any) => report({ type: "blocked", reason: e?.title ? `waiting on you: ${e.title}` : "waiting on you" }));
  pi.on("ui_prompt_end", () => report({ type: "unblocked" }));
  // The owed answer as a halo alert (Yong 2026-09-22: a needs-you prompt must be big, on his screen, and stay): posted only when the
  // window is NOT being looked at — there the ◆ in the tab is enough — and retired by his next prompt here. TTL is the backstop.
  const alertId = `waiting:${pane}`;
  const alert = (reason: string, body: string) =>
    postAlert({ id: alertId, source: "pi-crew", title: `◆ ${where({ pane, cwd: process.cwd() })} · ${reason.replace(/^waiting on you: /, "")}`, body, ttlMs: 4 * 3600_000 }, () => {});
  if (process.env.PI_CREW_ROLE !== "worker") pi.registerTool({
    name: "waiting_on_you", label: "Waiting on Yong",
    description: "Call this as the LAST thing in a turn Yong must answer, then end the turn with no trailing text — the card this paints IS the ask (◆ · one question · numbered options with ⭐ on your pick · how to answer). ONE ask per call: a reason joined with ' · ' is refused. A question he walked past in an earlier turn is dropped or asked again here in full — never carried as a tag. Not for FYIs or turns that merely finish.",
    parameters: Type.Object({
      reason: Type.String({ description: "≤60 chars, the ONE question: 'PR 2 ownership?', 'approve Alex ping?', 'Devin asks: merge?'" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "2–4 rows, 'label — one line of consequence'; omit for a yes/no" })),
      pick: Type.Optional(Type.Number({ description: "1-based index of the option you would pick (⭐)" })),
    }),
    async execute(_id, p) {
      const o = p as Owed;
      const bad = owedProblem(o);
      if (bad) return { content: [{ type: "text", text: `refused: ${bad}` }], details: { bad }, isError: true };
      owed = `waiting on you: ${o.reason.slice(0, 60)}`;
      owedBody = o.options ? owedCard(o).slice(1, -1).map((l) => l.trim()).join("\n") : "yes / no, or a different opinion · answer in this pi's pane";
      return { content: [{ type: "text", text: `◆ armed — the card above is Yong's; end the turn now (${owed})` }], details: { card: owedCard(o) } };
    },
    // The card is the whole point: framed, scannable — never the dim tool line Yong had to read (2026-09-23).
    renderShell: "self",
    renderCall(args: any, theme: any) {
      const o = args as Owed; const bad = o?.reason ? owedProblem(o) : "…";
      if (bad) return new Text(theme.fg("error", `◆ waiting_on_you — ${bad}`), 0, 0);
      const [head, ...rest] = owedCard(o);
      const w = Math.max(head.length, ...rest.map((l) => l.length)) + 2;
      // accent (soft blue), not error red: it asks for a decision, it does not report a failure (Yong 2026-09-24: "too alarming")
      const bar = theme.fg("accent", "━".repeat(w));
      const body = rest.map((l, i) => (i === rest.length - 1 ? theme.fg("dim", l) : o.pick === i + 1 ? theme.bold(l) : l)).join("\n");
      return new Text(`${bar}\n${theme.fg("accent", theme.bold(head))}\n${body}\n${bar}`, 0, 0);
    },
    renderResult(result: any, _o: any, theme: any) { return new Text(theme.fg(result.isError ? "error" : "dim", result.content?.[0]?.text ?? ""), 0, 0); },
  });
  pi.on("session_start", () => ensureDaemon(CLI));
  pi.on("agent_start", () => ensureDaemon(CLI));
}
