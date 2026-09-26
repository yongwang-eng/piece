/** Pure todo state: reducer, replay, render, projection. No pi imports — unit-tested directly. */

export type Status = "pending" | "in_progress" | "done";
export interface Task { id: number; text: string; status: Status; blockedBy: number[] }
export interface State { tasks: Task[]; nextId: number; error?: string }
export type Action =
  | { action: "add"; text?: string; blockedBy?: number[] }
  | { action: "start" | "done" | "remove"; id?: number }
  | { action: "list" };

export const EMPTY: State = { tasks: [], nextId: 1 };

const fail = (s: State, error: string): State => ({ tasks: s.tasks, nextId: s.nextId, error });
const clean = (tasks: Task[], nextId: number): State => ({ tasks, nextId });

export function apply(s: State, a: Action): State {
  switch (a.action) {
    case "list":
      return clean(s.tasks, s.nextId);
    case "add": {
      const text = (a.text ?? "").trim();
      if (!text) return fail(s, "text required");
      const blockedBy = [...new Set(a.blockedBy ?? [])];
      for (const b of blockedBy) if (!s.tasks.some((t) => t.id === b)) return fail(s, `no task #${b}`);
      return clean([...s.tasks, { id: s.nextId, text, status: "pending", blockedBy }], s.nextId + 1);
    }
    case "start":
    case "done":
    case "remove": {
      const t = s.tasks.find((x) => x.id === a.id);
      if (!t) return fail(s, `no task #${a.id}`);
      if (a.action === "remove") return clean(s.tasks.filter((x) => x.id !== t.id), s.nextId);
      if (a.action === "start") {
        const open = t.blockedBy.filter((b) => s.tasks.find((x) => x.id === b)?.status !== "done");
        if (open.length) return fail(s, `#${t.id} is blocked by ${open.map((b) => `#${b}`).join(", ")}`);
      }
      const status: Status = a.action === "start" ? "in_progress" : "done";
      return clean(s.tasks.map((x) => (x.id === t.id ? { ...x, status } : x)), s.nextId);
    }
  }
}

/** Board-only: done rows completed before `sinceId` were seen last turn and leave the screen. State keeps them. */
export const visibleTasks = (s: State, hideDoneBefore: number): Task[] =>
  s.tasks.filter((t) => t.status !== "done" || t.id >= hideDoneBefore);

const isState = (v: unknown): v is State =>
  !!v && typeof v === "object" && Array.isArray((v as State).tasks) && typeof (v as State).nextId === "number";

/** Truth lives in the transcript: the LAST `todo` toolResult's `details` on the branch wins. */
export function replay(branch: Iterable<unknown>): State {
  let out: State = EMPTY;
  for (const e of branch as Iterable<any>) {
    if (e?.type !== "message" || e.message?.role !== "toolResult" || e.message.toolName !== "todo") continue;
    if (isState(e.message.details)) out = clean(e.message.details.tasks.map((t: Task) => ({ ...t })), e.message.details.nextId);
  }
  return out;
}

export const GLYPH: Record<Status, string> = { pending: "○", in_progress: "◐", done: "✓" };

export interface RenderOpts { maxLines: number; plain?: boolean; fg?: (color: string, s: string) => string; hideDoneBefore?: number }

/** Widget lines: heading + tasks in id order (the glyph carries status, so progress reads as a wave down the list),
 *  capped with a `+N more` tail. Over budget, done rows are the first to be hidden. Empty state → []. */
export function renderLines(s: State, o: RenderOpts): string[] {
  const tasks = visibleTasks(s, o.hideDoneBefore ?? 0);
  if (!tasks.length) return [];
  const fg = o.plain || !o.fg ? (_c: string, x: string) => x : o.fg;
  const done = s.tasks.filter((t) => t.status === "done").length;
  const head = fg("dim", `Todos ${done}/${s.tasks.length}`);
  const budget = Math.max(1, o.maxLines - 1);
  let shown = tasks;
  if (tasks.length > budget) {
    const keep = new Set(tasks.filter((t) => t.status !== "done").slice(0, budget - 1).map((t) => t.id));
    for (const t of tasks) if (keep.size < budget - 1 && !keep.has(t.id)) keep.add(t.id);
    shown = tasks.filter((t) => keep.has(t.id));
  }
  const lines = shown.map((t) => {
    const color = t.status === "done" ? "success" : t.status === "in_progress" ? "warning" : "dim";
    const text = t.status === "done" ? fg("dim", t.text) : t.text;
    return `${fg(color, GLYPH[t.status])} #${t.id} ${text}`;
  });
  if (shown.length < tasks.length) lines.push(fg("dim", `+${tasks.length - shown.length} more`));
  return [head, ...lines];
}

/** The file projection (D32): read-only, derived on every write, for humans + handoff briefs. */
export function projectMarkdown(s: State): string {
  const box: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };
  const lines = s.tasks.map((t) => {
    const blocked = t.blockedBy.length ? ` (blocked by ${t.blockedBy.map((b) => `#${b}`).join(", ")})` : "";
    return `- ${box[t.status]} #${t.id} ${t.text}${blocked}`;
  });
  return `# Todos\n\n<!-- projection of the session todo list; regenerated on every change — do not edit -->\n\n${lines.join("\n")}\n`;
}
