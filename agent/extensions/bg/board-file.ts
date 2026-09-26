/**
 * `/tmp/pi-bg/<name>.board.json` — what a bg job SAYS about itself (a Body + one `detail` override), written by any
 * script, read by bg each tick and laid on that job's row. The process's liveness and age stay bg's observation.
 * Everything here is defensive on purpose: a bad field is dropped, a half-written or oversized file keeps the previous
 * read, and staleness is measured from the last GOOD parse — nothing a script writes can throw or show garbage.
 * Pure over fs; no pi imports.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import type { Row } from "../../lib/agent-ui/board.ts";
import type { Body } from "../../lib/agent-ui/section.ts";
import { elapsed } from "../../lib/agent-ui/time.ts";

export const STALE_MS = 30_000;
export const MAX_BYTES = 65_536;
const MAX_STATS = 8, MAX_LINKS = 6, MAX_POINTS = 120;
const SCHEME = /^(file|https?|obsidian):/i;

export type FileBody = { detail: string | undefined; body: Body };
export type FileRead = FileBody & { mtimeMs: number };

const oneLine = (v: unknown): string | undefined => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ⏎ ").replace(/\p{C}/gu, "").trim() : undefined);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The file's text → detail + Body with every invalid piece dropped; `undefined` only when the whole file is not a JSON object. */
export function parseBoardFile(text: string): FileBody | undefined {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!obj(raw)) return undefined;
  const body: Body = {};
  const p = raw.progress;
  if (obj(p) && num(p.value)) { const label = oneLine(p.label); body.progress = { value: Math.min(1, Math.max(0, p.value)), ...(label ? { label } : {}) }; }
  if (Array.isArray(raw.stats)) {
    const stats = raw.stats.filter((s): s is Record<string, unknown> => obj(s) && typeof s.label === "string" && typeof s.value === "string").slice(0, MAX_STATS)
      .map((s) => ({ label: oneLine(s.label)!, value: oneLine(s.value)!, ...(s.tone === "alert" || s.tone === "quiet" || s.tone === "live" ? { tone: s.tone } : {}) }));
    if (stats.length) body.stats = stats;
  }
  const se = raw.series;
  if (obj(se) && typeof se.label === "string" && Array.isArray(se.points)) {
    const points = se.points.filter(num).slice(-MAX_POINTS);
    const unit = oneLine(se.unit);
    if (points.length) body.series = { label: oneLine(se.label)!, points, ...(unit ? { unit } : {}) };
  }
  if (Array.isArray(raw.links)) {
    // a URL rides inside an OSC 8 escape: whitespace or a control character in it would end the sequence early
    const links = raw.links.filter((l): l is Record<string, unknown> => obj(l) && typeof l.label === "string" && typeof l.url === "string" && SCHEME.test(l.url) && !/[\s\p{C}]/u.test(l.url)).slice(0, MAX_LINKS)
      .map((l) => ({ label: oneLine(l.label)!, url: l.url as string }));
    if (links.length) body.links = links;
  }
  return { detail: oneLine(raw.detail) || undefined, body };
}

/** One tick's read: a good file → its body with the file's mtime; unparseable or > 64 KB → `prev`; no file → nothing. */
export function readBoardFile(path: string, prev: FileRead | undefined): FileRead | undefined {
  let st: { size: number; mtimeMs: number };
  try { st = statSync(path); } catch { return undefined; }
  if (st.size > MAX_BYTES) return prev;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return prev; }
  const parsed = parseBoardFile(text);
  return parsed ? { ...parsed, mtimeMs: st.mtimeMs } : prev;
}

/** The file laid over bg's row: detail replaced when the file has one, body attached; past STALE_MS the body dims and the detail says how old. */
export function withBoardFile(row: Row, read: FileRead | undefined, now: number): Row {
  if (!read) return row;
  const age = now - read.mtimeMs;
  const detail = read.detail ?? row.detail;
  if (age <= STALE_MS) return { ...row, detail, body: read.body };
  return { ...row, detail: `${detail} · stale ${elapsed(age)}`, body: { ...read.body, stale: true } };
}

/** bg_run truncates `<name>.log`; the previous run's board file goes the same way, or its body would haunt the new job. */
export const clearBoardFile = (path: string): void => { try { rmSync(path, { force: true }); } catch { /* a projection */ } };
