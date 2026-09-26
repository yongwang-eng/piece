// Terminal display width without pi imports (this module runs under node --test).
// JS `.length` is wrong for CJK/emoji (2 columns) and combining marks (0), and a row that
// miscounts by one spills into the next line on every repaint.

// CSI (colours) and OSC (hyperlinks, BEL- or ST-terminated) are zero-width; missing OSC here made every linked row measure as its URL.
// eslint-disable-next-line no-control-regex -- stripping ESC sequences is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function wide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd);
}

function cpWidth(ch: string): number {
  if (/\p{M}/u.test(ch) || ch === "\u200d" || ch === "\ufe0f") return 0;
  return wide(ch.codePointAt(0)!) || /\p{Emoji_Presentation}/u.test(ch) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text.replace(ANSI, "")) w += cpWidth(ch);
  return w;
}

/** Sanitise to ONE line (newlines/tabs → ⏎, control chars — incl. ESC — dropped) and fit exactly `width` columns:
 *  padded when short, truncated with … when long. */
export function fit(raw: string, width: number): string {
  if (width <= 0) return "";
  const text = raw.replace(/[\r\n\t]+/g, " ⏎ ").replace(/\p{C}/gu, "");
  let w = 0, out = "";
  for (const ch of text) {
    const cw = cpWidth(ch);
    if (w + cw > width) return width <= 1 ? "…" : `${trimTo(out, width - 1)}…`;
    out += ch; w += cw;
  }
  return out + " ".repeat(width - w);
}

/** `fit` without the padding: the text as is when it fits, else cut to `width` ending in …. */
export const cut = (text: string, width: number): string => (displayWidth(text) <= width ? text : fit(text, width));

function trimTo(s: string, width: number): string {
  let w = 0, out = "";
  for (const ch of s) { const cw = cpWidth(ch); if (w + cw > width) break; out += ch; w += cw; }
  return out + " ".repeat(width - w);
}

/** `cut` for text that already carries colour/link escapes: sequences pass through uncounted, glyphs are counted,
 *  and a cut ends with … then closes the link and resets style so nothing bleeds into the border. */
export function cutStyled(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let w = 0, out = "", i = 0;
  while (i < text.length) {
    const m = text.slice(i).match(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = cpWidth(ch);
    if (w + cw > width - 1) break;
    out += ch; w += cw; i += ch.length;
  }
  return `${out}…\x1b]8;;\x1b\\\x1b[0m`;
}

