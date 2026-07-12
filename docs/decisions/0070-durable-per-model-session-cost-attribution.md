# ADR-0070: Durable per-model session cost attribution — the `session_costs` aggregate, single-owner cost writes, and the reconciliation invariant

- **Status**: Accepted
- **Date**: 2026-07-12
- **Related (primary)**: [ADR-0059](0059-cli-mid-session-model-reseat.md) — the per-message `modelId` attribution this
  completes, and whose "show a per-model cost breakdown" it delivers · [ADR-0062](0062-context-compaction-and-cli-history-commands.md) —
  the compaction summariser whose spend this must attribute · [ADR-0064](0064-live-model-catalog.md) — the `model_catalog`
  FK target and the `BEGIN IMMEDIATE`/`SQLITE_BUSY` write convention this obeys · [ADR-0028](0028-workflow-resource-governance.md) —
  the budget governor that *reads* the session total this ADR gives a single writer.
- **Related (secondary)**: [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) (one schema, two dialects) ·
  [ADR-0024](0024-agent-first-entry-point-agentsession.md) (one model per `AgentSession` *instance*, not per billed
  egress) · [ADR-0065](0065-provider-economics-and-extensibility.md) · [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md) ·
  [ADR-0050](0050-cli-history-db-at-rest-posture.md) · [ADR-0056](0056-cli-in-app-slash-command-system-and-manifest.md)
- **Canonical homes** (this ADR cites, never restates): the DDL → [database-schema.md](../reference/desktop/database-schema.md) ·
  the event → [run-event.ts](../../packages/shared/src/run-event.ts) · the command → [chat-session.md](../reference/cli/chat-session.md)
- **Forward**: 2.6.Q's pricing-enrichment decision (the models.dev tier + the strict cost cap, F5) will be **ADR-0071**;
  §6 is written so it needs no schema re-open, and §3 files exceptions 1–2 against it.

## Context

2.6.C promises a **per-model `/cost` breakdown**. Today `/cost` is one line off in-memory state — `costNotice()` ([repl-info.ts](../../apps/cli/src/chat/repl-info.ts) L15–17), wired at [chat.ts](../../apps/cli/src/commands/chat.ts) L1098–1100 — and in the bare Home it is inert (`showCost: () => undefined`, [home-controller.ts](../../apps/cli/src/render/tui/home-controller.ts) L932). There is nothing durable to render a breakdown *from*.

The obvious cheap answer — read `session_messages.model_id` + `session_messages.cost_microcents` ([schema.ts](../../packages/db/src/schema.ts) L481, L484) — is **structurally impossible**, and this is the whole reason this ADR exists. A message row carries exactly **one** `model_id`, but a single turn can bill **two models**: the tool loop makes a fresh fallback-chain call per iteration ([agent-turn.ts](../../packages/core/src/engine/agent-turn.ts) L828–877), so iteration 1 can succeed on model A and iteration 2 fail over to model B — pinned by [agent-session.test.ts](../../packages/core/src/engine/agent-session.test.ts) L272–290 ("Turn 1 is a tool round-trip → TWO `cost:updated` events"). A per-message cost column cannot represent that turn without lying. And `session_messages.{input_tokens, output_tokens, cost_microcents}` have in fact **never been written**: `toSessionMessageRow` defaults all three to `0` ([session-store.ts](../../packages/db/src/session-store.ts) L137–139) and `fromSessionMessageRow` (L152–166) does not even read them back. They are dead-but-shipped columns that a future reader would `SUM()` to zero.

What *is* complete is the **event stream**. `CostUpdatedEventSchema` ([run-event.ts](../../packages/shared/src/run-event.ts) L264–278) carries a **required** `model: nonEmptyString`, the **per-attempt increment** `costMicrocents`, and the real token counts. In a chat session there is exactly **one** emitter — [agent-turn.ts](../../packages/core/src/engine/agent-turn.ts) L754–764 — reached by the user turn ([agent-session.ts](../../packages/core/src/engine/agent-session.ts) L1095) and by the compaction summariser (L889–907, whose `emit` is a filter that forwards **only** `cost:updated`). The media emitters ([agent-runner.ts](../../packages/core/src/engine/agent-runner.ts) L618, [engine.ts](../../packages/core/src/engine/engine.ts) L1430) sit on the workflow agent-node path an `AgentSession` never enters, and no session tool holds a provider handle. So **no session spend exists that is not an emitted `cost:updated` carrying a model id** — and `agent_sessions.total_cost_microcents` is, provably, the sum of exactly those increments ([agent-session.ts](../../packages/core/src/engine/agent-session.ts) L1125–1133 accumulates; [persister.ts](../../apps/cli/src/chat/persister.ts) L186–188 stamps the row). The persister then **throws the increment away** and keeps only the running total and the last model.

