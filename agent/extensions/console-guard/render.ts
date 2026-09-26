export type Level = "info" | "warning" | "error";
export type Rendered = { text: string; level: Level; urls: string[] };

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const MAX = 200;
const LINK_LABEL = "open ↗";

/** OSC-8 hyperlink: terminals render the label, the URL lives only in the escape. */
export const link = (label: string, url: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

/** First non-empty line, URLs anywhere in the text collected; the line is cut on plain text
 *  and links are inserted afterwards, so a cut can never land inside an escape. */
export function render(raw: string, level: Level): Rendered {
  const urls = [...raw.matchAll(URL_RE)].map((m) => m[0]);
  const first = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // placeholders keep the cut honest: a URL counts as its label's width, not its own
  const slots: string[] = [];
  let line = first.replace(URL_RE, (u) => { slots.push(u); return `\u0000${slots.length - 1}\u0000`; });
  if (line.length > MAX) line = line.slice(0, MAX - 1).replace(/\u0000\d*$/, "") + "…";
  let inline = false;
  let text = line.replace(/\u0000(\d+)\u0000/g, (_, i) => { inline = true; return link(LINK_LABEL, slots[+i]); });
  if (urls.length && !inline) text += ` · ${link(LINK_LABEL, urls[0])}`; // the cut or a later line held the URL
  if (urls.length) text += " · copied";
  return { text, level: urls.length && level === "info" ? "warning" : level, urls };
}
