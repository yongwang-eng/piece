import type { DotEvent } from "../../lib/tmux-dot/state.ts";

export const EVENT_TO_STATUS = {
  agent_start: "working",
  tool_execution_end: "touch",
  agent_settled: "done",
  session_shutdown: "end",
} as const;

/** The events a settling turn emits. A turn that ends owing Yong an answer (`waiting_on_you` was called) settles as
 *  done THEN blocked — blocked must come after, or `done` overwrites it. Both carry `seen`: a window he is looking at
 *  raises nothing. The next prompt's `working`, or looking at the window, clears it. */
export const settle = (seen: boolean, owed?: string): DotEvent[] =>
  owed === undefined ? [{ type: "done", seen }] : [{ type: "done", seen }, { type: "blocked", reason: owed, seen }];

/** `waiting_on_you`'s payload: ONE ask, optionally the numbered options (2–4, ⭐ on `pick`). The card the tool paints is what
 *  Yong reads — never the prose above it (Yong 2026-09-23: "no bullet, no suggestion, nothing I have a clue without reading it"). */
export interface Owed { reason: string; options?: string[]; pick?: number }

/** The deterministic half of "one ask per turn": a reason joined with ' · ' is several asks (the six-turn `· Colin pick 1–3` drift). */
export function owedProblem(o: Owed): string | undefined {
  if (o.reason.includes(" · ")) return "one ask per call — split on ' · ' found; ask the first now and drop or re-ask the rest later";
  if (o.options !== undefined && (o.options.length < 2 || o.options.length > 4)) return "options need 2–4 entries, each 'label — consequence'";
  if (o.pick !== undefined && (!o.options || o.pick < 1 || o.pick > o.options.length)) return "pick must index an option (1-based)";
  return undefined;
}

export function owedCard(o: Owed): string[] {
  const head = `◆ WAITING ON YOU — ${o.reason}`;
  if (!o.options) return [head, "  yes / no, or a different opinion"];
  return [head, ...o.options.map((opt, i) => `  ${i + 1} ${o.pick === i + 1 ? "⭐" : "  "} ${opt}`), "  type a number, or a different opinion"];
}
