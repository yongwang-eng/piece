# Profiles — craft that compounds

## Files

- `AGENTS.md`: the role's stable charter and operating principles. An optional **Learned practice** section carries only promoted, role-specific guidance.
- `CREW.md`: room coordination, ownership and handoff behavior. Do not duplicate craft guidance here.
- `history.md`: on-demand learning index: candidates, evidence, promotion decisions and superseded practices. Never automatically load it into workers.
- `evals/`: saved role-behavior cases when needed. Link existing regression tests instead of copying them.

Crew's existing loader selects AGENTS.md and CREW.md; this structure adds no automatic history loading. Do not add empty learned-practice sections or history files just to fill a template.

## Default-context admission bar

Aim for a few lines, not a page. No minimum or lesson quota. Every promoted practice must:

1. Change a concrete future decision, with a recognizable trigger and a short action.
2. Be a demonstrated, transferable lesson or an explicit human-approved operating preference. Label its provenance honestly; a preference is not an empirical result.
3. Add something not already covered by the charter, shared rules or another active practice.
4. State any important limit; avoid turning one run's accident into an unconditional rule.
5. Have an evidence/decision entry in history, including what would make us revisit it.

Keep evidence detail, anecdotes, scores, dates and drafting history out of the active section. Main reads history when maintaining a profile; workers should not traverse it routinely.

## What belongs where

| Finding | Destination |
|---|---|
| Safety, authorization or stable operating principle | Existing charter/shared rule, with its existing approval requirements |
| Proven role-specific technique | Short Learned practice section |
| Unverified observation | Candidate in run artifacts/history, not default context |
| Harness failure that code can prevent | Harness fix and regression test, not a worker workaround |
| Repository-specific fact | Repository/task context |
| Practice shared by several roles | One shared source, not copies in every profile |

A worker can propose a candidate in its own run artifact. Main attributes the cause, checks existing guidance, validates with a fresh case when the claim is empirical, then promotes, revises or rejects it. Workers cannot self-amend their charter, guards or permissions through learning.

At relevant run closure, inspect material failures AND successes; no obligation to produce a lesson. On contradiction or changed tooling, revalidate the active practice. Update/remove stale active guidance and preserve its supersession reason in history. Repeating a rule is not evidence that it helped.

## History entry shape

- **Practice and status:** candidate / active / needs revalidation / superseded / rejected.
- **Source:** run and evidence link, or explicit human direction.
- **Scope:** where it helps and where it does not apply.
- **Validation:** observed outcome and unaffected control, or preference adoption without an empirical claim.
- **Decision:** who promoted/rejected it; revisit trigger and replacement if superseded.

Reuse run artifacts and the experiments log as evidence. This index is not another transcript store.
