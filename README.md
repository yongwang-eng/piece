# piece — a piece of pi

A complete `~/.pi` for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): extensions, a status
line, a worker crew, guards, secret leasing, background compaction, semantic recall — and the operating principles the
agent runs under. No company code, no personal context; drop it in as `~/.pi` and it works.

```
~/.pi
├─ agent/
│  ├─ AGENTS.md          how the agent works (engineering principles, worker rules) — travels with the repo
│  ├─ settings.json      pi settings: theme, models, which local packages load
│  ├─ config/            OUR config, all JSON, all lists: repos.json · secrets.json · mcp_tools.json · crew_models.json …
│  ├─ extensions/        one folder per extension, tests beside the code
│  ├─ lib/               shared libraries: agent-ui (the board grammar) · room (crew transport) · database (sqlite) · guards …
│  ├─ profiles/          worker roles for the crew: implementer · reviewer · researcher · investigator · …
│  ├─ themes/            piece-quiet
│  └─ state/             runtime (sqlite, redis, liveness) — never committed
├─ packages/             local pi packages: pi-background-compact · pi-recall · pi-pubsub · pi-small-tools
├─ apps/crew-console     loopback web UI for crews (optional)
└─ scripts/              setup.sh · test.sh · carve.sh · scrub-check.sh
```

## Install

```sh
npm install -g @earendil-works/pi-coding-agent     # pi itself
brew install tmux redis                            # workers live in tmux panes; redis is the crew transport (loopback only)
git clone https://github.com/<you>/piece ~/.pi
~/.pi/scripts/setup.sh                             # deps · redis · state dirs · empty sqlite from the DDL · the suite
tmux new -s pi 'pi'                                # /login, one turn, /quit
~/.pi/scripts/doctor.sh                            # proves it: tables · redis · "usage ledger: N model calls"
```

Optional flags: `--with-recall` (semantic recall over past sessions — ~600 MB of models), `--with-browser` (Playwright
Chrome for the `browser` tool), `--with-console` (the crew web console). Then edit `agent/config/*.json`: your repos and
their class in `repos.json`, your 1Password items in `secrets.json`, your MCP read tools in `mcp_tools.json`. Every one of
those files is an allowlist — what is not listed is refused.

## What's in it

| area | what you get |
|---|---|
| **board** (`extensions/board`, `lib/agent-ui`) | one status grammar below the input for everything that has state: bg jobs, crew workers, compaction — `glyph name · kind · detail · age`, owed-to-you first, `+N more` never a silent drop |
| **crew** (`extensions/crew`, `lib/room`, `profiles/`) | workers as stock `pi` processes in tmux panes talking in a redis room, a governor that decides mistake-class consults, humans only for the irreversible; `crew_spawn · crew_send · crew_merge · crew_close` |
| **guard** (`extensions/guard`) | hard-blocks public exposure (tunnels, public binds) and credential-file reads — fail closed, no "run it manually" |
| **secret-lease** (`extensions/secret-lease`) | `secret_unlock(name)` → one Touch ID → named env vars in the process, TTL, never printed; the registry is `config/secrets.json` |
| **bg** (`extensions/bg`) | `bg_run` — deterministic background jobs that wake main when they exit, so main never sleeps on CI |
| **tmux-status** / **thought-ticker** | one glyph per pane in the tmux status line (working · waiting on you · finished unseen); `waiting_on_you` paints the question as a card |
| **compaction** (`packages/pi-background-compact`, `extensions/compaction-ui`) | summarizes in the background while you keep working; a board row shows it |
| **recall** (`packages/pi-recall`) | lexical + semantic search over your own past sessions, indexed by a launchd job |
| **sessions / mains** | every live pi on the machine, what it owns, its tmux window |
| **usage / telemetry** | per-call cost estimates and a local sqlite record of tool calls |

`agent/AGENTS.md` is the part worth reading even if you take nothing else: the rules the agent works under — simplicity
first, follow existing patterns, red before green, two questions bound every change, a list beats a judgement.

## Developing

- **`DEVELOPMENT.md`** is the hands-off doc: the agent-facing install contract (what each config allowlist controls and
  what refuses while it is empty), what is recorded where, conventions, the proof recipe, a kernel per area.
- `scripts/doctor.sh` — verifies an install and, after one real turn, that the usage ledger is actually recording.

- `scripts/test.sh` — the whole suite (`node --test`); every extension ships its regression tests beside it.
- A change to anything on screen is proven in a sandbox pi in tmux before it is called done:
  `tmux new -d -s t -x 120 -y 40 'cd /tmp && pi 2>/tmp/t.err'` → drive it with `tmux send-keys` → read `tmux capture-pane -p`.
- `.gitignore` is an **allowlist**: runtime state never enters version control; a new file type needs a `!` line.

## How this repo is produced

It is carved from a private, fuller `~/.pi` by `scripts/carve.sh`: every tracked file is copied through a private
substitution list, company-coupled extensions are dropped, and `scripts/scrub-check.sh` refuses the result if any pattern
from a deny list appears. The deny list itself lives outside the repo (it would be the leak). A fresh repository with no
prior history was created for the first publication.

## License

MIT
