# Crew communication stats

The crew row adds `peer ↑8 ↓5` when it fits without removing existing row content. These are **directed peer messages logged outbound/inbound**, not delivery or read receipts. `peer ?` means the record is unavailable or incomplete. Narrow rows omit optional counters; worker visibility and status retain priority.

Use `/crew_cli stats` for the live team, or `/crew_cli stats <name|#N>` for one worker. `crew_list` also returns structured counters in `details.communication`.

| Counter | Meaning |
|---|---|
| Peer out | Unique messages explicitly addressing another known worker in `to` or `cc` |
| Addressed in | Unique peer messages naming this worker, deduplicated across `to`/`cc` |
| One-peer / multi-peer | Outbound messages naming one or multiple peers; main may also be copied |
| Broadcasts | Authored `notice` messages with `*`, counted once and separately from directed totals |
| Peers | Distinct explicitly addressed outbound peers; broadcasting doesn't imply everyone read it |
| Replies | Directed messages whose exact `re` ID matches an earlier message addressed to the replying worker, with the original sender explicitly addressed back |

Repeated join records for a name make its counters partial: the log lacks stable lifetime IDs, so aggregate traffic cannot be attributed to the current numbered worker. The board shows `peer ?`; details retain counts with that limitation.

Membership comes from logged join records; retired peers retain their history. Main/governor/runtime traffic, housekeeping, self-messages and foreign runs are excluded. Repeated message IDs count once even if the log contains duplicates. A malformed log is partial, never presented as a verified zero.

There is no productivity ranking, reply-success inference, broadcast-receipt estimate or child-pane decoration. Reply counts require exact IDs—free-text or shortened `re` values do not establish correlation.

Implementation: [record projection](../../../lib/room/communication.ts), [board](board.ts). Regressions cover addressing, membership, replay/cache, corrupt records, real command/list/board wiring and narrow-width controls.
