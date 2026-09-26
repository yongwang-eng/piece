/**
 * The area below the input is ONE widget with named sections in a fixed ORDER. pi's setWidget re-inserts a key at the
 * end on every call, so separate widgets jump as they repaint; here producers publish a Section through a typed Board and
 * the host renders them all. A Section is DATA (rows + what they say; the host paints, folds and cuts — section.ts) or a
 * `render` fn (the escape hatch for a producer whose extras are nobody else's fields). The pi.events transport is this
 * file's private business — no producer or host names an event.
 */
import type { Palette } from "./board.ts";
import { sectionLines, type SectionData } from "./section.ts";
import { cut } from "./width.ts";

export type Theme = { fg(tone: string, s: string): string; bold(s: string): string };
// A union, not two optionals: "neither" and "both" have no producer, so the host never invents a precedence rule for them.
export type Section =
  | { id: string; data: SectionData; render?: never }
  | { id: string; render(width: number, theme: Theme): string[]; data?: never };
export interface Board { section(s: Section): void; remove(id: string): void }

/** Position by section id. An unlisted producer lands after the known ones, alphabetically — visible, never lost. */
export const ORDER: Record<string, number> = { todo: 0, compaction: 5, bg: 10, devin: 20, "crew-board": 30 };
export const orderOf = (id: string): number => ORDER[id] ?? 50;
const byOrder = (a: string, b: string) => orderOf(a) - orderOf(b) || a.localeCompare(b);

/** `folded` = ctrl+] (data sections fold here; render producers hear `board:fold`); `off` = sections switched off by id. */
export type ComposeOpts = { folded?: boolean; off?: Set<string> };
export function compose(sections: Iterable<Section>, width: number, pal: Palette, o: ComposeOpts = {}): string[] {
  const sorted = [...sections].sort((a, b) => byOrder(a.id, b.id));
  const off = o.off ?? new Set<string>();
  const blocks = sorted.filter((s) => !off.has(s.id)).map((s) => { try { return s.data ? sectionLines(s.data, width, pal, o.folded) : s.render(width, pal); } catch { return []; } });
  // One blank line between sections: the `┊` gutters would otherwise fuse into a single unbroken column.
  const lines = blocks.filter((b) => b.length).flatMap((b, i) => (i ? ["", ...b] : b));
  // The tell: a switched-off section that HAS items is named, last — the moment it gains items is the moment to be reminded.
  const hidden = sorted.filter((s) => off.has(s.id)).map((s) => s.id);
  if (hidden.length) lines.push(pal.fg("dim", cut(`┊ off: ${hidden.join(" · ")} — /board on ${hidden.length === 1 ? hidden[0] : "<id>"}`, width)));
  return lines;
}

/** `/board on [id] · off <id> · only <id>` over the ids in ORDER ∪ published; `id` matches exactly, else as a prefix (`crew` → `crew-board`). */
export function switchOff(off: Set<string>, verb: "on" | "off" | "only", id: string | undefined, published: Iterable<string>): { off: Set<string>; ok: boolean; message: string } {
  const known = [...new Set([...Object.keys(ORDER), ...published])].sort(byOrder);
  if (verb === "on" && !id) return { off: new Set(), ok: true, message: "every section on" };
  if (!id) return { off, ok: false, message: `/board ${verb} needs a section id: ${known.join(" · ")}` };
  const match = known.find((k) => k === id) ?? known.find((k) => k.startsWith(id));
  if (!match) return { off, ok: false, message: `no section “${id}” — ids: ${known.join(" · ")}` };
  const next = verb === "only" ? new Set(known.filter((k) => k !== match)) : new Set(off);
  if (verb === "off") next.add(match); else if (verb === "on") next.delete(match);
  return { off: next, ok: true, message: verb === "on" ? `${match} on` : verb === "off" ? `${match} off — /board on ${match}` : `only ${match} — /board on for the rest` };
}

// ---- transport (pi.events under the hood; a host that loads after a producer asks and gets every retained section) ----
type Bus = { events: { on(name: string, fn: (p: any) => void): () => void; emit(name: string, payload: unknown): unknown } };
const PUBLISH = "board:section", READY = "board:ready";

export function boardOf(pi: Bus): Board {
  const mine = new Map<string, Section>();
  pi.events.on(READY, () => { for (const s of mine.values()) pi.events.emit(PUBLISH, s); });
  return {
    section(s) { mine.set(s.id, s); pi.events.emit(PUBLISH, s); },
    remove(id) { mine.delete(id); pi.events.emit(PUBLISH, { id }); },
  };
}

/** Host side: `onChange` gets the current sections after every publish/remove; call `ready()` once the UI can paint. */
export function hostBoard(pi: Bus, onChange: (sections: Section[]) => void): { ready(): void; dispose(): void } {
  const all = new Map<string, Section>();
  const off = pi.events.on(PUBLISH, (s: Partial<Section> & { id: string }) => {
    if (s.render || s.data) all.set(s.id, s as Section); else all.delete(s.id);
    onChange([...all.values()]);
  });
  return { ready: () => pi.events.emit(READY, {}), dispose: () => { off(); all.clear(); } };
}
