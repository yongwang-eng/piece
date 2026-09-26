/**
 * The status grammar every board speaks — crew workers, Devin sessions, background jobs, whatever comes next.
 *
 *   glyph  name · kind · detail · age        one row, one line, identity survives, detail is what gets cut
 *
 * Three lists, no judgement: the STATE glyphs (`GLYPH`), the ATTENTION level a state maps to (`attentionOf`), and who a
 * wait is owed to (`OWED_TO`, Yong first). A producer builds `Row`s; `boardStyled` renders them with a theme palette and
 * turns a name into an OSC 8 link when the row carries a url (rule: anything that can be clicked is clickable).
 * No pi imports — the pure half is what tests and every producer share.
 */
import { displayWidth } from "./width.ts";
import { hexUnderline, linkUnderline } from "./identity.ts";
import { elapsed } from "./time.ts";
import type { Body } from "./section.ts";

export type RowState = "starting" | "idle" | "working" | "tool" | "compacting" | "stalled" | "gone" | "waiting" | "done";
export interface Wait { on: string | undefined; why: string; sinceMs: number; done?: boolean }
/** Structural: crew passes its `WorkerCommunication`; a producer without peers leaves it out. */
export interface PeerStats { status: string; counts?: { sent: number; addressed: number } }

/** `waiting`/`done` are WORKFLOW states laid over presence by the caller (consults, room record); presence alone never produces them.
 *  `body` is what a row SAYS under its identity line (section.ts); the row renderers here ignore it. */
export interface Row { communication?: PeerStats; id?: number; name: string; pane: string; profile?: string; state: RowState; detail: string; ageMs: number; waiting?: Wait; url?: string; prUrl?: string; body?: Body }

export const GLYPH: Record<RowState, string> = { starting: "◌", idle: "○", working: "●", tool: "⚙", compacting: "◐", stalled: "◆", gone: "✕", waiting: "↩", done: "✓" };

/** Whose turn it is. Yong first: the board's job is to show him what he owes before what is merely slow. */
export const OWED_TO = ["you", "governor", "main"] as const;
const glyphOf = (r: Row): string => r.state !== "waiting" ? GLYPH[r.state] : r.waiting?.on === "you" ? "⏳" : r.waiting?.on === "governor" ? "⚖" : "↩";
const rank = (r: Row): number => {
  if (r.state === "waiting") { const i = OWED_TO.indexOf(r.waiting?.on as any); return i === -1 ? 3 : i; }
  return 4 + ["stalled", "gone", "compacting", "tool", "working", "starting", "done", "idle"].indexOf(r.state);
};
/** The board's order: owed to Yong first, then stalled … idle; stable, so equals keep their arrival order. */
export const byRank = (rows: Row[]): Row[] => [...rows].sort((a, b) => rank(a) - rank(b));

/** Lay a wait over a presence row: the detail becomes whose turn it is and for how long. */
export function withWait(r: Row, wait: Wait | undefined): Row {
  if (!wait) return r;
  if (wait.done) return r.state === "idle" ? { ...r, state: "done", detail: wait.why } : r;   // a re-steered worker is working, not done
  return { ...r, state: "waiting", waiting: wait, detail: `waiting on ${wait.on === "you" ? "YOU" : wait.on} · ${wait.why} · ${elapsed(wait.sinceMs)}` };
}


