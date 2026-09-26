/**
 * Two-key consults (D73) — the LIST half. A human-required consult whose act matches a row here is MISTAKE-class:
 * main and the governor may settle it together; Yong gets a note with a veto instead of a card that blocks a worker.
 *
 * Pure and deterministic: no model reads this. Absence is the deny — an unlisted shape is incident-class and reaches Yong.
 */
import { readFileSync } from "node:fs";

export interface ClassRow { verb: string; target?: string; repo?: "own"; unless?: string; why: string }
export interface MistakeShape { row: ClassRow; why: string }

/** Rows from `config/consult_classes.json`; a missing/malformed file or a row without a `why` yields nothing (fail closed). */
export function loadClassRows(path: string): ClassRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
  const rows = (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is ClassRow => !!r && typeof r === "object" && typeof (r as ClassRow).verb === "string" && typeof (r as ClassRow).why === "string" && (r as ClassRow).why.trim().length > 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = (pattern: string, cwd?: string): RegExp | undefined => {
  try { return new RegExp(cwd ? pattern.replaceAll("${cwd}", escapeRe(cwd.replace(/\/+$/, ""))) : pattern, "i"); } catch { return undefined; }
};

/** The first row the submitted act satisfies, or undefined. `repoClass` is repos.json's verdict for the worker's cwd. */
export function mistakeShape(
  req: { action?: { verb: string; target: string; detail?: string }; question: string },
  repoClass: string,
  rows: ClassRow[],
  cwd?: string,
): MistakeShape | undefined {
  const a = req.action;
  if (!a?.verb) return undefined;
  const haystack = [a.verb, a.target, a.detail, req.question].filter(Boolean).join("\n");
  for (const row of rows) {
    if (row.repo === "own" && repoClass !== "own") continue;
    if (row.target?.includes("${cwd}") && !cwd) continue;
    const verb = re(row.verb); if (!verb || !verb.test(a.verb.trim())) continue;
    if (row.target) { const target = re(row.target, cwd); if (!target || !target.test(a.target.trim())) continue; }
    if (row.unless) { const unless = re(row.unless); if (!unless || unless.test(haystack)) continue; }
    return { row, why: row.why };
  }
  return undefined;
}
