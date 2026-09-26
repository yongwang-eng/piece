/** The tmux side of tmux-dot: read every pane's state in one call, write one pane's state, paint one window's glyph. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Dot, type DotEvent, type PaneView, OPTION, GLYPH_OPTION, encodeDot, parseDot, next } from "./state.ts";

const run = promisify(execFile);
const SEP = "\u001f";

export async function tmux(args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args, { timeout: 3_000 });
  return stdout.replace(/\n$/, "");
}

/** Every pane on the server with its dot, window and foreground command — the painter's whole input. */
export async function readPanes(): Promise<PaneView[]> {
  const out = await tmux(["list-panes", "-a", "-F", `#{pane_id}${SEP}#{window_id}${SEP}#{pane_current_command}${SEP}#{${OPTION}}`]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [paneId, windowId, command, raw] = line.split(SEP);
    return { paneId, windowId, command, dot: parseDot(raw) };
  });
}

export async function readDot(pane: string): Promise<Dot | undefined> {
  try { return parseDot(await tmux(["show-options", "-pqv", "-t", pane, OPTION])); } catch { return undefined; }
}

export async function writeDot(pane: string, dot: Dot | undefined): Promise<void> {
  if (dot) await tmux(["set-option", "-p", "-t", pane, OPTION, encodeDot(dot)]);
  else await tmux(["set-option", "-pu", "-t", pane, OPTION]);
}

export async function paint(windowId: string, glyph: string): Promise<void> {
  await tmux(["set-option", "-w", "-t", windowId, GLYPH_OPTION, glyph]);
}

/** "Seen" = the pane's window is the current one in its session AND a client attached to that session has focus.
 *  `window_active` alone is 1 while you are in another app, and in every detached session. */
export async function isSeen(pane: string): Promise<boolean> {
  try {
    const [active, session] = (await tmux(["display-message", "-p", "-t", pane, `#{window_active}${SEP}#{session_name}`])).split(SEP);
    if (active !== "1") return false;
    const clients = await tmux(["list-clients", "-F", `#{session_name}${SEP}#{client_flags}`]);
    return clients.split("\n").some((l) => { const [s, flags] = l.split(SEP); return s === session && /\bfocused\b/.test(flags ?? ""); });
  } catch { return false; }
}

/** Panes of a window whose dot is unread or blocked → cleared (the human looked at the window). */
export async function markRead(windowId: string, now = Date.now()): Promise<void> {
  const panes = (await readPanes()).filter((p) => p.windowId === windowId && (p.dot?.state === "unread" || p.dot?.state === "blocked"));
  await Promise.all(panes.map((p) => writeDot(p.paneId, next(p.dot, { type: "read" }, now))));
}

/** Apply one event to one pane: read → next → write. tmux serializes the option writes; the transitions are idempotent. */
export async function apply(pane: string, ev: DotEvent, now = Date.now()): Promise<Dot | undefined> {
  if (ev.type === "blocked" && ev.seen === undefined) ev = { ...ev, seen: await isSeen(pane) };   // every producer, one rule
  const prev = await readDot(pane);
  const cur = next(prev, ev, now);
  if (JSON.stringify(cur) !== JSON.stringify(prev)) await writeDot(pane, cur);
  return cur;
}