The stakes: `/cost` is a **money** surface. A breakdown whose rows do not sum to the number shown as the total is worse than no breakdown — and a resumed session, whose total is seeded from the DB row ([session-resume.ts](../../packages/core/src/engine/session-resume.ts) L138) while an in-memory breakdown would only know this process's models, would visibly violate that sum on the first `/cost`.

## Decision

**We add a durable per-`(session, model)` aggregate table `session_costs`, fed from every `cost:updated` by a single-owner, single-transaction store method that also increments `agent_sessions.total_cost_microcents` — making `SUM(session_costs.cost_microcents) == agent_sessions.total_cost_microcents` true by construction, for every row in the table, past and future.** The engine is unchanged except for one additive optional field on the cost event; the write lives in the host ([persister.ts](../../apps/cli/src/chat/persister.ts)) over a `@relavium/db` store method, so `packages/core` and `packages/llm` stay platform-free.

Considered and rejected:

- **Row-level attribution on `session_messages`** (populate the existing `model_id` + `cost_microcents`) — *rejected: lossy by construction.* One `model_id` per row cannot hold a two-model tool-loop turn (the case above), and a turn that **errors or aborts** writes no message row at all while its spend is real and kept (persister.ts L199–206) — so the breakdown would silently omit money the total contains.
- **A `cost_by_model_json` column on `agent_sessions`** — *rejected:* an atomic in-SQL fold needs `json_set`/`jsonb` (dialect-divergent, breaking [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md)'s "the Postgres port is a driver change"), and a host-side read-modify-write needs the same transaction the table needs anyway — while buying no index and no cross-session rollup.
- **A literal append-only mirror of `run_costs`** (one row per `cost:updated`, `/cost` does `GROUP BY`) — *rejected:* it satisfies the sum equally, but grows unbounded in a long chat, is not idempotent under a retried write, and would inherit `run_costs`' shipped bug (`run_costs.model_id` is **never written** — [run-history-store.ts](../../packages/db/src/run-history-store.ts) L265–275 — a dead column). We mirror `run_costs`' **discipline** (integer micro-cents, cascade to the parent, the `prev + delta` total), not its columns.

### 1. The table — `session_costs`

A new drizzle table in [schema.ts](../../packages/db/src/schema.ts), placed after `sessionMessages`; the generated migration is the next drizzle-kit file (`0009_<generated>.sql` — the name is drizzle's, never hand-picked). Its **one canonical home** is [database-schema.md](../reference/desktop/database-schema.md), under "Agent-session tables", after `session_messages` (this ADR does not restate the column table).

```sql
CREATE TABLE session_costs (
  id                text    PRIMARY KEY NOT NULL,
  session_id        text    NOT NULL,
  model             text    NOT NULL,      -- the RAW provider model string from cost:updated.model
  model_catalog_id  text,                  -- nullable FK -> model_catalog.id (a UUID); NEVER the key
  input_tokens      integer DEFAULT 0 NOT NULL,
  output_tokens     integer DEFAULT 0 NOT NULL,
  cost_microcents   integer DEFAULT 0 NOT NULL,
  call_count        integer DEFAULT 0 NOT NULL,   -- billed egresses folded into this row
  unpriced_calls    integer DEFAULT 0 NOT NULL,   -- of which we could not price (§6)
  created_at        integer NOT NULL,
  updated_at        integer NOT NULL,
  FOREIGN KEY (session_id)       REFERENCES agent_sessions(id)  ON DELETE cascade,
  FOREIGN KEY (model_catalog_id) REFERENCES model_catalog(id)
);
CREATE UNIQUE INDEX idx_session_costs_session_model ON session_costs (session_id, model);
CREATE INDEX        idx_session_costs_session       ON session_costs (session_id, cost_microcents DESC);
```

Row `id`s come from the host's existing `deps.uuid()` (the pattern every other store write uses); the PK is never the conflict target — `ON CONFLICT` resolves on the `(session_id, model)` unique index.

The **key is the raw model string, NOT the catalog FK** — a deliberate, load-bearing divergence from `run_costs` ([schema.ts](../../packages/db/src/schema.ts) L396, a nullable `model_catalog.id` FK). `cost:updated.model` is a provider string; the FK target is a catalog **UUID**, resolved by the `ModelCatalogIdResolver` that `makeCatalogIdResolver` builds ([persister.ts](../../apps/cli/src/chat/persister.ts) L18–28), which returns `undefined` for an **uncataloged** (custom, self-hosted, brand-new) model. NULLs are **DISTINCT under UNIQUE in both SQLite and Postgres**, so keying on the FK would make `ON CONFLICT` never match: every uncataloged attempt would insert a *new* row, and two different uncataloged models would collapse into one indistinguishable "unknown" bucket. `model_catalog_id` is kept as a nullable, **written** (never dead) join column for catalog enrichment. A reviewer must not "fix" this back toward `run_costs`.

`model` is `NOT NULL` **and non-empty**: the schema carries a `CHECK (model <> '')`. The event type already forbids it (`cost:updated.model` is Zod `nonEmptyString`), but the DB is the last line — an empty-string row would be a silent, un-attributable money bucket, and the table is the system of record. `call_count` / `unpriced_calls` are counters — the only shape foldable under an additive upsert (§6). No column is free text or JSON: a `session_costs` row is **secret-free by construction** (a stronger posture than `run_costs`, which relies on upstream masking — [database-schema.md](../reference/desktop/database-schema.md) §"Secrets at the write boundary", which gains one sentence saying so).

### 2. The write path — one owner, one transaction, on every `cost:updated`

`SessionStore` gains **`recordSessionCost({ id, sessionId, model, modelCatalogId?, inputTokens, outputTokens, costMicrocents, priced, ts })`** — `id` is the caller's `deps.uuid()` (§6: it is the row's identity on INSERT and is discarded on conflict, since the upsert targets the `(session_id, model)` unique index) — which in **one** `withBusyRetry(() => db.transaction(fn, { behavior: 'immediate' }))` — the convention established by [ADR-0064](0064-live-model-catalog.md)'s 2.5.I amendment and [retry.ts](../../packages/db/src/retry.ts), and precedented by [run-history-store.ts](../../packages/db/src/run-history-store.ts) L445 — does exactly two statements:

1. an **upsert** on `(session_id, model)` that **adds** the increment to `cost_microcents`, `input_tokens`,
   `output_tokens`, and bumps `call_count` (and `unpriced_calls` when the egress was unpriced) — **additive, never
   absolute**;
2. an **additive** bump of `agent_sessions.total_cost_microcents` — mirroring `runs.totalCostMicrocents = prev + nodeCost`
   and its stated reason ("always equals `sum(run_costs)` even if a snapshot regressed",
   [run-history-store.ts](../../packages/db/src/run-history-store.ts) L289–299).

(The exact statements are the implementation's, not this ADR's — their canonical home is the generated migration + the
drizzle schema. Stating them verbatim here would create two sources that must stay byte-identical forever, which is the
drift CLAUDE.md rule 8 exists to prevent.)

Both halves must be additive **and** they must be the same transaction. Additive rows are **mandatory**: a resume or a [ADR-0059](0059-cli-mid-session-model-reseat.md) reseat builds a **fresh** persister whose in-process accumulators start at zero ([persister.ts](../../apps/cli/src/chat/persister.ts) L104–106 — today plain scalars; the per-model accumulation this ADR adds starts empty the same way), so an absolute write would zero every model row the prior process had already committed. And an additive row beside an **assigned** total is the whole bug class: `updateSession` blindly SETs every mutable column, including `total_cost_microcents`, on every flush ([session-store.ts](../../packages/db/src/session-store.ts) L249–253) from four persister call sites and from `chat-export` — so any writer whose in-memory cumulative disagreed with the row (two `chat-resume` processes on one `sessionId`; a stale `record('active')` landing after a cost write) would permanently break the sum.

One consequence to state, not hide: two processes on one `sessionId` are serialized **in the DB** by `BEGIN IMMEDIATE`, so the *durable* sum stays true — but their **in-memory** cumulative counters still drift apart, each blind to the other's spend. Every surface that must be exact therefore reads the DB (§7); the in-memory cumulative remains a best-effort live indicator for the *current* process only, which is what it already is today.

Therefore we give the cost column **exactly one owner**: `total_cost_microcents` is **removed from `updateSession`'s SET payload** (alongside the existing `delete mutable.id` / `delete mutable.createdAt`) and is written **only** by `recordSessionCost`. `createSession` still seeds it to `0`; [session-resume.ts](../../packages/core/src/engine/session-resume.ts) L138 and the budget governor keep **reading** it unchanged.

The persister calls `recordSessionCost` **on the `cost:updated` case** ([persister.ts](../../apps/cli/src/chat/persister.ts) L186) — **never** inside the `error === undefined && stopReason !== 'aborted'` gate at L208–212. That gate looks like the natural home and is the wrong one: it wraps the *message* and *token* writes, while the cost flush at L224 is deliberately **outside** it, because "the session COST … is real even for a failed/aborted turn — the engine never decrements it" (L199–206). A cost write inside the gate would silently break the invariant on every errored or aborted turn. Writing per event (rather than buffering to the four flush points) also closes a live hole: a **manual `/compact` whose summariser billed and then failed** emits no `session:compacted`, no `session:trimmed`, and no `session:turn_completed` ([agent-session.ts](../../packages/core/src/engine/agent-session.ts) L909–913), so its real spend would sit unflushed indefinitely. The cost is a handful of tiny WAL writes per tool-looping turn — trivial against an unprovable promise. This **partially discharges** the transaction follow-up already named in [database-schema.md](../reference/desktop/database-schema.md) §"Concurrency & transaction behavior" (for the cost path; the per-turn message-append transaction remains that section's open item).

### 3. The reconciliation invariant — and its exact, enumerated exceptions

> **For every `agent_sessions` row: `SUM(session_costs.cost_microcents WHERE session_id = s.id) == s.total_cost_microcents`.**

It holds because both sides are fed by the **same event**, with the **same arithmetic**, in the **same transaction**, from the **single emitter** established in the Context — including errored turns, aborted turns, and compaction spend, all of which reach `cost:updated` before the turn settles. Integer micro-cents throughout ([run-event.ts](../../packages/shared/src/run-event.ts) L271–272, `nonNegativeInt`), so there is no float drift. It is enforced by a test over a scripted stream covering: a two-model tool-loop turn, an errored turn, an aborted
turn, a compaction, a resume + a `/models` reseat, and an unpriced model.

That end-state test is **necessary but not sufficient**: it would still pass if a future refactor split the two writes
into two transactions, because both would normally succeed and the sums would agree anyway. So the test suite **also**
pins the *mechanism* — that `recordSessionCost` performs both writes inside **one** transaction (asserted on the store's
transaction seam, not inferred from the result) — and a **crash-between-writes** case proves the rows and the total
cannot diverge. (A DB trigger would be a stronger guarantee still, but there is no trigger precedent in the codebase and
it would put money logic in two languages; the transaction assertion is the proportionate guard, and it matches the
posture `runs.totalCostMicrocents` already relies on.)

This is **internal consistency, not the provider's invoice.** Stated plainly here and in `database-schema.md` so the first person to diff a bill files it as a known limit, not a bug:

1. **A succeeded attempt with no usage records nothing.** A stream that delivered content but ended without a usage-bearing `stop` chunk emits a success record with no `usage` ([fallback-chain.ts](../../packages/llm/src/fallback-chain.ts) L746–752) and [agent-turn.ts](../../packages/core/src/engine/agent-turn.ts) L749 short-circuits before emitting. The provider billed; Relavium recorded 0 — on **both** sides.
2. **A failed attempt records nothing.** Failure records carry no `usage` at all ([fallback-chain.ts](../../packages/llm/src/fallback-chain.ts) L476/L504/L523); cost is folded only in `#emitSuccess` (L749–770). A mid-stream drop after 500 real tokens contributes 0 to both sides.
3. **An unpriced model contributes 0 cost with real tokens** (§6). Invariant-safe; visible as tokens, not money.
4. **Tokens do NOT reconcile — we do not promise them.** `agent_sessions.total_input_tokens`/`total_output_tokens` accumulate only for **completed** turns (persister.ts L221–222, inside the gate) plus compaction, by design ("a rolled-back exchange's tokens … must not inflate the session-wide token totals"). `session_costs` tokens come from `cost:updated`, which fires on errored/aborted turns too. So `SUM(session_costs.input_tokens) >= agent_sessions.total_input_tokens`, strictly greater after any errored or aborted turn. This **asymmetry is deliberate and pinned by a test**; `/cost` labels its token column accordingly (§7).
5. **A mid-turn crash loses spend symmetrically.** An attempt that has not settled has emitted nothing, so nothing is lost from either side. The invariant survives; absolute accuracy does not.

Exceptions 1–2 are **not closed in 2.6.C**, and the honest framing matters: they are **not** "accepted limits" of this
design — they are a **pre-existing usage-capture gap in the LLM seam**, which this ADR *surfaces* rather than causes.
They cannot be closed *here*: doing so means synthesising usage the provider never sent, which would break the
single-emitter property the invariant rests on. The consequence must be stated without euphemism: **Relavium's reported
spend is systematically ≤ the provider's invoice**, and always will be until the seam captures usage on a
content-bearing stream that ends without a usage chunk (exception 1) and on a mid-stream failure (exception 2).

**Tracked, not shelved.** The fix belongs to the adapter/seam layer, so it is filed against **2.6.Q** — the workstream
that already re-opens `fallback-chain.ts`'s cost folding for the F5 cost-cap work
([phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) §2.6.Q) — and its ADR
(ADR-0071) must either close them or record why it cannot. This ADR's invariant holds **either way**: both sides of the
sum are fed by the same event, so a future seam that captures *more* usage simply makes both sides larger together.

### 4. Legacy sessions — the migration backfills, so the promise carries no asterisk

Every pre-migration `agent_sessions` row carries a non-zero total with **zero** rows behind it, and no backfill source exists (the per-attempt increments were discarded; `session_messages.cost_microcents` was never written). We therefore append one **DML** statement to the generated `0009` migration — a documented deviation, since drizzle-kit emits DDL only:

One `INSERT … SELECT` over `agent_sessions WHERE total_cost_microcents > 0`, writing **one** row per legacy session:
`session_id = id` (safe — exactly one row per session, so the PK can reuse it), the whole legacy total as
`cost_microcents`, zero tokens, and the model string **`(pre-2.6.C)`** — a parenthesised sentinel that can never
collide with a real provider model id (no provider id contains parentheses). The statement itself lives in the
migration, not here.


`id = session_id` is safe (exactly one row per legacy session), and a parenthesised sentinel can never collide with a real provider model id. The invariant is then true for **every row in the table**, and `/cost` renders that row honestly as "*pre-2.6.C — per-model breakdown unavailable*" rather than an implied zero. (Considered scoping the promise to post-0009 sessions instead — rejected: an invariant with a silent exception class is the kind of half-truth this ADR exists to eliminate.)

### 5. The dead columns — dropped, not left as debt

The same `0009` migration **DROPs `session_messages.input_tokens`, `output_tokens`, and `cost_microcents`**, and removes `inputTokens`/`outputTokens`/`costMicrocents` from `SessionMessageMeta` ([session-store.ts](../../packages/db/src/session-store.ts) L53–56). They have never been written, are never read back, sit in no index, and — decisively — a per-message cost column is **structurally incapable** of holding the truth for a two-model turn, which is the entire reason `session_costs` exists. Keeping them would ship a second, wrong, zero-valued cost source next to the new canonical one. `ALTER TABLE … DROP COLUMN` needs SQLite ≥ 3.35 and Postgres supports it outright; the `better-sqlite3` driver pinned by [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (superseding [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md)) bundles an engine far above that floor. (The ADRs pin the **driver** and the Node floor, not an engine version — hence the explicit floor here.) **`session_messages.model_id` stays** — it *is* written ([ADR-0059](0059-cli-mid-session-model-reseat.md)) and remains the per-message "which model wrote this reply" attribution; `session_costs` is the per-session **money** attribution. ADR-0059's "show a per-model cost breakdown" is hereby delivered by this table, not by that column.

> **Adjacent dead column, NOT ours to fix.** `run_costs.model_id` is likewise never written
> ([run-history-store.ts](../../packages/db/src/run-history-store.ts) — zero writes), so the *workflow* run
> path has the same attribution hole this ADR closes for *sessions*. It is deliberately out of scope here:
> **2.6.H** ("Durable run detail") already owns it — *"populate `step_executions.agentId/agentSnapshot/modelId/
> inputJson` and `run_costs.modelId`"*. Recorded so it is tracked work, not a discovery that gets lost.

### 6. The unpriced-model rule — and the forward contract for 2.6.Q (ADR-0071)

An unpriced model **still emits** `cost:updated`: `CostTracker`'s `UnknownModelError` is swallowed ([fallback-chain.ts](../../packages/llm/src/fallback-chain.ts) L754–763) leaving `record.cost` undefined, while `record.usage` is present — so [agent-turn.ts](../../packages/core/src/engine/agent-turn.ts) L760 emits `costMicrocents: record.cost?.costMicrocents ?? 0` with the **real** tokens and the model id. `cost_microcents = 0, tokens > 0` is therefore **ambiguous** between "unpriced" and "genuinely free", and the ambiguity cannot be resolved from the event as it stands.

We close it in two halves. **(a)** `CostUpdatedEventSchema` gains an **additive optional `priced?: boolean`** ([run-event.ts](../../packages/shared/src/run-event.ts) L264–278), set at agent-turn.ts L760 from `record.cost !== undefined` — a pure Relavium/Zod field, no vendor type, no seam violation, backward-compatible for an older reader. **(b)** `session_costs` records it as the **`unpriced_calls` counter**, not a boolean: a boolean on a `(session, model)` *aggregate* becomes meaningless the moment 2.6.Q prices a model **mid-session** and the row folds both priced and unpriced egresses.

Three **binding forward clauses**, so ADR-0071 (2.6.Q / F5 — the models.dev tier and the strict cost cap, [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) §2.6.Q) need not re-open this schema:

1. **Historical price is immutable.** A `session_costs` row records the money attributed **at the time of spend**. A
   later pricing-table or models.dev update **must not silently retro-reprice** existing rows — a retro reprice is the
   one operation that provably breaks the invariant, because `agent_sessions.total_cost_microcents` is immutable history
   that cannot be re-derived. *This is a **policy** stance, not a mechanism this ADR enforces* — it is proposed here and
   is **ADR-0071's to ratify or overturn**, since 2.6.Q is what makes retro-repricing possible at all. If a genuinely
   wrong price must be corrected (a bad models.dev row), the correction is an **explicit, audited re-statement that
   rewrites BOTH sides of the sum together** — never a one-sided `UPDATE` of the rows. Silent drift is what is banned;
   deliberate, symmetric correction is not.
2. **Attribution keys on the raw provider model string**, never on the catalog FK — so a model that enters the catalog later does not re-key, fragment, or merge its existing rows.
3. **Every session egress emits a `cost:updated` carrying a model id** (and, once F5 lands, `priced`). This binds **future** spend sites, not just today's two: the LLM-summarised session title reserved for Phase 3 ([session-title.ts](../../apps/cli/src/chat/session-title.ts) L4 — today it is pure string manipulation and spends nothing) and the media emitters, the day a session gains a media tool. A **strict-cap refusal** is pre-egress: it spends nothing, emits nothing, and is invariant-safe by construction.

### 7. What `/cost` renders

`/cost` **reads the DB** — a new `SessionStore.loadSessionCosts(sessionId): readonly SessionCostRow[]` (ordered by cost desc; an **empty array**, never `null`, for a session that has not spent; it throws only what the store's other reads throw) — never the in-memory `ChatStore`. Reading memory would show a *resumed* session only the models used in the **current process** while the total (seeded from the row, session-resume.ts L138) covers the whole session — the panel would visibly violate the invariant this ADR promises. It renders:

- one row **per model**: the model string, `call_count`, tokens **billed** (labelled *incl. failed/aborted turns* — §3 exception 4), cost, and share of total, ordered by cost desc (the covering index);
- an explicit **"price unknown for N of M calls"** marker on any row with `unpriced_calls > 0`, so a free-*looking* row is never mistaken for a free model;
- the `(pre-2.6.C)` sentinel row, when present, as "*per-model breakdown unavailable — session predates per-model attribution*";
- a **total** line that **is** `agent_sessions.total_cost_microcents`, which the rows are guaranteed to sum to.

Because a DB-backed breakdown needs only a `sessionId` and not a live session, this also makes the Home's inert `showCost` ([home-controller.ts](../../apps/cli/src/render/tui/home-controller.ts) L932) implementable and gives the 2.6 session browser a per-model breakdown for **any past session** for free.

We **reject** the proposed `(unattributed)` residual-row trick (attributing `cumulative − lastCumulative − increment` to a sentinel bucket): with an additive total (§2) the residual is structurally zero, so the bucket could only ever **absorb and hide** a future engine bug that should fail loudly. The invariant test in §3 is the guard.

## Consequences

### Positive

- **A money surface that cannot lie *about its own event stream*.** The rows sum to the total by construction — same event, same arithmetic, same transaction — for every session, past (§4) and future, across resume, reseat, failover, tool loops, compaction, errors, and aborts. This is **internal** consistency; against the provider's invoice Relavium is a systematic **under**-estimate (§3 exceptions 1–2), and §3 says so plainly rather than burying it.
- **The two-model turn is finally representable**, which no per-message column can do; ADR-0059's promised breakdown is delivered, and its known "one `model_id` per row" limitation is retired for cost.
- **Single-owner cost writes** close a real, live divergence class (concurrent `chat-resume` processes, `chat-export`'s read-modify-write, a stale flush) that would have corrupted the session total whether or not this table existed.
- **No dead debt left behind**: the three never-written `session_messages` columns are dropped, the never-written `model_catalog_id` pattern is not inherited, and the cost path's `BEGIN IMMEDIATE` follow-up is discharged.
- **Zero engine/seam churn**: `packages/core` and `packages/llm` stay platform-free (one additive optional Zod field), the write lives in the host over `@relavium/db`, and every surface (desktop, VS Code, the session browser) reuses the same store method and table.
- **Secret-free by construction** — no free-text or JSON column exists to leak into.
- **2.6.Q needs no schema re-open** (§6's three clauses + the `unpriced_calls` counter), so ADR-0071 is a pricing decision, not a migration.

### Negative

- **A write per billed egress** instead of a free in-memory assignment — a tool-looping turn performs several small WAL transactions. Accepted: the alternative is a promise the store cannot keep, and a `/compact`-failure spend that never lands at all.
- **`updateSession` no longer writes `total_cost_microcents`** — a behavioural narrowing of a shipped store method. Mitigated by making `recordSessionCost` its sole writer and by the invariant test; a caller that "helpfully" re-adds the column to the SET payload silently re-opens the divergence, so the deletion carries a comment naming this ADR.
- **A hand-appended DML statement** in an otherwise drizzle-generated migration (§4). Documented as a deliberate deviation; it lands in the byte-for-byte DDL snapshot that [client.test.ts](../../packages/db/src/client.test.ts) keeps for new-table migrations.
- **Tokens do not reconcile** (§3.4) and the invariant is **not** the provider's invoice (§3.1–3.2). Both are disclosed in the ADR, in `database-schema.md`, and in `/cost`'s own labelling — the honest posture, but it means a user diffing a provider bill will find Relavium's total an **under**-estimate.
- **A deliberate divergence from `run_costs`** (a NOT NULL raw-string key; a written `model_catalog_id`; an aggregate rather than append-only rows). Recorded here precisely so a future reviewer does not "correct" it back toward the older, buggier table — and leaving `run_costs.model_id`'s dead column as a separate, untouched item.
- **Touchpoints that will redden CI if missed**: `EXPECTED_TABLES` in [client.test.ts](../../packages/db/src/client.test.ts) (thirteen → fourteen, plus the comment), its index-subset assertion, the new `0009` DDL snapshot, the `sessionCosts` + `SessionCostRow`/`NewSessionCostRow` exports from [index.ts](../../packages/db/src/index.ts), and the `database-schema.md` edits (the new `#### session_costs` section, the `/cost` query pattern, the §session_messages column drop, the §Secrets and §Concurrency notes). Any doc or test naming the migration must be written **after** `pnpm --filter @relavium/db db:generate` emits the real `0009_<words>.sql` — the filename is drizzle-kit's, not ours.