/** usage — record AND read the cost ledger. Loads in every pi process (main auto-load; workers via
 *  the crew spawn list) and records model calls + compactions to the shared sqlite (lib/telemetry/recorder.ts).
 *  `/usage` is the read side: ONE glance card (view/card.ts) — this session, today, the 7-day trajectory. No drill-downs
 *  (Yong, 2026-09-17: "all I care is a quick summary and the trajectory"); the dashboard has the detail. Shown as a peek
 *  panel (esc/q closes, nothing in the transcript); `/usage keep` writes it as an entry when two cards need comparing.
 *  Also hosts /problems — the coalesced list of what any extension could not heal (lib/agent-ui/problems.ts). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { installUsageRecorder } from "../../lib/telemetry/recorder.ts";
import { problems } from "../../lib/agent-ui/problems.ts";
import type { Palette } from "../../lib/agent-ui/board.ts";
import { showPanel } from "../../lib/agent-ui/panel-ui.ts";
import { buildCard, renderCard, type Card } from "./view/card.ts";
import { readLedger } from "./view/ledger.ts";
import { computeStats } from "./view/stats.ts";

const DASHBOARD = "http://127.0.0.1:9700/usage";

const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

export default function (pi: ExtensionAPI) {
  const agentDir = `${homedir()}/.pi/agent`;
  installUsageRecorder(pi, agentDir);
  const report = problems(pi, `${agentDir}/state/problems.log`);
  pi.registerCommand("usage", {
    description: "cost & context at a glance — this session, today, the 7-day trajectory (peek panel; `/usage keep` writes it to the transcript)",
    handler: async (args, ctx) => {
      const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
      const stats = computeStats(entries);
      if (stats.totals.calls === 0) return ctx.ui.notify("no assistant calls with usage on this branch yet", "info");
      // Branch = what the model will see next; ledger = what the session actually spent. They diverge at the first compaction.
      const ledger = readLedger(`${agentDir}/state/agent.sqlite`, ctx.sessionManager.getSessionId?.() ?? "");
      const card = buildCard(stats, ledger, { contextWindow: (ctx.model as any)?.contextWindow ?? 200_000 });
      if (args?.trim() === "keep") { pi.appendEntry("usage_card", card); return; }
      await showPanel(ctx as any, (inner, theme) => renderCard(card, Math.min(110, inner), palette(theme), DASHBOARD));
    },
  });
  const palette = (theme: any): Palette => ({ fg: (t, x) => theme.fg(t, x), bold: (x) => theme.bold(x), link: getCapabilities().hyperlinks ? hyperlink : undefined });
  pi.registerEntryRenderer("usage_card", (entry, _o, theme) => {
    const width = Math.max(60, Math.min(110, (process.stdout.columns ?? 120) - 4));
    return new Text(renderCard(entry.data as Card, width, palette(theme), DASHBOARD).join("\n"), 0, 0);
  });

  pi.registerCommand("problems", {
    description: "What extensions could not heal, coalesced by key · `/problems clear` resets",
    handler: async (args, ctx) => {
      if (args?.trim() === "clear") { report.clear(); ctx.ui.notify("problems · cleared", "info"); return; }
      const list = report.list();
      if (list.length === 0) { ctx.ui.notify("problems · none", "info"); return; }
      const now = Date.now();
      const lines = list.map(p => `×${p.count}  ${p.key}  first ${ago(now - p.first)} ago · last ${ago(now - p.last)} ago\n    ${p.message}${p.hint ? `\n    → ${p.hint}` : ""}`);
      ctx.ui.notify(`${lines.join("\n")}\n\nfull log: ${agentDir}/state/problems.log`, "info");
    },
  });
}
