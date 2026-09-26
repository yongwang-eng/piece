/**
 * The mailbox card — what a room message looks like in a member's transcript. Pure; no pi imports.
 *
 *   beta · reviewer ▸ inform                                   #43 · 20:51
 *   <content>
 *   cites design/x.md §8 · §9
 *   reply `result` re #43 — or `refuse` if outside your responsibility        (requests/queries only)
 *
 * Who · role · kind · content is the card. Ids, run, addressees, four timestamps and reply syntax are RECORD
 * (room.jsonl) and ctrl+o, never on the line. A `notice` is never a card (digest only).
 */
import type { Envelope } from "./types.ts";

export interface CardInput {
  env: Envelope & { tools?: number; elapsedText?: string };
  senderRole?: string;
  /** hex colour for the sender's handle (lib/agent-ui/identity colorFor) */
  senderColor?: string;
  me: string;
  width: number;
}

export type Tone = "normal" | "ask" | "closure" | "error" | "dim";

/** The stamp: what kind of mail this is, before you read a word. */
export const STAMP: Record<string, string> = { request: "❓", query: "❓", inform: "✉", propose: "✉", result: "✓", accept: "✓", refuse: "✗", error: "✗", aborted: "✗", done: "✔", notice: "·" };
// ❓ asks (amber border — needs someone) · ✉ tells (blue) · ✓ closes (green) · ✗ refuses/errors (red) · ✔ done (dim)

export function stamp(env: CardInput["env"]): string {
  const k = (env as any).report === "done" ? "done" : (env as any).report === "aborted" ? "aborted" : env.kind;
  return STAMP[k] ?? "✉";
}

export interface CardLines {
  /** [left, right] for the header — caller pads between them */
  header: { left: string; right: string; tone: Tone; senderColor?: string; senderLen: number; stamp: string };
  body: string[];
  cites?: string;
  guidance?: string;
}

const KIND_TONE: Record<string, Tone> = { request: "ask", query: "ask", inform: "normal", result: "closure", accept: "closure", refuse: "closure", propose: "normal", error: "error", aborted: "error", done: "closure", notice: "dim" };

export function hhmm(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The verb shown after ▸. `done` = a worker's end-of-turn report; carries tools/elapsed. */
export function kindLabel(env: CardInput["env"]): string {
  const k = (env as any).report === "done" ? "done" : (env as any).report === "aborted" ? "aborted" : env.kind;
  const bits = [k];
  if (env.re && k !== "done") bits.push(`re #${shortRef(env.re)}`);
  if ((env as any).report && env.tools !== undefined) bits.push(`${env.tools} tool${env.tools === 1 ? "" : "s"}`);
  if ((env as any).report && env.elapsedText) bits.push(env.elapsedText);
  return bits.join(" · ");
}

export function shortRef(re: string): string {
  // "c-beta-2" stays; "beta-8f0a46" → "8f0a46"; numbers stay
  if (/^c-/.test(re) || /^\d+$/.test(re)) return re;
  const m = /-([0-9a-f]{6,8})$/.exec(re); return m ? m[1] : re.slice(0, 8);
}

export function card(i: CardInput): CardLines {
  const { env } = i;
  const kind = (env as any).report === "aborted" ? "aborted" : (env as any).report === "done" ? "done" : env.kind;
  const tone = KIND_TONE[kind] ?? "normal";
  const to = env.to.filter((t) => t !== i.me);
  const arrow = to.length ? ` → ${to.join(",")}` : "";              // omitted when it is just to me
  const left = `${env.from}${i.senderRole ? ` · ${i.senderRole}` : ""} ▸ ${kindLabel(env)}${arrow}`;
  const right = [env.seq !== undefined ? `#${env.seq}` : "", hhmm(env.at)].filter(Boolean).join(" · ");
  const body = env.text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const cites = env.cites?.length ? `cites ${env.cites.join(" · ")}` : undefined;
  const asksMe = (env.kind === "request" || env.kind === "query") && env.to.includes(i.me);
  const guidance = asksMe
    ? env.kind === "query"
      ? `reply \`inform\` re #${env.seq ?? shortRef(env.id)} (cite file:line) — or \`refuse\` if outside your responsibility`
      : `reply \`result\` re #${env.seq ?? shortRef(env.id)} — or \`refuse\` / \`propose\` if you would do it differently`
    : undefined;
  return { header: { left, right, tone, senderColor: i.senderColor, senderLen: env.from.length, stamp: stamp(env) }, body, cites, guidance };
}

/**
 * Rendering — a Material "outlined field": subtle rounded border, the title cut into the top rule, body inset.
 *
 *   ╭ ❓ alpha · doc owner ▸ query · 17:44 ─────────────────────╮
 *   │  Does the doc's D43 delivery table match lanes.ts?         │
 *   │  reply `inform` re #d397272f — or `refuse` …               │
 *   ╰────────────────────────────────────────────────────────────╯
 *
 * Border is dim and never carries meaning; urgency lives in the stamp + kind colour; who lives in the sender colour.
 * Width is the caller's (pi passes the message area); rows are padded so the right edge is straight.
 */
export const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const INSET = "  ";

export function vlen(s: string): number { return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length; }

export function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || vlen(line) <= width) return [line];
  const out: string[] = []; let cur = "";
  for (const word of line.split(" ")) {
    if (!cur) { cur = word; continue; }
    if (vlen(cur) + 1 + vlen(word) <= width) cur += " " + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out.flatMap((l) => { const r: string[] = []; let c = ""; for (const ch of l) { if (vlen(c) >= width) { r.push(c); c = ""; } c += ch; } if (c) r.push(c); return r; });
}

