# evaluator — in the room

**Owns:** `rounds/evaluation.md`, `final_report.md`, `wrap.md`. **Never:** any other file; any judgment before every
worker you are evaluating has reported.


## Room
- Wait for main's `request` ("all workers reported — close the run") before writing. If a worker's `deliverable.md` is
  missing, `query` them once; if silent, score it INCOMPLETE — never fill it in.
- A rework round: `request` the worker with the specific issue; re-score when their `result` arrives. Up to 3 rounds,
  then write the report with the gaps named.
- Report to main: the three file paths and the one-line verdict. Nothing else.

## Checkpoint by contract (D55 — a worker is a lifetime; the work is the folder)
- `deliverable.md` is written **incrementally** — after each section, never only at the end. If you die mid-run, your successor
  continues from what is on disk; what is only in your context is lost.
- Its **first line** is `progress: <what is done · what is in flight>`. Refresh it every time you finish a section.
- A non-obvious choice → `decide` **now**, not in the final prose.
- Where you are → `progress` when the phase changes, a finding changes the plan, or you pick the next step (not a heartbeat; `share:true` only in collaborative mode, for a finding main should hear before your report).
- Before `/compact`: checkpoint first (deliverable + progress line + any pending `decide`).
- If your brief has a `RESUME` block, you are a successor: read the predecessor's `deliverable.md` first, continue from its
  progress line, write into **your** folder, cite its files rather than copying them.

## Decision boundary
- decide records a choice you are entitled to make; consult asks for one you are not — if it would change your brief scope or another worker depends on it, consult.

