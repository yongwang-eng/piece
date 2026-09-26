# pi-background-compact

Background context compaction for the [pi coding agent](https://pi.dev) — the
summarizer **rides the live prompt cache**, the summary is spliced in at the next pause, and
**summarizing never blocks the conversation**.

That promise is about summary *generation*, which is the part that used to cost you minutes. It is
not a claim that nothing can ever block: `"background": false`, a service that failed to load, and
pi's own overflow guard all still compact synchronously — see [Failure design](#failure-design).

```
pi's built-in compaction            pi-background-compact
────────────────────────            ─────────────────────
blocks the conversation             runs in the background
fires near the window edge          fires at YOUR token budget
re-sends everything at full price   re-reads the prefix at cache price
```

24 local successful appended-strategy observations across **mixed and partly unrecorded models**
(cohort cutoff `2026-09-14T16:29:09.308Z`; the log names claude-opus-5 and gpt-6-astra among them,
and 18 older rows record no model at all). **This cohort predates the lookup-window cap** and so
spans both hits and misses; runs after it read 99%+. Read
[The lookup window](#the-lookup-window-and-why-the-cut-respects-it) before trusting either column:

| cache read | runs | avg recorded cost |
|---|---|---|
| >150k | 6 | $0.35 |
| 60k–150k | 8 | $0.03 |
| <60k | 10 | $1.54 |
| median cacheRead | 73.2k | — |

Individual recorded costs span **$0.0275–$2.572**. **These observations are not a paired cost
benchmark; savings depend on model, workload, cache state and retries.** They are successful
strategy results, not per-attempt records — a successful retry sums both responses — and the line
omits `cacheWrite`, so a hit fraction cannot be derived from them. A single best-case run:

| | serializing summarizer | this extension |
|---|---|---|
| summarizer input bill | ~193k tokens at full input price (**$3.09** observed) | 191,249 tokens cache-read + **2** at full price (**$0.46**, of which ~$0.40 is the summary's own output) |
| editor blocked during summarization | ~1–6 min | never |

## Install

```bash
pi install npm:pi-background-compact     # or: pi install /path/to/checkout
```

## How it works

```
 your turn ends (agent_settled)
   │  tokens > threshold − lead?
   ▼
 summarize in the BACKGROUND
   │  the request reconstructs your live prefix (same model, tools,
   │  system prompt, thinking config; messages up to the cut point)
   │  + ONE appended user message: "summarize this conversation"
   │  → the provider re-reads the matching span at the cacheRead rate
   ▼
 summary ready
   │  applied at the next settled boundary — never mid-run
   │  fingerprint check: same session, same cut point, no other
   │  compaction landed → otherwise DROPPED, never force-fit
   ▼
 spliced: [summary][recent tail] — your draft and your flow untouched
```

### The second trigger: a quiet session

A session you walk away from still pays for what it holds: the provider cache expires (Anthropic
≈5 min) and the next message re-writes the whole ledger cold — $2.28 measured on a 160k resume,
vs $0.30 when the same summary is made while the cache is warm. So a ledger above `idleAt` (150k)
that has been quiet for `idleAfterMs` (270 s) is summarized in the background and applied at once.

The clock runs from **the start of the last model request**, because that is when the provider
last *read* the cache and restarted its TTL. Measured from `agent_settled` instead, a 46 s final
answer silently turned a "276 s idle" fire into a 322 s one — cold, at the full price. Past
`cacheTtlMs` (300 s) the trigger refuses: paying cold to avoid paying cold is strictly worse.

The cache hit is a **recorded fact, not a hope**: only successful appended-strategy runs have the
`cacheRead` detail line in `~/.pi/agent/state/compaction.log`. Explicit appended→pi fallback is
logged; missing `completeSimple` selects pi silently. Logs are best-effort and not a spend ledger.

### The lookup window, and why the cut respects it

A cache read searches **at most 20 blocks back** from the request's breakpoint. Inside that window
it recovers the entire matching prefix; outside it recovers **nothing** — there is no partial
match. Measured directly: gap 20 hits, gap 22 returns zero.

That is all-or-nothing, so the cost has a floor rather than a spread. A miss still reads the tools
and system spans, which carry their own breakpoints, and locally that floor is ~43k tokens — the
same ~43k on a 208k conversation and on a 456k one. A read that does not move when the conversation
doubles was never reading the conversation.

So the summarizer stops **inside the window**, which is a different boundary from the one the splice
uses:

```text
entries   1 ──── 4 │ 5 ──── 7 │ 8 ─────────── head
                   │          │
splice keeps       └──────────┴────────▶  5..head verbatim (pi's full recent tail)
summarizer reads 1..7 ────────┘           stops at 8 → inside the window → hits
                   └── 5..7 summarized AND kept
```

Entries between the two boundaries are summarized *and* kept verbatim. That overlap is redundant,
not wrong, and it costs a few thousand tokens against a miss that costs about a dollar. The
summarizer's stop may only move **forward** of the splice's cut: behind it, entries would be neither
summarized nor kept, and would be lost. Every compaction logs the overlap, including when it is
zero, so the cost is auditable rather than inferred.

Observed on one session an hour apart, before and after the cut respected the window:

| | cap absent | cap live |
|---|---:|---:|
| cached | 43.6k (26.6%) | 188.5k (**99.3%**) |
| cost | $1.79 | **$0.32** |
| kept tail | 18.5k | 24.6k |

The tail did not shrink to buy the hit — it grew, because the two boundaries are independent.

> **Blocks, not entries.** One entry can be several blocks: an assistant turn with thinking and two
> tool calls is four. The probe that fixed the boundary at 20 used a ledger with exactly one block
> per message, so it cannot distinguish "20 blocks" from "20 messages"; the provider documents
> blocks, real ledgers run denser (15 messages measured 18 blocks), and counting blocks is correct
> under either reading. The package counts blocks.

### What else can cost a hit

One **possible** source of partial hits is a lost endpoint. With caching on, pi-ai marks the last
content block only when the final converted message has role `user` — which a run of tool results
also satisfies (`anthropic-messages.js`, `convertMessages`). Cache prefixes are **cumulative**
(tools → system → messages), so the truncated request diverges from the live one exactly where the
retained tail was replaced by the instruction:

```text
live request:  T [B_T] | S [B_TS] | doomed D | retained input K [B_live]
truncated:     T [B_T] | S [B_TS] | doomed D | instruction I   [B_new]
                                            ^ first divergence
```

`B_TS` covers T+S; `B_live` covers T+S+D+K. The truncated request cannot use `B_live`, because that
entry includes a tail it does not send — this is about **matching content**, not comparing lengths.
Any hit before the divergence needs an identical, unexpired entry that is also **reachable**: reads
search at most 20 positions per breakpoint, so an entry can be warm and before the cut and still
out of range. The default TTL is five minutes, refreshed by reuse, and generating a response
consumes it — so even the tools and system entries are candidates, not guaranteed hits.

Runs reading roughly 43k were lookup misses: tools and system only, with the message span
contributing nothing.

### Why the prefix matches

A full cache hit requires: same model, same thinking configuration, identical cumulative
tools/system/messages prefix. The summarizer therefore runs on the **session model** with the
**session's thinking level** — a different summarizer model cannot reuse the session's entries at
all. The size of that penalty is workload-dependent and is not established by the observations
above.

The prefix is **reconstructed from session entries**, so identity is a design target, not something
this package can enforce: another extension that rewrites the outgoing `context` or provider
payload, or a differing cache-retention window, reduces the hit. The measured cacheRead in the log
is the ground truth for any given run — which is why it is logged rather than asserted.

**On OpenAI the prefix is not enough.** OpenAI routes a request to a cache by prefix *and*
`prompt_cache_key`, which pi-ai sets to the session id on every OpenAI path (`openai-codex`,
`openai`, gateways using the responses API). The summarizer passes the session id through for that
reason. Before it did, every background compaction on `gpt-6-astra` and `gpt-5.6-sol` was a full
miss (10/10, `cached=0`, ~$2 each) while Claude sessions in the same hour were 12/12 warm — the
omission is invisible on Anthropic, which keys on content alone. If you extend the summarizer or
route it through another provider, keep `options.sessionId`; the `applied … cached=` line tells you
within one fire whether you lost it.

## Configuration

`~/.pi/agent/settings.json`:

All of this package's settings live under **`backgroundCompact`** — never inside `compaction`,
which is pi core's own block. Core's `compaction.enabled` is its overflow guard; core's
`keepRecentTokens` / `reserveTokens` are read and respected as-is. Note this package reads those
two from the global settings file only, so a project-level override of them is not picked up.

```jsonc
{
  "backgroundCompact": {
    "at": 200000,        // absolute token threshold (economic policy, not window edge)
    "lead": 10000,       // start summarizing this many tokens early
    "maxFraction": 0.75, // never exceed this fraction of the model window
    "minGapMs": 60000,   // minimum gap between compaction ATTEMPTS starting
    "enabled": true,
    "background": true,  // false → plain blocking compaction at the threshold
    "strategy": "appended",  // "pi" → pi's serializing summarizer (full price)
    "notify": true       // false → mutes applied/dropped/failed only (see Observability)
  }
}
```

Commands: `/background-compact` (show/set threshold: `120k` · `25%` · `now` · `reset`) ·
`/compact-bg` (compact now in the background; `status` · `cancel`).

## Failure design — a failure costs you money or a pause, never your context

| what goes wrong | what happens |
|---|---|
| appended summarizer fails | falls back to pi's serializing summarizer (logged) |
| summarizer output hits the token cap | rejected — partial text is never spliced; pi's summarizer is tried instead |
| both summarizers fail | reported as failed; the ledger is left exactly as it was |
| ledger changed before apply (manual /compact, branch switch) | summary dropped; spent cost logged |
| reload/shutdown mid-flight | summarization aborted and logged |
| `prepareCompaction` unresolvable | no background service at all; trigger does blocking compaction, with a warning |
| pi-ai's `completeSimple` unresolvable | background service still runs, silently using pi's serializing summarizer (full price) |
| service unavailable | trigger falls back to pi's blocking compaction |
| core `compaction.enabled` is true | pi's own overflow guard is the last net at the window edge — it cannot rescue an unusable auth/provider |

Cost is the thing a failure *can* spend: a rejected or retried attempt may already have incurred
cost, and the fallback is billed again at full input price. Preparation or auth can also refuse
work before any provider call, costing nothing. Failures are bounded in context, not in dollars.

## Observability

- `~/.pi/agent/state/compaction.log` — every transition (started/ready/applied/dropped/FAILED)
  with token counts, cost, elapsed time, and the summarizer's `cacheRead`
- notifications for the three service outcomes you must not miss (applied / dropped / failed);
  mute with `"backgroundCompact": { "notify": false }`. Startup, blocking-compaction and
  fallback messages are separate and are not muted by it.
- `background-compaction:{started,ready,applied,dropped,failed}` on `pi.events` for other
  extensions (e.g. a usage ledger). `dropped` carries the usage it **has**: a completed summary
  that never landed reports its real cost, while a drop in flight reports `null` (unknown, never
  zero) and a failed appended attempt's tokens are not currently accumulated into the event.
  Neither surface is a complete spend ledger: the log records the transitions it sees, and tokens
  burned by a failed attempt are not attributed anywhere. For true spend, read your provider's
  billing — these are operational signals, not accounting.

## UI

The package ships **no custom UI** — status widgets are a matter of taste, and the events bus is
the API. [`examples/status-row.ts`](examples/status-row.ts) is a complete, copyable status-row
extension (`⟳ compacting 193k in background · 35s` under the editor, with an elapsed ticker);
drop it in your extensions folder and restyle freely.

## Prior art

Claude Code shipped "instant auto-compacting" in 2.0.64 (Dec 2025). pi issue
[#160](https://github.com/earendil-works/pi/issues/160) proposed porting it and was declined as
too wasteful — a fair objection to *speculative, full-price* summarization. This extension
removes both terms of that objection: it summarizes **once** (at threshold − lead, not after
every turn) and at **cache price** (the appended-instruction request). Related:
[#6606](https://github.com/earendil-works/pi/issues/6606),
[#6919](https://github.com/earendil-works/pi/issues/6919).

## Caveats

- Reaches into pi internals for two functions pi does not export at root, resolved defensively at
  load, and they degrade **differently**: without `prepareCompaction` there is no background
  service and the trigger does blocking compaction with a warning; without pi-ai's `completeSimple`
  the service still runs but silently uses pi's serializing summarizer at full price. Verified
  against pi 0.85.1's install layout — other releases and packaging layouts are untested.
- Cache-hit economics verified on Anthropic models (5-minute cache TTL). Other providers degrade to
  roughly pi's normal compaction price. It is not a guaranteed ceiling: a retried attempt or a
  fallback after a paid attempt costs *more* than compacting once, and a cache miss is not bounded.
- The post-splice call pays a one-time partial rewrite (~the summary + kept tail as cache
  writes); that is the irreducible price of the ledger genuinely changing.
