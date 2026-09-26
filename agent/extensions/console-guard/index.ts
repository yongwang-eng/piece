/**
 * Routes console.* away from a live TUI. Under a running screen a raw console.log is repainted
 * over mid-line and its URL is unclickable — pi-mcp-adapter's OAuth prompt landed as
 * "hubmcp:he stored tokens…" (2026-09-15). With a UI: first line → ui.notify (a message carrying
 * a URL is escalated to warning so it persists), URL → OSC-8 link + clipboard, full text →
 * state/extension-console.log. Without a UI (pi -p, json) console is untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";
import { render, type Level } from "./render.ts";

const LOG = join(homedir(), ".pi", "agent", "state", "extension-console.log");
const MARK = Symbol.for("pi.console-guard");
const METHODS = { log: "info", info: "info", warn: "warning", error: "error" } as const;
type Method = keyof typeof METHODS;
type Guard = { ui: { notify(m: string, t?: Level): void } | undefined; orig: Record<Method, (...a: unknown[]) => void>; last: { text: string; at: number } };

export default function consoleGuard(pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    if (!ctx.hasUI) return;
    const g = globalThis as unknown as Record<symbol, Guard | undefined>;
    const existing = g[MARK];
    // A reload re-imports this module but the console is already wrapped: re-point, never re-wrap.
    if (existing) { existing.ui = ctx.ui; return; }
    const guard: Guard = {
      ui: ctx.ui,
      orig: { log: console.log, info: console.info, warn: console.warn, error: console.error },
      last: { text: "", at: 0 },
    };
    g[MARK] = guard;
    for (const m of Object.keys(METHODS) as Method[]) console[m] = route(guard, m);
  });
  // After shutdown the screen is gone; let exit-time output reach the terminal again.
  pi.on("session_shutdown", () => { const g = (globalThis as unknown as Record<symbol, Guard | undefined>)[MARK]; if (g) g.ui = undefined; });
}

function route(guard: Guard, method: Method) {
  return (...args: unknown[]) => {
    const text = format(...(args as [unknown, ...unknown[]]));
    try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${method} ${text}\n`); } catch { /* the notify still happens */ }
    const ui = guard.ui;
    if (!ui) return guard.orig[method](...args);
    const now = Date.now();
    if (text === guard.last.text && now - guard.last.at < 3000) return; // the adapter repeats itself
    guard.last = { text, at: now };
    const r = render(text, METHODS[method]);
    if (r.urls.length) execFile("pbcopy", (err) => { if (err) guard.orig.warn(`console-guard: pbcopy failed: ${err.message}`); }).stdin?.end(r.urls[0]);
    try { ui.notify(r.text, r.level); } catch { guard.orig[method](...args); }
  };
}
