/**
 * mains — the policy half of cross-session coordination (D70). Pure: no pi, no Redis.
 *
 * A `mains` envelope is from a main BECAUSE it arrived on the `mains` room; nothing here inspects `from` to decide
 * trust. `from` is still checked against the room's live client names so a replayed or hand-published envelope with a
 * name nobody holds is dropped and logged (spoof guard, mistake-class).
 */
import { basename } from "node:path";

export const MAINS_RUN = "mains";
export const MAIN_PREFIX = "main@";

/** `main@<cwd-basename>#<pid>` — set from the process at join, matches the Redis client name (CLIENT LIST verifies it). */
export const mainName = (cwd: string, pid: number) => `${MAIN_PREFIX}${basename(cwd).replace(/\s+/g, "_")}#${pid}`;
export const isMainName = (n: string) => n.startsWith(MAIN_PREFIX);

export type ReloadScope = "extensions" | "prompt";
export type Control =
  | { cmd: "reload"; scope: ReloadScope; reason?: string }
  | { cmd: "hold"; reason?: string }
  | { cmd: "ping" };

export const parseControl = (text: string): Control | undefined => {
  let b: any; try { b = JSON.parse(text); } catch { return undefined; }
  if (!b || typeof b !== "object") return undefined;
  if (b.cmd === "reload" && (b.scope === "extensions" || b.scope === "prompt")) return { cmd: "reload", scope: b.scope, reason: typeof b.reason === "string" ? b.reason.slice(0, 200) : undefined };
  if (b.cmd === "hold") return { cmd: "hold", reason: typeof b.reason === "string" ? b.reason.slice(0, 200) : undefined };
  if (b.cmd === "ping") return { cmd: "ping" };
  return undefined;
};

/**
 * What the receiving main does with a reload request: it ASKS its owner — always (Yong 2026-09-14: "no force doing it",
 * after an automatic reload took three sessions down). A session is torn down only by the person sitting at it. The
 * scope is carried for the toast: PROMPT scope rewrites the whole cache at 1.25x fresh (EXP-003 §5c), so the owner may
 * want to compact first.
 */
export type ReloadPlan = { act: "ask-owner" } | { act: "ignore"; why: string };
export const planReload = (req: { scope: ReloadScope; from: string; self: string }): ReloadPlan =>
  req.from === req.self ? { act: "ignore", why: "own echo" } : { act: "ask-owner" };

/** Spoof guard: the sender must be a live client of the mains room right now. */
export const senderIsLive = (from: string, livePeers: readonly string[]) => isMainName(from) && livePeers.includes(from);

/** One toast line per control, in the `mains` lane — never blended into the crew digest. */
export const laneText = (from: string, c: Control, plan?: ReloadPlan): string => {
  const who = from.replace(MAIN_PREFIX, "");
  if (c.cmd === "ping") return `mains · ${who} pinged`;
  if (c.cmd === "hold") return `mains · ${who} asks every main to hold${c.reason ? ` — ${c.reason}` : ""}`;
  const why = c.reason ? ` — ${c.reason}` : "";
  return c.scope === "prompt"
    ? `mains · ${who} asks you to /reload (prompt scope${why}) — compact first if the ledger is big`
    : `mains · ${who} asks you to /reload${why}`;
};