/** The plain segments of a row laid into `width`; the identity (glyph · handle · pane) survives, detail is what gets cut. */
type Parts = { glyph: string; handle: string; pane: string; detail: string; tail: string };
function rowParts(r: Row, width: number): Parts {
  const glyph = glyphOf(r);
  const handle = `${r.id ? `#${r.id} ` : ""}${r.name}`;
  const head = `${glyph} ${handle} ${r.pane}`;
  let tail = ` · ${elapsed(r.ageMs)}${r.profile ? ` · ${r.profile}` : ""}`;
  // Identity + age survive; the detail is what gets cut. displayWidth, not .length: a CJK cwd or an
  // emoji in a tool name would otherwise spill the row into the next line on every repaint.
  const room = width - displayWidth(head) - displayWidth(tail) - 3;
  const detail = room > 4 ? (displayWidth(r.detail) > room ? r.detail.slice(0, room - 1) + "…" : r.detail) : "";
  const line = detail ? `${head} · ${detail}${tail}` : `${head}${tail}`;
  if (displayWidth(line) <= width) {
    const c = r.communication;
    const stats = c ? c.status === "complete" && c.counts ? ` · peer ↑${c.counts.sent} ↓${c.counts.addressed}` : " · peer ?" : "";
    if (displayWidth(line + stats) <= width) tail += stats;
    return { glyph, handle, pane: r.pane, detail, tail };
  }
  // Too narrow even without detail: one hard cut of `glyph handle pane · age`, carried as the handle so nothing is restyled.
  let out = "";
  for (const ch of `${head}${tail}`) { if (displayWidth(out + ch) > width) break; out += ch; }
  return { glyph, handle: out.slice(glyph.length + 1), pane: "", detail: "", tail: "" };
}
const joinParts = (p: Parts, f: { glyph: string; handle: string; pane: string; detail: string; tail: string }): string =>
  `${f.glyph} ${f.handle}${p.pane ? ` ${f.pane}` : ""}${p.detail ? ` · ${f.detail}` : ""}${f.tail}`;

/** One line per row within `width`; plain text, no escapes. */
export function rowText(r: Row, width: number): string {
  const p = rowParts(r, width);
  return joinParts(p, p);
}

/** Attention is a LIST, not a judgement: what the reader must act on · what is moving · what can be ignored. */
export type Attention = "alert" | "live" | "quiet";
export function attentionOf(r: Row): Attention {
  if (r.state === "stalled" || r.state === "gone") return "alert";
  if (r.state === "waiting") return r.waiting?.on === "you" ? "alert" : "live";
  if (r.state === "idle" || r.state === "done") return "quiet";
  return "live";
}

/** The styling seam: a theme's `fg`/`bold`, plus `link` when the terminal path renders OSC 8 (pi-tui detects it). */
/** A link's only visible cue: a dotted underline (SGR 4:4 + 58) in a slate derived from the theme — iTerm2's own is text-coloured and loud. */
export const linkMark = (label: string) => hexUnderline(label, linkUnderline());

/** A link in prose: accent (the theme's link blue) + the mark. Only a ROW NAME keeps its attention tone instead. */
export const linkText = (pal: Palette, label: string, url: string) => pal.fg("accent", pal.link ? pal.link(linkMark(label), url) : label);

export type Palette = { fg: (tone: string, s: string) => string; bold: (s: string) => string; link?: (label: string, url: string) => string; handle?: (text: string, r: Row) => string };

/** The glyph's tone; a row's body (progress bar) wears the same one. Compacting stays amber: it looks like work but no tokens are moving. */
export function glyphToneOf(r: Row): string {
  const a = attentionOf(r);
  return a === "alert" ? "error" : a === "quiet" ? "dim" : r.state === "waiting" || r.state === "compacting" ? "warning" : "success";
}

