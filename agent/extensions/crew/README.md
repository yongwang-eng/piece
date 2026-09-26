# crew — governed tmux workers for pi

Crew runs each worker as a separate pi process in a tmux pane. Main owns spawn, stop, recovery and consult routing; workers report through the room (pi-pubsub over local Redis; see `lib/room/redis-bus.ts`).

## Folder map

| path | responsibility |
|---|---|
| `index.ts` | Main extension entrypoint: tools, `/crew_cli`, per-worker state, liveness and recovery wiring |
| `runtime/tmux.ts` | Pane arguments, spawn command and explicit worker extension paths |
| `runtime/worker.ts` | Worker-only `-e` entrypoint: room, consults, reports and presence |
| `runtime/mcp-browser.ts` | Browser-worker `-e` entrypoint using the worker's leased profile |
| `runtime/recover.ts` | Read saved worker sessions and recover text/artifact paths |
| `runtime/failover.ts` | Dead-request recovery rung selection |
| `runtime/staleness.ts` | Is the loaded extension older than the source on disk? (board + crew_list cue: `/reload`) |
| `runtime/hold.ts` | The standard `[HOLD]` / `[RESUME]` payloads behind `crew_hold` / `crew_resume` / `/crew_cli hold\|resume` |
| `runtime/dispose.test.mjs` | Disposal and idle-before-action regression tests |
| `governance/rulings.ts` | Read open consults and prior rulings before deciding |
| `ui/board.ts` | Presence, stall detection and board rendering |
| `ui/presence.test.mjs` | Main/worker presence and recovery wiring tests |
| `testing/` | Loaded-extension smoke/harness scripts, when present |

Unit tests are colocated. From the agent directory:

```sh
node --test 'extensions/crew/**/*.test.mjs'
```

Quote the glob so Node discovers nested tests regardless of shell glob settings.
Worker launch paths in `runtime/tmux.ts` must follow entrypoint moves; these files are passed explicitly with `-e`, not auto-discovered. Runtime records live under `workers/runs/<database-namespace>/<crew-id>/`. The SQLite namespace changes on a fresh database so resetting counters cannot reuse old room history. Room transport is partitioned by the normalized record directory.
