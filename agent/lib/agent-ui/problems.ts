/**
 * problems — the ONE place an extension reports something it could not heal.
 *
 * pi paints `console.error` from an extension as raw, unselectable stderr lines above the editor, one per
 * occurrence — a failing hook that fires once per model call becomes a wall in an hour. So: extensions never
 * console.error in a TUI. They report here, and the human sees
 *   · one toast on first sight, again at ×10 / ×100 / ×1000 (never per occurrence)
 *   · a footer status with the coalesced count, which cannot scroll away
 *   · /problems for the list; every occurrence, full text, in state/problems.log for grep.
 * Headless or before any session_start: stderr, once per key.
 *
 * Process-wide like the registry: every extension is its own jiti module graph, so the ledger and the UI
 * handle live on a globalThis symbol, not in module state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Problem = { key: string; message: string; hint?: string; count: number; first: number; last: number };
type Ui = { hasUI: boolean; ui: { notify(msg: string, level?: "info" | "warning" | "error"): void; setStatus(key: string, text: string | undefined): void } };
type Slot = { ledger: Map<string, Problem>; ui?: Ui; logged: Set<string>; logPath?: string };

const KEY = Symbol.for("pi.agent.problems");
const slot = (): Slot => {
  const g = globalThis as Record<symbol, unknown>;
  return (g[KEY] as Slot | undefined) ?? ((g[KEY] = { ledger: new Map(), logged: new Set() } as Slot) as Slot);
};

const isToastPoint = (n: number) => n === 1 || (n >= 10 && Math.log10(n) % 1 === 0);

const footer = (s: Slot) => {
  if (!s.ui?.hasUI) return;
  const list = [...s.ledger.values()];
  if (list.length === 0) { s.ui.ui.setStatus("problems", undefined); return; }
  const total = list.reduce((n, p) => n + p.count, 0);
  s.ui.ui.setStatus("problems", `⚠ ${list.length} problem${list.length === 1 ? "" : "s"} ×${total} · /problems`);
};

export type Problems = {
  report(key: string, message: string, opts?: { hint?: string; error?: unknown }): void;
  list(): Problem[];
  clear(): void;
};

export function problems(pi: Pick<ExtensionAPI, "on">, logPath: string): Problems {
  const s = slot();
  s.logPath = logPath;
  pi.on("session_start", (_e, ctx) => { s.ui = ctx as unknown as Ui; footer(s); });
  return {
    report(key, message, opts = {}) {
      const s = slot();
      const text = opts.error === undefined ? message : `${message}: ${String(opts.error)}`;
      const now = Date.now();
      const p = s.ledger.get(key) ?? { key, message: text, hint: opts.hint, count: 0, first: now, last: now };
      p.count += 1; p.last = now; p.message = text; if (opts.hint) p.hint = opts.hint;
      s.ledger.set(key, p);
      if (s.logPath) {
        try {
          mkdirSync(dirname(s.logPath), { recursive: true });
          appendFileSync(s.logPath, `${new Date(now).toISOString()} ${key} ×${p.count} ${text}${p.hint ? `  hint: ${p.hint}` : ""}\n`);
        } catch { /* a reporter that throws is worse than a lost line */ }
      }
      if (s.ui?.hasUI) {
        if (isToastPoint(p.count)) s.ui.ui.notify(`${text}${p.count > 1 ? `  (×${p.count})` : ""}${p.hint ? `\n${p.hint}` : ""}`, "warning");
        footer(s);
      } else if (!s.logged.has(key)) {
        s.logged.add(key);
        console.error(`[problem] ${text}${p.hint ? `  (${p.hint})` : ""}`);
      }
    },
    list: () => [...slot().ledger.values()].sort((a, b) => b.last - a.last),
    clear() { const s = slot(); s.ledger.clear(); s.logged.clear(); footer(s); },
  };
}

/** Test seam. */
export function resetProblems(): void { delete (globalThis as Record<symbol, unknown>)[KEY]; }
