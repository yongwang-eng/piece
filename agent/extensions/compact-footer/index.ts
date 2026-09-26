import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitFooter, type FooterPart } from "../../lib/agent-ui/footer-layout.ts";
import { hexFg, modelColorFor } from "../../lib/agent-ui/identity.ts";

function human(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function bar(percent: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

const modelColor = (id: string, text: string) => hexFg(text, modelColorFor(id));

function sessionCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries as Array<Record<string, any>>) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      total += entry.message.usage?.cost?.total ?? 0;
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      total += entry.message.usage?.cost?.total ?? 0;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      total += entry.usage.cost?.total ?? 0;
    }
  }
  return total;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((_tui, theme) => {
      return {
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          const usage = ctx.getContextUsage();
          const used = usage?.tokens ?? 0;
          const limit = ctx.model?.contextWindow ?? 0;
          const percent = limit > 0 ? (used / limit) * 100 : 0;
          const contextFull = `${bar(percent)} ${percent.toFixed(0)}% (${human(used)}/${human(limit)})`;
          const contextCompact = `${bar(percent)} ${percent.toFixed(0)}%`;
          const separator = theme.fg("dim", " │ ");
          const directory = basename(ctx.sessionManager.getCwd()) || ctx.sessionManager.getCwd();
          const cost = sessionCost(ctx.sessionManager.getEntries());

          const parts: FooterPart[] = [
            { key: "directory", variants: [theme.fg("dim", directory)], required: true },
            { key: "model", variants: [theme.bold(modelColor(ctx.model?.id ?? "", ctx.model?.id ?? "no-model"))], required: true },
            ...(ctx.model?.reasoning ? [{ key: "thinking", variants: [theme.fg("muted", ctx.thinkingLevel)] }] : []),
            {
              key: "context",
              variants: [contextFull, contextCompact, `${percent.toFixed(0)}%`].map(
                (text) => theme.fg("dim", text),   // background compaction owns context; the gauge is information, not an alarm
              ),
              required: true,
            },
            { key: "cost", variants: [theme.fg("dim", `$${cost.toFixed(2)}`)] },
          ];

          const line = fitFooter(parts, width, {
            separator,
            measure: visibleWidth,
            truncate: (text, maxWidth) => truncateToWidth(text, maxWidth, theme.fg("dim", "…")),
          });
          return [line];
        },
      };
    });
  });
}
