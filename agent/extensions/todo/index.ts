/**
 * todo — a checklist the model keeps and you can see (the Claude Code TodoWrite pattern, light).
 *
 * Truth = the transcript: every `todo` tool result carries the full state in `details` (persisted,
 * hidden from the model, survives compaction/fork); on session_start/compact/tree we replay the
 * branch. Projection = `.pi/todo.md` in the cwd, regenerated on every write, never read back (D32).
 * Widget below the editor, above crew; done rows drop at the next turn.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { EMPTY, GLYPH, apply, projectMarkdown, renderLines, replay, type Action, type State } from "./core.ts";

const WIDGET = "todo";
const MAX_LINES = 8;

const GUIDANCE = `## Todo list
You have a \`todo\` tool. Use it for work with 3+ steps that each involve real effort — editing, running, investigating — where the human benefits from watching progress. Not for a few quick commands. When you use it: \`add\` the steps first, \`start\` one before doing it, \`done\` it right after. Short items (≤ 60 chars, verb first); \`blockedBy\` when order matters; one in progress at a time.`;

export default function todo(pi: ExtensionAPI) {
  let state: State = EMPTY;
  let uiCtx: { ui: { setWidget: (k: string, v: string[] | undefined, options?: { placement: "belowEditor" }) => void; theme?: { fg: (c: any, s: string) => string } }; cwd: string } | null = null;
  let hideDoneBefore = 0; // done rows with id < this were completed in an earlier turn → off the board

  const project = (cwd: string) => {
    try {
      const p = join(cwd, ".pi", "todo.md");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, projectMarkdown(state));
    } catch {
      /* projection is best-effort; truth is the transcript */
    }
  };

  const paint = () => {
    if (!uiCtx) return;
    try {
      // Always read the live theme from ctx.ui; never cache a Theme or pass its `fg` unbound (it reads `this.fgColors`).
      const th = uiCtx.ui.theme;
      const lines = renderLines(state, { maxLines: MAX_LINES, fg: th ? (c, x) => th.fg(c, x) : undefined, plain: !th, hideDoneBefore });
      uiCtx.ui.setWidget(WIDGET, lines.length ? lines : undefined, { placement: "belowEditor" });
      // setWidget moves updated widgets last; crew must repaint after todos to stay below them.
      pi.events.emit("todo:painted", {});
    } catch {
      // The board is a projection; a render fault must never fail the tool call or lose state.
    }
  };

  const restore = (ctx: any) => {
    state = replay(ctx.sessionManager.getBranch());
    uiCtx = ctx;
    paint();
  };

  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_compact", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => uiCtx?.ui.setWidget(WIDGET, undefined));

  // agent_start = a new USER message. (turn_start is every model call — using it re-hid done rows mid-task.)
  pi.on("agent_start", async (_e, ctx) => {
    uiCtx = ctx;
    hideDoneBefore = state.nextId; // everything done so far was seen; state keeps it for the projection/handoff
    paint();
  });

  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` }));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Keep a visible checklist for multi-step work: add | start | done | remove | list. Returns the current list.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("start"), Type.Literal("done"), Type.Literal("remove"), Type.Literal("list")]),
      text: Type.Optional(Type.String({ description: "add: the step, ≤ 60 chars, verb first" })),
      id: Type.Optional(Type.Number({ description: "start | done | remove: task id" })),
      blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "add: ids that must be done first" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx as any;
      const next = apply(state, params as Action);
      if (!next.error) {
        state = next;
        project(ctx.cwd);
        paint();
      }
      const list = state.tasks.map((t) => `${GLYPH[t.status]} #${t.id} ${t.text}${t.blockedBy.length ? ` (after #${t.blockedBy.join(", #")})` : ""}`).join("\n");
      const text = next.error ? `error: ${next.error}\n${list}` : list || "(empty)";
      return { content: [{ type: "text", text }], details: { tasks: state.tasks, nextId: state.nextId }, isError: !!next.error };
    },
    // Renderers must return a Component (has .render()), never a string — a string here crashes the TUI.
    renderCall(args: any, t) {
      const a = args as Action & { text?: string; id?: number };
      return new Text(t.fg("toolTitle", `todo ${a.action}${a.text ? ` "${a.text}"` : ""}${a.id ? ` #${a.id}` : ""}`), 0, 0);
    },
    renderResult(result: any, _opts, t) {
      const d = result.details as State | undefined;
      const done = d ? d.tasks.filter((x) => x.status === "done").length : 0;
      return new Text(t.fg("dim", d ? `${done}/${d.tasks.length} done` : ""), 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the session todo list",
    handler: async (_args, ctx) => {
      const lines = renderLines(state, { maxLines: 100, plain: true });
      ctx.ui.notify(lines.length ? lines.join("\n") : "No todos.", "info");
    },
  });
}
