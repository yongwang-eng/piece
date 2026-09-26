/** /borrow — bring the last few rounds of another LIVE pi session into this one, framed as borrowed.
 *  Sources are the pi processes in tmux panes right now (the ones Yong actually uses), never session history.
 *  Read from disk; the other session is never touched. Lands as ONE custom user-role message queued for the next
 *  prompt (nothing runs until Yong speaks), or answered now when a `-- question` is attached. Never rewrites history:
 *  the frame says where it came from, and a card in this transcript says what was borrowed. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { lastRounds, renderBorrowed, estimateTokens } from "../../lib/sessions/reader.ts";
import { elapsed } from "../../lib/agent-ui/time.ts";
import { liveSources, parseArgs, MAX_TOKENS, type Source } from "./sources.ts";

export default function borrow(pi: ExtensionAPI) {
  if (process.env.PI_CREW_ROLE === "worker") return;

  pi.registerCommand("borrow", {
    description: "borrow the last 10 rounds (≤10k tok) of another LIVE pi session (tmux) as framed context · /borrow [window] [N|30m] [about \"x\"] [-- question]",
    handler: async (raw, ctx) => {
      const a = parseArgs(raw ?? "");
      const sources = liveSources();
      if (!sources.length) return ctx.ui.notify("no other live pi session in a tmux pane (each writes state/live/<pid> at start)", "warning");
      let src: Source | undefined;
      if (a.pick) {
        const k = a.pick.toLowerCase();
        const hits = sources.filter((s) => s.window.toLowerCase().includes(k) || s.cwd.toLowerCase().includes(k));
        if (hits.length === 1) src = hits[0];
        else if (!hits.length) return ctx.ui.notify(`no live session matches "${a.pick}" — ${sources.map((s) => s.window).join(" · ")}`, "warning");
        else src = await choose(ctx, hits);
      } else src = await choose(ctx, sources);
      if (!src) return;

      const rounds = lastRounds(src.file, a.n, { maxTokens: MAX_TOKENS, since: a.since, about: a.about });
      if (!rounds.length) return ctx.ui.notify(`nothing to borrow from ${src.window}${a.about ? ` about ${a.about.source}` : ""}`, "info");
      const from = `${src.window} · ${src.cwd.split("/").pop()}`;
      const content = renderBorrowed(rounds, { from, cwd: src.cwd }, a.question);
      const tokens = estimateTokens(content);
      pi.appendEntry("borrowed", { from, window: src.window, rounds: rounds.length, tokens, span: [rounds[0].at, rounds.at(-1)!.at], firstUser: rounds[0].user.slice(0, 80), question: a.question });
      pi.sendMessage(
        { customType: "borrowed", content, display: false, details: { from, file: src.file, rounds: rounds.length, tokens } },
        a.question ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
      );
      const n = `${rounds.length} round${rounds.length === 1 ? "" : "s"}`;
      ctx.ui.notify(a.question ? `borrowed ${n} from ${src.window} · asking` : `borrowed ${n} from ${src.window} · ~${(tokens / 1000).toFixed(1)}k tok · lands with your next message`, "info");
    },
  });

  pi.registerEntryRenderer("borrowed", (entry, _o, theme) => {
    const d = entry.data as { from: string; rounds: number; tokens: number; span: [string, string]; firstUser: string; question?: string };
    const span = `${d.span[0].slice(11, 16)}–${d.span[1].slice(11, 16)}Z`;
    const head = `${theme.fg("accent", "↙ borrowed")} ${theme.fg("text", `${d.rounds} round${d.rounds === 1 ? "" : "s"}`)} ${theme.fg("dim", `from ${d.from} · ${span} · ~${(d.tokens / 1000).toFixed(1)}k tok`)}`;
    const tail = theme.fg("dim", `  “${d.firstUser}${d.firstUser.length >= 80 ? "…" : ""}”${d.question ? `  → ${d.question}` : ""}`);
    return new Text(`${head}\n${tail}`, 0, 0);
  });
}

async function choose(ctx: any, sources: Source[]): Promise<Source | undefined> {
  const w = Math.max(...sources.map((s) => s.window.length));
  const labels = sources.map((s) => {
    const age = s.lastAt ? elapsed(Date.now() - Date.parse(s.lastAt)) : "?";
    const dir = s.cwd.split("/").pop() ?? "";
    return `${s.window.padEnd(w)}  ${dir.padEnd(22).slice(0, 22)}  ${age.padStart(4)}  ${s.lastUser ? `“${s.lastUser.slice(0, 60)}${s.lastUser.length > 60 ? "…" : ""}”` : "—"}`;
  });
  const pick = await ctx.ui.select("Borrow from which live session?", labels);
  const i = labels.indexOf(pick);
  return i >= 0 ? sources[i] : undefined;
}
