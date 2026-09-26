/**
 * A section as DATA. The producer hands rows in the grammar (board.ts) and the host paints them: header, rows,
 * "+N more", and under a row whatever its `body` SAYS — progress · stats · series · links, one line each, that order.
 * Rows without a body render byte-for-byte as boardStyled/boardSummary + the `┊ ` gutter: that is the regression bar.
 * Width: identity first. Every cut happens on plain text and escapes/OSC 8 wrap after; under 30 columns no body is drawn.
 * No pi imports — the pure half every producer and test shares.
 */
import { attentionOf, boardStyled, boardSummary, byRank, GLYPH, glyphToneOf, linkMark, linkText, type Attention, type Palette, type Row } from "./board.ts";
import { elapsed } from "./time.ts";
import { cut, displayWidth } from "./width.ts";

export interface SectionData { title: string; noun: string; hint: string; rows: Row[] }

/** What a row may say under its identity line. Each part is one line; a value is a STRING because the producer knows the unit. */
export interface Body {
  progress?: { value: number; label?: string };
  stats?: Array<{ label: string; value: string; tone?: Attention }>;
  series?: { label: string; points: number[]; unit?: string };
  links?: Array<{ label: string; url: string }>;
  /** Set by the producer that watched the source go quiet: the whole body renders dim; the row's detail says for how long. */
  stale?: boolean;
}

const GUTTER = "┊ ", INDENT = "  ";
const MAX_ROWS = 4;
const MIN_BODY_W = 30;
const CELLS = "▁▂▃▄▅▆▇█";
const SERIES_MAX = 60, SERIES_MIN = 8;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** `▰` filled to `value` of `len` cells, `▱` the rest; out-of-range clamps, non-finite reads as 0. */
export function bar(value: number, len: number): string {
  const filled = Math.round((Number.isFinite(value) ? clamp01(value) : 0) * len);
  return "▰".repeat(filled) + "▱".repeat(len - filled);
}

/** The newest `n` points on eight cells. Scale max(0, 0.9·min)…max so a held rate's jitter has shape instead of
 *  reading as a second progress bar (a 20 % dip drops to about a third; a collapse to 0 pulls the floor to 0 and hits ▁);
 *  plain min…max when a point is negative. ▁ is reserved for 0 — a live rate never looks dead. */
export function sparkline(points: number[], n: number): string {
  const pts = points.slice(-Math.max(0, n));
  if (!pts.length) return "";
  const min = Math.min(...pts), hi = Math.max(...pts);
  const lo = min < 0 ? min : Math.max(0, 0.9 * min);
  if (hi === lo) return (hi === 0 ? "▁" : "█").repeat(pts.length);
  const cell = (v: number) => Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8));
  return pts.map((v) => CELLS[min < 0 ? cell(v) : v <= 0 ? 0 : Math.max(1, cell(v))]).join("");
}

/** |v| ≥ 100 → whole; else one decimal with `.0` stripped. */
export function fmtNum(v: number): string {
  const s = Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return s === "-0" ? "0" : s;
}

const pct = (v: number) => `${Math.round(clamp01(v) * 100)}%`;
/** Drop whole items from the right until the joined line fits; the count kept (0 = nothing fits). */
function keepWhole(widths: number[], W: number, sep = 3, ellipsis = 2): number {
  for (let n = widths.length; n > 0; n--) { if (widths.slice(0, n).reduce((a, b) => a + b, 0) + sep * (n - 1) + (n < widths.length ? ellipsis : 0) <= W) return n; }
  return 0;
}

