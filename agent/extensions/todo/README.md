# todo — a checklist the model keeps and you can see

**Suspended at Yong's request.** `settings.json` excludes `extensions/todo/index.ts`; the exclusion takes effect on reload. Do not re-enable it without his request. The current list was cleared rather than redesigning the tool during the reliability run.

## Why it accumulated

```text
todo update
    ↓
whole-session state
    ├─ tool text: every task, including completed ones
    ├─ transcript details: replayable state
    ├─ widget: filtered/capped view only
    └─ .pi/todo.md: derived projection
```

Pending tasks have no task-boundary expiry. Completed tasks are hidden by an in-memory threshold, not removed from state. A fresh restore starts that threshold at zero, so completed rows can reappear before the next agent-start event. Every tool update still returns the entire list to the model. Hiding rows never solved accumulation.

## Design decisions (the ones that would be undone by accident)

| Decision | Why |
|---|---|
| **Activity stays above input; todos stay below input, above crew.** | `todo:painted` makes crew repaint after todos because pi orders widgets by their latest insertion. The activity widget remains visible through waiting, thinking, calls, writing, and settled idle. |
| **Truth = the transcript.** State rides in each tool result's `details`; `replay()` walks the branch and takes the last `todo` result. | Survives reload, compaction and fork without a separate mutable state file. Task text is also emitted in the tool response. |
| **The model sees the full task list**, not the serialized state object. | Per-update text grows with accumulated tasks; the widget cap does not cap tool output. |
| **`.pi/todo.md` is a projection, regenerated on every write, never read back.** ([D32](obsidian://open?vault=obsidian_notes&file=projects%2Fproj_agent_consult%2Fdecisions)) | Humans, handoff briefs and other sessions read a file; the model reads the transcript. Two readers, one writer. Globally gitignored. |
| **Done rows leave the BOARD at the next user message, never the STATE.** | The handoff brief needs *what's done* as much as *what's left*. First version dropped them from state — the `-p` e2e caught the projection losing history. |
| **Board is in id order; the glyph carries status** (`○ ◐ ✓`). | Progress reads as a wave down the list. Sorting by status made rows jump. |
| **Over budget, done rows hide first.** `+N more` tail. | Open work keeps its slot. |
| **The model decides whether to use it**, via one paragraph of guidance in the system prompt. No threshold in code. | The model is the only party that knows the shape of the work before it starts. Tune the sentence, not a number. |

## Gotchas that each cost a broken build (2026-09-10)

1. **`renderCall` / `renderResult` must return a pi-tui `Component`** (e.g. `new Text(str, 0, 0)`), never a string. A string crashes the whole TUI with `this.child.render is not a function`.
2. **Never cache a `Theme` or pass `theme.fg` unbound.** `fg` reads `this.fgColors`; detached it throws `reading 'fgColors'` on every call. Read `ctx.ui.theme` live inside `paint()` and call it as a method.
3. **`turn_start` fires on every model call; `agent_start` fires per user message.** "Drop done rows at the next turn" means `agent_start`. Keying on `turn_start` hid rows mid-task.
4. **Verify which code is loaded.** Disk edits do not update a running extension automatically; reload and live acceptance are separate from tests against files. Earlier module-cache issues are not a blanket claim that reload never works.
5. **A `-p` (JSON-mode) run is not an e2e for a UI extension** — nothing renders. It validates the tool contract (state, replay, projection all passed first time) and *none* of the three bugs above. Test in a real TUI: tmux + interactive pi + a watcher child that captures the pane. The three watcher briefs in run `todo-tui-check` are the template.

## Tests

```
node --test extensions/todo/*.test.mjs
```
Run from the agent directory. Tests cover the pure reducer and production extension callbacks through a harness; they do not establish live visual acceptance.

## Tool

`todo({ action: add|start|done|remove|list, text?, id?, blockedBy? })` · `/todos` prints the full list incl. done.
`start` on a task whose `blockedBy` isn't all done returns an error (state unchanged). Ids are never reused.

## Earlier proposals — not committed

Nothing here is permission to re-enable the suspended tool.

- fleet: a child's list feeds `inspect_child` and the handoff brief's `remaining` — read from `.pi/todo.md` in the child's cwd, or from its transcript `details`.
- SQLite (when fleet's store lands): truth moves from transcript to a table; the projection and the model-facing list don't change. Acceptance test: a cross-session query ("what did I leave open last week?") that a file can't answer.
