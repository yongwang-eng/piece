# pi-recall

The model's memory of past pi sessions on this machine — hybrid retrieval (FTS5 + local embeddings) over `~/.pi/agent/sessions/**/*.jsonl`,
exposed as two tools. Local-only: no session text leaves the machine (granite-embedding-small-english-r2, ONNX q8, in-process).

Design record (why every piece is the way it is): `obsidian_notes/pi/learn/04_agent/02_retrieval.md` §Sketch, Rounds 1–7; experiments EXP-015b–017.

```text
sessions/*.jsonl ──(launchd, 5 min)──► bin/recall-index.ts ──► ~/.pi/agent/state/recall/recall.sqlite
                                        tail complete lines · extract · chunk · FTS · embed pending          ▲ read-only
pi session ── model ──► recall(query, since?, k) · recall_show(key, level) ── extensions/recall.ts ─────────┘
                        every call → calls + provenance · every page → shows        (the eval record; survives --rebuild)
```

## Contract
- `recall(query, since?, k=10)` — two lanes always (lexical: identifiers, names · dense: paraphrase), grouped by entry (best chunk),
  interleaved **k per lane** (≤ 2k hits), `since` is a preference (in-range first, older flagged), **chronological within the pack**,
  each hit: fused rank · ts · role · project · `found_by` + lane ranks · key · `file:line` · best passage (merged span when ≥ 2 chunks hit).
  Header: counts · `indexed_through` · dense coverage · time span.
- `recall_show(key, level = entry | window(±n) | exchange, max_tokens, offset)` — caller-driven paging; capped, never fills the window.
- What's indexed: `message` (user · assistant text + toolCall args · toolResult) + `custom_message`. Not thinking, not compaction summaries, not `custom`.

## Ops
```bash
node bin/recall-index.ts [--rebuild] [--no-embed] [--limit N]   # what launchd runs; ~3 s tail, ~24 ms per new chunk
# schedule: row `com.me.pi-recall.index` in ~/lab/agent_scripts/launchd_jobs/jobs.json (every 300 s);
#           `python3 jobs.py apply` installs it, `jobs.py logs com.me.pi-recall.index` tails ~/.pi/agent/state/recall/launchd.log
npm test                                                          # node:test, fixtures in tmp, no model needed
```
Rebuild ≈ 25 min for ~62 k chunks; the eval record (calls · provenance · shows · judgments) survives it. Model swap = change `MODEL_ID`, re-embed.