/** The same layout as rowText, with each segment toned by attention and the name clickable when the row has a url. */
export function styledRow(r: Row, width: number, pal: Palette): string {
  const p = rowParts(r, width);
  const a = attentionOf(r);
  const glyphTone = glyphToneOf(r);
  const detailTone = a === "alert" ? "error" : a === "quiet" ? "dim" : "text";
  const label = pal.link && r.url ? pal.link(linkMark(p.handle), r.url) : p.handle;
  const handle = pal.handle ? pal.handle(label, r) : pal.fg(a === "quiet" ? "muted" : "text", label);   // colour carries attention; no bold (Yong: weight on top of colour is too much)
  let detail = pal.fg(detailTone, p.detail);
  if (pal.link && r.prUrl) { const m = /#\d+/.exec(p.detail); if (m) detail = pal.fg(detailTone, p.detail.slice(0, m.index)) + pal.link(linkMark(m[0]), r.prUrl) + pal.fg(detailTone, p.detail.slice(m.index + m[0].length)); }
  return joinParts(p, { glyph: pal.fg(glyphTone, p.glyph), handle, pane: pal.fg("dim", p.pane), detail, tail: pal.fg("dim", p.tail) });
}

/** `noun` names a row in the header ("worker", "job"); `hint` is the command that lists the hidden rest. */
export type BoardOpts = { noun?: string; hint?: string };
function boardShape(rows: Row[], width: number, max: number, run?: string, o: BoardOpts = {}) {
  const noun = o.noun ?? "worker";
  const sorted = byRank(rows);
  const shown = sorted.slice(0, max);
  const owed = rows.filter((r) => r.state === "waiting" && r.waiting?.on === "you").length;
  const stalled = rows.filter((r) => r.state === "stalled").length;
  const title = run ?? "crew";
  const count = ` · ${rows.length} ${noun}${rows.length === 1 ? "" : "s"}${owed ? ` · you owe ${owed}` : ""}${stalled ? ` · ${stalled} stalled` : ""}`.slice(0, Math.max(0, width - title.length));
  const more = sorted.length > shown.length ? `… +${sorted.length - shown.length} more (${o.hint ?? "/crew list"})`.slice(0, width) : undefined;
  return { title, count, shown, more, owed };
}

/** Board lines: header + up to `max` rows (who is owed first, then stalled), then an overflow count — never a silent drop. */
export function boardLines(rows: Row[], width: number, max = 3, run?: string, o?: BoardOpts): string[] {
  if (rows.length === 0) return [];
  const b = boardShape(rows, width, max, run, o);
  const lines = [b.title + b.count];
  for (const r of b.shown) lines.push(rowText(r, width));
  if (b.more) lines.push(b.more);
  return lines;
}

/** boardLines with the palette applied: bold section name, dim count, rows toned by attention. Same order, same cuts. */
export function boardStyled(rows: Row[], width: number, max = 3, run: string | undefined, pal: Palette, o?: BoardOpts): string[] {
  if (rows.length === 0) return [];
  const b = boardShape(rows, width, max, run, o);
  const lines = [pal.fg("dim", b.title) + pal.fg(b.owed ? "warning" : "text", b.count)];   // the title is a label; the count is the information
  for (const r of b.shown) lines.push(styledRow(r, width, pal));
  if (b.more) lines.push(pal.fg("dim", b.more));
  return lines;
}

/** The folded form of a section: ONE row in the grammar — the loudest row's glyph, then counts by state. Owed rows never fold. */
export function boardSummary(rows: Row[], width: number, run: string | undefined, pal: Palette | undefined, o: BoardOpts = {}): string[] {
  if (rows.length === 0) return [];
  const sorted = byRank(rows);
  const loud = sorted[0];
  const counts = new Map<string, number>();
  for (const r of sorted) { const k = r.state === "waiting" ? `waiting on ${r.waiting?.on === "you" ? "YOU" : r.waiting?.on ?? "?"}` : r.state; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const b = boardShape(rows, width, 0, run, o);
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(" · ");
  const plain = `${glyphOf(loud)} ${b.title}${b.count} · ${tally}`;
  const owedRows = sorted.filter((r) => r.state === "waiting" && r.waiting?.on === "you");
  if (!pal) return [plain.slice(0, width), ...owedRows.map((r) => rowText(r, width))];
  const a = attentionOf(loud);
  const glyphTone = a === "alert" ? "error" : a === "quiet" ? "dim" : "success";
  const head = `${pal.fg(glyphTone, glyphOf(loud))} ${pal.fg("dim", b.title)}${pal.fg(b.owed ? "warning" : "text", b.count)}${pal.fg("dim", ` · ${tally}`)}`;
  return [head, ...owedRows.map((r) => styledRow(r, width, pal))];
}
