# Shared database — identity and accounting

**Crew identity and membership, not a liveness database.** The extension binds this store at session startup and allocates identities before launching workers. Tests use temporary databases; no legacy visibility store is imported or migrated.

```text
pi session ID → main agent
                   ↓
                 owner instance + generation
                   ↓
                 crews
                   ↓
                 memberships → worker agents
```

All pi extensions share `state/agent.sqlite` through domain-specific semantic APIs in `lib/database`. Crew identity and main usage are the first consumers. The legacy Fleet visibility schema is removed, not merged or migrated. `state/agent.sqlite` is the ONLY database under `state/`; the pre-consolidation `state/crew.sqlite` (schema v2) was deleted 2026-09-14 after it misled a design read — if a second `.sqlite` ever appears there, it is stale, not a sibling.

## Contract

- Each database has an immutable namespace for room files/transport; a reset database cannot accidentally reuse old history.
- SQLite assigns global IDs across connections; presentation is `crew_N` / `agent_N`. Slugs and role names are labels, never lookup keys. Gaps are normal; uniqueness is within this database, not across independent databases.
- Main registration is idempotent by pi session ID. A main can be a member of several crews. Membership alone does not grant ownership. Slug resolution is owner-scoped; duplicate slugs require explicit IDs.
- The harness binds an owner handle to its runtime. Claiming the same active instance is idempotent; a different claimant is refused (including a stale claim after a crash). Release/reclaim increments the generation so stale callbacks fail even if an instance label repeats.
- There is deliberately no automatic takeover of a crashed owner. The extension's observed-liveness/recovery boundary must be designed and tested in the integration slice; the store cannot establish process death.
- Workers are registered before external launch, with no state column. Execution association is a fact: duplicate binding to the same session is idempotent, rebinding is refused. Predecessors must belong to the same Crew, but do not require a reliably recorded death event.
- Lifecycle transitions and last observed presence stay in room JSON/events. Replaying them yields last recorded state, not proof of liveness. SQL never gates replacement on an end event that a crashed process could fail to emit. Existing runtime observation supplies live status.
- Owner validation and mutation occur in one short `BEGIN IMMEDIATE` transaction. No process/model/filesystem waits inside a transaction. Failed writes throw; callers must not continue with a file registry fallback.
- The 100 ms SQLite busy budget bounds synchronous lock waiting, not total operation latency. WAL permits concurrent readers. UI responsiveness still requires an integrated test.
- The store exports semantic operations, not a raw handle/SQL tool. IDs and owner handles must come from harness context, not worker-authored payloads. The database is not a replacement for tool/consult/security enforcement.
- Metadata only: no prompt, raw request/response, tool-result or transcript storage. Turn and observed assistant-call metadata are supported. Main capture is wired; worker/governor capture is not yet wired. Missing usage stays null; costs are SDK estimates, not invoices. Main usage is shared/unattributed, never multiplied across its Crews. Unclosed turn records are incomplete history, not active-agent state.

## Drizzle boundary

```text
Extension hooks / tools
      ↓
CrewStore semantic operations
      ↓
Drizzle typed queries + transactions
      ↓
Node built-in SQLite
```

Dependencies are pinned in `agent/npm/crew/`: Drizzle ORM/Kit `1.0.0-rc.4`. The release candidate supplies the built-in Node SQLite adapter; no extra native driver is installed. Kit is a development-only schema exporter, not a runtime dependency or migration system.

`consults` (v6; v7 adds the `follow_up_of`/`reply` thread of an "Ask first") is the permission record: every consult a worker raised, whoever answered it (`governor` · `human:<via>` · `withdrawn:<reason>`), keyed (crew, id); `settleConsult` closes a row only `WHERE state='open'`, so main and the crew-console may both try and exactly one wins. Read with `/crew_cli consults history [crew_N] [N]`.

`schema.ts` owns table definitions and inferred row types. `generate-schema.mjs` exports a fresh-database bootstrap into `schema-ddl.ts`; `--check` detects drift. STRICT table enforcement and the single-Crew membership trigger are explicit SQLite additions. Raw SQL is confined to bootstrap/PRAGMAs, that trigger, and aggregate expressions. No historical migration/import is performed.

From `agent/`:

```sh
npm ci --prefix npm/crew --ignore-scripts --no-audit --no-fund
node lib/database/generate-schema.mjs --check
```

Coverage: captured assistant callbacks only. Provider-internal retries and compaction are not counted. Tokens and cost have separate known-call counts; sums contain only known values. SQL does not store prompt/response content.

## Verification

```sh
node --test lib/database/store.test.mjs
node lib/database/proof.fixture.mjs <evidence-directory>
```

The suite uses real temporary SQLite databases, including simultaneous worker-thread connections. Failure fixtures exercise lock contention, transaction rollback and unknown-schema refusal. SQL in tests is limited to temporary failure setup/inspection; runtime consumers use the store API.

The proof script removes one invariant at a time in disposable copies. Stale generation, cross-owner mutation and wrong-Crew membership assertions must go red while the unrelated registration/execution control stays green. It never changes the working source or live storage.

The initial red run failed because the new module did not exist; that is not evidence of a pre-existing runtime bug. The invariant-removal proofs provide behavioral negative controls. Production Crew hooks, crash takeover and live visuals are not proved by this foundation suite.
