/**
 * Activity area — a ≤4-row live window above the editor answering "what is the
 * agent doing right now, and is it stuck?". Replaced in place; never enters the
 * transcript.
 *
 *   waiting   ◌ waiting for first token · 18s            (>15s flagged)
 *   thinking  ▸ done phase · 9s / ● current phase / …live tail   (silence >10s flagged)
 *   tool      ⚙ bash sleep 60 · 45s + last output line   (>30s flagged as possibly hung)
 *   answering ● Writing · 9s
 *   idle      ○ Idle · main is not running
 *
 * Sources: `message_update` (thinking_delta / text_start / toolcall_start),
 * `tool_execution_start|update|end`, `agent_start|end`.
 *
 * Persistent trace (`thought-trail` entries, TUI-only, never LLM context): one dim line per
 * finished reasoning block with its last sentences, and a warning line when a turn ends
 * without any visible assistant text — so a tab revisited later still shows what happened.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildTrail, clip, formatStepDuration, parseSteps, tail, wrapTail, paintsAnswer } from "./ticker.ts";

const KEY = "activity-area";
const TRAIL = "thought-trail";
const TRAIL_LINES = 2;
const SILENT_NUDGE =
  "[harness] Your turn ended with no visible text — the user saw only tool calls. Reply in 1–3 lines: what you did, the result, and the next step. Do not call tools.";

type Trail =
  | { kind: "thought"; ms: number; digest: string }
  | { kind: "silent-end"; ms: number; tools: number };
const MAX_LINES = 4;
const THINK_SILENCE_MS = 10_000;
const FIRST_TOKEN_SLOW_MS = 15_000;
const TOOL_SLOW_MS = 30_000;

type Phase = "idle" | "waiting" | "thinking" | "calling" | "tool" | "answering";

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let phase: Phase = "idle";
  let phaseStartedAt = 0;
  let tick: ReturnType<typeof setInterval> | undefined;

  // thinking state
  let buffer = "";
  let stepStarts: number[] = [];
  let lastDeltaAt = 0;

  // tool state
  let tool = { name: "", detail: "", lastLine: "", lastUpdateAt: 0 };

  let runStartedAt = 0;

  // persistent-trace state: per assistant message (thinking) and per agent run (text / tools)
  let msgThinking = "";
  let msgThinkStartedAt = 0;
  let runHadText = false;
  let runTools = 0;
  let nudged = false;
  let lastStop = "";

  const width = () => Math.max(20, (process.stdout.columns ?? 100) - 6);

  pi.registerEntryRenderer(TRAIL, (entry, _opts, theme) => {
    const d = entry.data as Trail;
    const w = width();
    if (d.kind === "silent-end") {
      return new Text(theme.fg("warning", clip(`◈ turn ended · ${formatStepDuration(d.ms)} · ${d.tools} tool${d.tools === 1 ? "" : "s"} · no visible answer`, w)));
    }
    const head = `◦ thought ${formatStepDuration(d.ms)} · `;
    const body = wrapTail(d.digest, Math.max(10, w - head.length), TRAIL_LINES);
    const lines = body.map((l, i) => (i === 0 ? head + l : " ".repeat(head.length) + l));
    return new Text(theme.fg("dim", lines.join("\n")));
  });
  const show = (lines: string[]) => ctx?.ui.setWidget(KEY, lines.length ? lines : undefined);

  /** Status-row label = the real phase, never a clock-driven verb. */
  const statusLabel = (): string => {
    switch (phase) {
      case "waiting": return "Waiting for model";
      case "thinking": return lastDeltaAt && Date.now() - lastDeltaAt > THINK_SILENCE_MS ? "Reasoning (silent)" : "Reasoning";
      case "calling": return `Calling ${tool.name || "tool"}`;
      case "tool": return `Running ${tool.name}`;
      case "answering": return "Writing";
      default: return "Working";
    }
  };
  // Stock status row stays untouched: re-writing setWorkingMessage every second leaves
  // stale rows behind in the embedded editor when the string length changes (seen 2026-09-08).
  const headline = () => `${statusLabel()} · ${formatStepDuration(Date.now() - runStartedAt)}`;

  const render = () => {
    if (!ctx) return;
    const theme = ctx.ui.theme;
    const now = Date.now();
    const elapsed = formatStepDuration(now - phaseStartedAt);
    const bar = theme.fg("dim", "┊ ");
    const w = width();

    if (phase === "idle") return show([bar + theme.fg("muted", "○ Idle · main is not running")]);
    if (phase === "answering" || phase === "calling") return show([bar + theme.fg("text", clip(`● ${headline()}`, w))]);

    if (phase === "waiting") {
      const slow = now - phaseStartedAt > FIRST_TOKEN_SLOW_MS;
      const text = slow
        ? `◌ waiting for first token · ${elapsed}  ⚠ slow — provider queue or network?`
        : `◌ waiting for first token · ${elapsed}`;
      return show([bar + theme.fg(slow ? "warning" : "muted", clip(text, w))]);
    }

    if (phase === "thinking") {
      const lines = buildTrail(parseSteps(buffer), stepStarts, now, w, MAX_LINES, lastDeltaAt, THINK_SILENCE_MS);
      if (lines.length === 0) {
        // Reasoning has started but the provider hasn't flushed a summary yet.
        return show([bar + theme.fg("muted", `◌ ${headline()} (no summary yet)`)]);
      }
      return show(
        lines.map((l) => {
          const color = l.kind === "done" ? "dim" : l.kind === "silence" ? "warning" : l.kind === "current" ? "text" : "muted";
          return bar + theme.fg(color, l.text);
        }),
      );
    }

    // tool — "hung" means SILENT, not long: a tool still emitting updates is working.
    const quietFor = now - (tool.lastUpdateAt || phaseStartedAt);
    const slow = quietFor > TOOL_SLOW_MS;
    const head = clip(`⚙ ${tool.name} ${tool.detail} · ${elapsed}`, w);
    const lines = [bar + theme.fg(slow ? "warning" : "text", head)];
    if (tool.lastLine) lines.push(bar + theme.fg("muted", clip(`  ${tool.lastLine}`, w)));
    if (slow) lines.push(bar + theme.fg("warning", `  ⚠ no output for ${formatStepDuration(quietFor)} — hung? (esc to interrupt)`));
    return show(lines);
  };

  const enter = (next: Phase) => {
    phase = next;
    phaseStartedAt = Date.now();
    render();
  };

  const stop = () => {
    if (tick) clearInterval(tick);
    tick = undefined;
    phase = "idle";
    buffer = "";
    stepStarts = [];
    lastDeltaAt = 0;
    show([]);
  };

  const detailOf = (name: string, args: any): string => {
    const raw = name === "bash" ? String(args?.command ?? "") : String(args?.path ?? args?.query ?? "");
    return raw.replace(/\s+/g, " ").slice(0, 60);
  };

  pi.on("session_start", (_e, context) => {
    ctx = context;
    stop();
    render();
  });

  pi.on("agent_start", (_e, context) => {
    ctx = context;
    stop();
    runStartedAt = Date.now();
    runHadText = false;
    runTools = 0;
    msgThinking = "";
    enter("waiting");
    tick = setInterval(render, 1_000);
    tick.unref?.();
  });

  pi.on("turn_start", () => {
    // Each model round-trip begins with a wait; a tool phase hands off here.
    if (phase !== "tool") enter("waiting");
  });

  pi.on("message_update", (event) => {
    const e = event.assistantMessageEvent;
    switch (e.type) {
      case "thinking_start":
        // One turn can carry several reasoning items; keep the trail across them.
        if (buffer && !buffer.endsWith("\n\n")) buffer += "\n\n";
        stepStarts[parseSteps(buffer).length] ??= Date.now();
        lastDeltaAt = Date.now();
        enter("thinking");
        break;
      case "thinking_delta": {
        if (!msgThinking) msgThinkStartedAt = Date.now();
        msgThinking += e.delta;
        const before = parseSteps(buffer).length;
        buffer += e.delta;
        const after = parseSteps(buffer).length;
        for (let i = before; i < after; i++) stepStarts[i] ??= Date.now();
        lastDeltaAt = Date.now();
        if (phase !== "thinking") enter("thinking");
        else render();
        break;
      }
      case "text_start":
        buffer = "";
        stepStarts = [];
        enter("answering");
        break;
      case "toolcall_start": {
        // Arguments streaming in; tool_execution_start takes over once they're complete.
        const block = e.partial.content[e.contentIndex];
        tool = { name: block?.type === "toolCall" ? block.name : "", detail: "", lastLine: "", lastUpdateAt: 0 };
        enter("calling");
        break;
      }
    }
  });

  pi.on("tool_execution_start", (e) => {
    if (paintsAnswer(e.toolName)) runHadText = true;   // the ◆ card is the visible answer; no silent-end nudge after it
    tool = { name: e.toolName, detail: detailOf(e.toolName, e.args), lastLine: "", lastUpdateAt: Date.now() };
    enter("tool");
  });
  pi.on("tool_execution_update", (e) => {
    const text = e.partialResult?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
    const last = text.trimEnd().split("\n").pop()?.trim();
    if (last) tool.lastLine = last;
    tool.lastUpdateAt = Date.now();
    render();
  });
  pi.on("tool_execution_end", () => enter("waiting"));

  pi.on("message_end", (event) => {
    const m: any = event.message;
    if (m?.role !== "assistant") return;
    const content: any[] = Array.isArray(m.content) ? m.content : [];
    lastStop = String(m.stopReason ?? "");
    if (content.some((c) => c.type === "text" && String(c.text ?? "").trim())) runHadText = true;
    runTools += content.filter((c) => c.type === "toolCall").length;
    if (msgThinking.trim()) {
      const steps = parseSteps(msgThinking);
      const titled = steps.map((s) => s.title).filter(Boolean) as string[];
      const digest = titled.length ? titled.join(" · ") : tail(msgThinking, 2);
      pi.appendEntry(TRAIL, { kind: "thought", ms: Date.now() - msgThinkStartedAt, digest } satisfies Trail);
    }
    msgThinking = "";
  });

  pi.on("agent_end", () => {
    if (!runHadText && runStartedAt) {
      pi.appendEntry(TRAIL, { kind: "silent-end", ms: Date.now() - runStartedAt, tools: runTools } satisfies Trail);
      // Once per silent run, never for the nudge's own run, and never after an interrupt/error
      // (Esc is the human's decision; a nudge there forces a pointless answer).
      const normalEnd = lastStop !== "aborted" && lastStop !== "error";
      if (ctx?.hasUI && !nudged && normalEnd && runTools > 0) {
        nudged = true;
        pi.sendUserMessage(SILENT_NUDGE, { deliverAs: "followUp" });
      } else {
        nudged = false;
      }
    } else {
      nudged = false;
    }
    stop();
    show([ctx?.ui.theme.fg("muted", "┊ ◌ Finishing turn · checking continuations") ?? ""]);
  });
  // agent_end can precede automatic retries or follow-ups; only settled means idle.
  pi.on("agent_settled", () => { stop(); render(); });
  pi.on("session_shutdown", () => { stop(); ctx = undefined; });
}