export interface Painter { border(s: string): string; stamp(s: string): string; sender(s: string): string; role(s: string): string; kind(s: string): string; dim(s: string): string; }
const plain: Painter = { border: (s) => s, stamp: (s) => s, sender: (s) => s, role: (s) => s, kind: (s) => s, dim: (s) => s };

export function captionLine(c: CardLines): string { return `${c.header.stamp} ${c.header.left}${c.header.right ? ` · ${c.header.right}` : ""}`; }

/** Render the outlined card at `width` columns. The plain painter is what tests see. */
export function renderBox(c: CardLines, width: number, paint: Painter = plain, senderName?: string): string[] {
  const W = Math.max(30, width);
  const inner = W - 2 - INSET.length - 1;                              // "│" + inset … + " │"
  const capPlain = captionLine(c);
  const sender = senderName ?? c.header.left.split(" ")[0];
  const afterSender = c.header.left.slice(sender.length);
  const [rolePart, kindPart] = afterSender.split(/(?=▸)/);
  const capPainted = `${paint.stamp(c.header.stamp)} ${paint.sender(sender)}${paint.role(rolePart ?? "")}${paint.kind(kindPart ?? "")}${c.header.right ? paint.dim(` · ${c.header.right}`) : ""}`;
  const fill = Math.max(1, W - 2 - vlen(capPlain) - 2);              // "╭ " + caption + " " + fill + "╮"
  const top = `${paint.border(`${BOX.tl} `)}${capPainted}${paint.border(` ${BOX.h.repeat(fill)}${BOX.tr}`)}`;
  const row = (plainText: string, painted = plainText) => `${paint.border(BOX.v)}${INSET}${painted}${" ".repeat(Math.max(0, inner - vlen(plainText)))} ${paint.border(BOX.v)}`;
  const out = [top];
  for (const l of c.body) for (const w of wrapLine(l, inner)) out.push(row(w));
  if (c.cites) for (const w of wrapLine(c.cites, inner)) out.push(row(w, paint.dim(w)));
  if (c.guidance) for (const w of wrapLine(c.guidance, inner)) out.push(row(w, paint.dim(w)));
  out.push(paint.border(`${BOX.bl}${BOX.h.repeat(W - 2)}${BOX.br}`));
  return out;
}

export function renderPlain(c: CardLines, width = 80): string[] { return renderBox(c, width); }

// ── the card FAMILY: same grammar (stamp · caption cut into the rule · inset body), frame says what kind of thing ──
//   message   ╭ ✉ …  ╮   light  — mail between members
//   roster    ╭ ⌂ who ╮   light, one row per member, presence glyph + colour
//   consult   ┏ ◆ …  ┓   HEAVY  — a blocked call and its answer; the one thing in the pane that stops the worker
//   decision  ┏ ◆ …  ┓   HEAVY, amber — main's card for the human (the same weight: it is the other end of the consult)

export const HEAVY = { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };

export interface BoxStyle { tl: string; tr: string; bl: string; br: string; h: string; v: string }

/** Generic outlined block: caption in the rule, then body rows (already painted or plain). */
export function outlined(caption: string, captionPlainLen: number, rows: Array<{ text: string; plain?: string }>, width: number, paint: Painter, box: BoxStyle = BOX): string[] {
  const W = Math.max(30, width);
  const inner = W - 2 - INSET.length - 1;
  const fill = Math.max(1, W - 2 - captionPlainLen - 2);
  const out = [`${paint.border(`${box.tl} `)}${caption}${paint.border(` ${box.h.repeat(fill)}${box.tr}`)}`];
  for (const r of rows) {
    const plain = r.plain ?? r.text;
    for (const w of wrapLine(plain, inner)) {
      const painted = plain === r.text ? w : (w === plain ? r.text : w);   // painted rows must be single-line; wrapped rows fall back to plain
      out.push(`${paint.border(box.v)}${INSET}${painted}${" ".repeat(Math.max(0, inner - vlen(w)))} ${paint.border(box.v)}`);
    }
  }
  out.push(paint.border(`${box.bl}${box.h.repeat(W - 2)}${box.br}`));
  return out;
}

export const PRESENCE_GLYPH: Record<string, string> = { starting: "◌", idle: "○", working: "●", compacting: "◐", blocked: "◆", stalled: "◆", gone: "×" };

/** room_who as a roster card: one row per member — glyph · name · role · owns (truncated), owner first if a topic matched. */
export function rosterRows(members: Array<{ name: string; id?: number; role?: string; presence?: string; responsibility?: string }>, width: number): Array<{ plain: string; name: string; id?: number; presence?: string }> {
  const inner = Math.max(20, width - 6);
  return members.map((m) => {
    const head = `${PRESENCE_GLYPH[m.presence ?? "idle"] ?? "○"} ${m.id ? `#${m.id} ` : ""}${m.name}${m.role && m.role !== m.name ? ` · ${m.role}` : ""}`;
    const room = inner - vlen(head) - 3;
    const owns = (m.responsibility ?? "").replace(/\s+/g, " ").trim();
    const tail = owns ? ` — ${room > 12 ? (vlen(owns) > room ? owns.slice(0, room - 1) + "…" : owns) : ""}` : "";
    return { plain: `${head}${tail}`, name: m.name, id: m.id, presence: m.presence };
  });
}
