# crew-console

Loopback web UI for pi crews (D69): every crew live and past, and the inbox where Yong answers human-tier consults.
Design: `obsidian_notes/pi/design/crew_console.md`.

```
pm2 start ~/.pi/apps/crew-console/ecosystem.config.cjs      # :9900, 127.0.0.1 only
open http://127.0.0.1:9900/                                  # home · /crews/<crew_N> per crew
cd ~/.pi/apps/crew-console && npm test                       # e2e over a temp agent dir + the real local Redis
cd web && npm run build                                      # rebuild the SPA after editing web/src
```

- **Truth** is `~/.pi/agent/state/agent.sqlite` (`consults`, `crews`, usage). Redis is the wake-up and the delivery.
- The daemon is room member **`human`** on every run with an open consult. An answer is `result to:[worker] cc:[main]
  re:<consult id>` with the same text main's picker would send (`src/answers.ts`); the row is claimed
  (`WHERE state='open'`) BEFORE publishing, so exactly one answer ever lands.
- **Writes exactly one thing:** `consults.answered`. Everything else is read.
- Security: bound to `127.0.0.1`; `Host` pinned to loopback names (DNS rebinding); `Origin` + `Sec-Fetch-Site` on every POST. Never a tunnel. No secrets:
  `op://` references are displayed, never read here — main reads on approval.
- Layout: `src/server.ts` (Express + SSE + the human seat) · `src/answers.ts` (verdict wording) · `src/crews.ts`
  (run-dir read model: roster, lifecycle timeline, evidence) · `web/` (Vite React + Tailwind v4, Apple-quiet).
