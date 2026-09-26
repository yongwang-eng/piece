import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, matchesKey, Key } from "@earendil-works/pi-tui";
import type { DecisionOption } from "../../../lib/room/consult.ts";

export function decisionPicker(tui: any, theme: any, done: (key: string | undefined) => void, question: string, options: DecisionOption[], context = "") {
  let selected: DecisionOption | undefined = options[0];
  let scroll = 0;
  let total = 0;
  let height = 1;
  const list = new SelectList(options.map((o) => ({ value: o.key, label: `${o.recommended ? "⭐ " : ""}${o.label}` })), options.length, {
    selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
    description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => s,
  });
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
  list.onSelectionChange = (item) => { selected = options.find((o) => o.key === item.value); scroll = 0; tui.requestRender(); };
  return {
    render(width: number) {
      const text = (s: string) => new Text(s, 2, 0).render(width);
      const lines = [
        ...text(theme.fg("accent", question)), "",
        ...(context ? [...text(context), ""] : []),
        ...list.render(Math.max(1, width - 4)).map((line) => `  ${line}  `), "",
        ...text(selected?.description ?? ""),
      ];
      total = lines.length;
      const hint = text(theme.fg("dim", "↑↓ choose · Enter confirm · Esc leave open · PgUp/PgDn scroll"));
      height = Math.max(1, (tui.terminal.rows ?? 30) - hint.length - 5);
      scroll = Math.max(0, Math.min(scroll, total - height));
      return ["", ...lines.slice(scroll, scroll + height), "", ...text(theme.fg("dim", `${scroll + 1}–${Math.min(total, scroll + height)}/${total}`)), ...hint, ""];
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.pageDown)) scroll = Math.min(Math.max(0, total - height), scroll + height);
      else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - height);
      else list.handleInput(data);
      tui.requestRender();
    },
    invalidate() { list.invalidate(); },
  };
}

export function pickDecision(ctx: Pick<ExtensionContext, "ui">, question: string, options: DecisionOption[], context = "") {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => decisionPicker(tui, theme, done, question, options, context));
}
