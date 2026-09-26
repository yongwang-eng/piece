/** showPanel — the /ctx peek pattern wired to pi: content over the editor until esc/q, ↑↓ scroll, nothing in the transcript. */
import { matchesKey } from "@earendil-works/pi-tui";
import { frame, pageOf } from "./panel.ts";

type Ctx = { ui: { custom: <T>(f: (tui: any, theme: any, keys: any, done: (v?: T) => void) => any) => Promise<T> } };

/** `build(innerWidth, theme)` returns the lines to show; the panel owns scroll, frame and dismissal. */
export function showPanel(ctx: Ctx, build: (innerWidth: number, theme: any) => string[]): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0;
    const fg: Fg = (t, x) => theme.fg(t, x);
    // The cap is a property of the TERMINAL, not of how much content is left — otherwise scrolling past the end shrinks the box.
    const maxRows = () => Math.max(8, (tui.terminal?.rows ?? process.stdout.rows ?? 40) - 8);
    return {
      render(width: number) {
        const all = build(Math.max(20, width - 4), theme);
        const p = pageOf(all, offset, maxRows());
        offset = p.offset;
        return frame(p.slice, p.pos, width, fg);
      },
      invalidate() {},
      handleInput(data: string) {
        if (matchesKey(data, "escape") || data === "q") return done();
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 3);
        if (matchesKey(data, "down")) offset += 3;
        tui.requestRender();
      },
    };
  });
}