type Tone = (t: string) => string;
function progressLine(p: NonNullable<Body["progress"]>, W: number, barTone: string, tone: Tone, pal: Palette): string {
  const v = clamp01(p.value), label = p.label ?? "", pc = pct(v);
  const seg = (t: string, s: string) => (s ? pal.fg(t, s) : "");
  const styled = (len: number, lab: string) => {
    const filled = Math.round(v * len);
    return `${seg(barTone, "▰".repeat(filled))}${seg(tone("dim"), "▱".repeat(len - filled))} ${pal.fg(tone("text"), pc)}${lab ? pal.fg(tone("dim"), ` · ${lab}`) : ""}`;
  };
  const plainW = (len: number, lab: string) => len + 1 + pc.length + (lab ? 3 + displayWidth(lab) : 0);
  if (plainW(20, label) <= W) return styled(20, label);
  return styled(10, cut(label, W - plainW(10, "") - 3));   // W ≥ 30 leaves ≥ 12 columns for the label; the bar + pct never drop
}
function statsLine(stats: NonNullable<Body["stats"]>, W: number, tone: Tone, pal: Palette): string | undefined {
  const n = keepWhole(stats.map((s) => displayWidth(`${s.label} ${s.value}`)), W);
  if (!n) return undefined;
  const valueTone = (t?: Attention) => tone(t === "alert" ? "error" : t === "quiet" ? "dim" : "text");
  return stats.slice(0, n).map((s) => pal.fg(tone("dim"), `${s.label} `) + pal.fg(valueTone(s.tone), s.value)).join(pal.fg(tone("dim"), " · ")) + (n < stats.length ? pal.fg(tone("dim"), " …") : "");
}
function seriesLine(s: NonNullable<Body["series"]>, W: number, tone: Tone, pal: Palette): string | undefined {
  const pts = s.points.filter(Number.isFinite);
  if (!pts.length) return undefined;
  const last = fmtNum(pts[pts.length - 1]) + (s.unit ?? "");
  const n = Math.min(pts.length, SERIES_MAX, W - displayWidth(s.label) - displayWidth(last) - 2);
  if (n < SERIES_MIN) return undefined;
  return pal.fg(tone("dim"), `${s.label} `) + pal.fg(tone("text"), sparkline(pts, n)) + pal.fg(tone("text"), ` ${last}`);
}
function linksLine(links: NonNullable<Body["links"]>, W: number, tone: Tone, pal: Palette, stale: boolean): string | undefined {
  const n = keepWhole(links.map((l) => displayWidth(l.label)), W);
  if (!n) return undefined;
  const one = (l: { label: string; url: string }) => (stale ? pal.fg("dim", pal.link ? pal.link(linkMark(l.label), l.url) : l.label) : linkText(pal, l.label, l.url));
  return links.slice(0, n).map(one).join(pal.fg(tone("dim"), " · ")) + (n < links.length ? pal.fg(tone("dim"), " …") : "");
}

/** The body's lines within `W` columns (no gutter, no indent): progress · stats · series · links, each only when it fits. */
function bodyLines(r: Row, W: number, pal: Palette): string[] {
  const b = r.body;
  if (!b || W < MIN_BODY_W) return [];
  const tone: Tone = (t) => (b.stale ? "dim" : t);
  const out: string[] = [];
  const push = (l: string | undefined) => { if (l) out.push(l); };
  if (b.progress && Number.isFinite(b.progress.value)) push(progressLine(b.progress, W, tone(glyphToneOf(r)), tone, pal));
  if (b.stats?.length) push(statsLine(b.stats, W, tone, pal));
  if (b.series?.points.length) push(seriesLine(b.series, W, tone, pal));
  if (b.links?.length) push(linksLine(b.links, W, tone, pal, !!b.stale));
  return out;
}

/** Styled segments laid into `budget` columns; the first that does not fit is cut with … and ends the line. */
function styledCut(segs: Array<[string, string]>, budget: number, pal: Palette): string {
  let used = 0, out = "";
  for (const [text, tone] of segs) {
    const w = displayWidth(text);
    if (used + w <= budget) { out += pal.fg(tone, text); used += w; continue; }
    const piece = cut(text, budget - used);
    if (piece) out += pal.fg(tone, piece);
    break;
  }
  return out;
}

/** One line: boardSummary, plus ` · name 42% · first stat` for every row with a body, in rank order, cut at width.
 *  The row's detail (where ` · stale 40s` lives) is not on this line, so a stale body's numbers go dim and say ` · stale`. */
