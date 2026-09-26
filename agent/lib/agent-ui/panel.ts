/** A peek panel: content shown over the editor until esc/q, scrollable, never written to the transcript.
 *  The /ctx pattern — for anything glanced at once (a usage card, a grammar swatch), where an entry would
 *  leave a 60-line card in scrollback forever. Pure (tested here); panel-ui.ts wires it to pi. */
import { cutStyled, displayWidth } from "./width.ts";

type Fg = (tone: string, text: string) => string;

/** The box is as tall as its content, capped at `maxRows`; past the cap it scrolls at a constant height. */
export function pageOf(all: string[], offset: number, maxRows: number): { slice: string[]; offset: number; pos: string } {
  const page = Math.min(all.length, Math.max(1, maxRows));
  const maxOffset = Math.max(0, all.length - page);
  const at = Math.min(Math.max(0, offset), maxOffset);
  const slice = all.slice(at, at + page);
  const pos = all.length > page ? ` ${at + 1}–${Math.min(at + page, all.length)}/${all.length}` : "";
  return { slice, offset: at, pos };
}

export function frame(slice: string[], pos: string, width: number, fg: Fg): string[] {
  const inner = Math.max(1, width - 4);
  // padEnd counts escape bytes as width and misaligns the right border; pad by VISIBLE width.
  const pad = (t: string) => t + " ".repeat(Math.max(0, inner - displayWidth(t)));
  const edge = (l: string, r: string) => fg("borderAccent", l + "─".repeat(Math.max(0, width - 2)) + r);
  return [
    edge("╭", "╮"),
    ...slice.map((line) => fg("borderAccent", "│ ") + pad(cutStyled(line, inner)) + fg("borderAccent", " │")),
    edge("╰", "╯"),
    fg("dim", `  ↑↓ scroll${pos} · esc/q close`),
  ];
}