function foldedLines(d: SectionData, w: number, pal: Palette, o: { noun: string; hint: string }): string[] {
  const base = boardSummary(d.rows, w, d.title, pal, o);
  if (!base.length) return base;
  const said = byRank(d.rows).flatMap((r): Array<[string, string]> => {
    const b = r.body;
    const p = b?.progress && Number.isFinite(b.progress.value) ? ` ${pct(b.progress.value)}` : "";
    const s = b?.stats?.[0];
    if (!b || (!p && !s)) return [];
    const num = b.stale ? "dim" : "text";
    return [[" · ", "dim"], [`${r.name}${p}`, num], ...(s ? [[` · ${s.label} `, "dim"], [s.value, num]] as Array<[string, string]> : []), ...(b.stale ? [[" · ", "dim"], ["stale", "text"]] as Array<[string, string]> : [])];
  });
  if (!said.length) return base;
  return [base[0] + styledCut(said, w - displayWidth(base[0]), pal), ...base.slice(1)];
}

/** D97: two or more quiet rows (idle · done) on ONE dim line — `○ 3 idle · name 3h · name 2d …` — visible, never loud, never
 *  dropped. Whole items drop from the right with ` …`; the count always survives. Names keep their link (wrapped after the cut). */
export function quietFold(quiet: Row[], W: number, pal: Palette): string {
  const states = new Set(quiet.map((r) => r.state));
  const word = states.size === 1 ? quiet[0].state : "quiet";
  const glyph = states.size === 1 && quiet[0].state === "done" ? GLYPH.done : GLYPH.idle;
  const head = `${glyph} ${quiet.length} ${word}`;
  const items = quiet.map((r) => ({ name: r.name, age: elapsed(r.ageMs), url: r.url }));
  const n = keepWhole(items.map((i) => displayWidth(`${i.name} ${i.age}`)), W - displayWidth(head) - 3);
  const one = (i: typeof items[number]) => pal.fg("muted", pal.link && i.url ? pal.link(linkMark(i.name), i.url) : i.name) + pal.fg("dim", ` ${i.age}`);
  const rest = items.slice(0, n).map(one).join(pal.fg("dim", " · "));
  return pal.fg("dim", head) + (rest ? pal.fg("dim", " · ") + rest : "") + (n < items.length ? pal.fg("dim", " …") : "");
}

/** The host's renderer for a data section: gutter on every line; expanded = header · rows with their bodies · quiet fold ·
 *  "+N more"; folded = one line. With fewer than two quiet rows the expanded form is boardStyled byte for byte. */
export function sectionLines(d: SectionData, width: number, pal: Palette, folded = false): string[] {
  const w = width - 2, o = { noun: d.noun, hint: d.hint };
  const gutter = (l: string) => `${pal.fg("dim", GUTTER)}${l}`;
  if (folded) return foldedLines(d, w, pal, o).map(gutter);
  const quiet = byRank(d.rows).filter((r) => attentionOf(r) === "quiet");
  const fold = quiet.length >= 2;
  const loud = fold ? d.rows.filter((r) => attentionOf(r) !== "quiet") : d.rows;
  const max = fold ? MAX_ROWS - 1 : MAX_ROWS;
  const styled = boardStyled(loud, w, max, d.title, pal, o);
  const header = fold ? boardStyled(d.rows, w, 0, d.title, pal, o)[0] : styled[0];   // the count names every row, folded or not
  if (!header) return [];
  const shown = byRank(loud).slice(0, max);          // the same order boardStyled used, so line 1+i is row i
  const out = [header];
  shown.forEach((r, i) => { out.push(styled[1 + i], ...bodyLines(r, w - INDENT.length, pal).map((l) => INDENT + l)); });
  if (fold) out.push(quietFold(quiet, w, pal));
  if (styled.length > 1 + shown.length) out.push(styled[styled.length - 1]);
  return out.map(gutter);
}
