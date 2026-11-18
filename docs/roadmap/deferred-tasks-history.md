# Deferred tasks — closed record

> Status: Living

> Last updated: 2026-11-18 — created by splitting the register: closed sections moved whole, and each closed entry of an active section moved here as a verbatim block.

- **Related**: [deferred-tasks.md](deferred-tasks.md) (front door and active entries), [deferred-tasks-parked.md](deferred-tasks-parked.md) (entries waiting for a trigger), [current.md](current.md), [README.md](README.md)

Nothing here is work. Every entry is **done, superseded or declined**, kept so a later reader can see why something was closed and by what.
Apart from the edits the sweep log below lists, entries are not changed after they land here except to correct a link or add a bracketed pointer. A closed entry sits under a heading that names the section it came from,
with a link back to that section; a section that closed as a whole is kept as written under *Sections closed in full*. "Above" and "below" in these entries
refer to the register as one file; see *Position words* in [How to read the register](deferred-tasks.md#how-to-read-the-register).

## Sweep of 2026-11-18

A first pass of the Gate 0 *stale-entry sweep* ([current.md](current.md)) was applied to this file: entries were checked against the code and the documents where that was practical, and the rest of the register was **not** re-verified. Every change is listed so it can be reverted entry by entry:

- **Closed:** the `MODEL_PRICING` rows entry (superseded by ADR-0071), the struck-through gate-timeout duplicate, the CLI render-layer harness entry (the harness exists), and the tooling half of the "Tooling and documentation nits" entry (accepted with Step 9a.1; the entry was split in two, the duplicate-heading half stays open for 19b).
- **Reworded:** the PR #95 review intro ("three of its four lows" → two of four, per the revert in `ebbec1c0`), the CR-70 schedule (now states the observation it waits for), and the MVP-3b D64 entry (PR #99 was merged).
- **Moved:** the Sora 2 entry (the provider shut the API down on 2026-09-24) and the CI speed-up question to *Open decisions*; the MVP-3 / PR #99 entries got a subheading of their own (they had sat directly under the 2026-10-16 Wave 3 ownership heading).
- **Markers added:** five open entries at the end of the 2.6.F section, written as bare bullets without a marker (so no count saw them), became `- [ ]`; two narrative sections that had no checkbox at all got a one-line entry marker ("Home's chat has no way to view or pick the bound agent" `- [ ]`, "The default chat agent cannot rename, move, copy or delete a file" `- [~]`); the `relavium budget resume` tracking pointer became `- [x]`.
- **Marked:** 278 `- [ ]` entries became `- [~]`, each on the evidence of its own text (an approved deferral, a named limit, a *Trigger*, or a plain condition such as "only when a real workflow needs it") or of its section intro. Five entries that an owner or a recorded ruling holds stay `- [ ]` although their section is a trigger ledger: the URL-password reading A4, the 0.1.x run settled by a newer reconcile and the stale gate card (all owed before v0.2.0), and the two entries filed "for Step 10a" and "for Step 9c". Apart from the closures above and the two documentation-hygiene entries marked done (R12b-08, R12b-12), no other marker changed; R12b-09 is half done and stays parked with the rest of its group, whose trigger (the sweep) has fired for this register only.
- **Pointers added:** bracketed *[Moved 2026-11-18 …]* notes (search for that phrase) where an open or sweep-written entry says "above" or "below" about an entry that now sits in another file; the paragraph *Position words* under *How to read the register* covers the rest.
- **Other documents:** the 27 links into the register were retargeted by file name only (one of them is in ADR-0105; its visible link text was left unchanged); in the living documents the visible text of a retargeted link now names the file it points to; two prose references in `packaging.md` and three in the phase 2.6 register were pointed at the new files; `roadmap/README.md` indexes the three files.
- **Not done:** the stable register IDs asked for by the documentation-hygiene entry (R12b-07); the stale entries that sit in other documents (`current.md`, phase registers, ADRs) — `current.md` still lists the sweep of this register *and* of the phase 2.6 bullets as pending, and only the register half has had a first pass; and a re-check of the many older entries whose staleness could not be shown quickly (for example `OPENAI_REASONING_CAPS`, the `mediaUnits` mapping, the 1.AE media-in conformance fixtures, the Home agent picker).
- **Then split:** the sections and closed entries moved to the two other files as unchanged blocks. A one-off script (not kept in the repository) checked that every non-blank line of the old file appears exactly once in the three new files, apart from the lines this sweep and split wrote. Phase 2.5.H, whose last open entry the sweep closed, moved whole.

## Sections closed in full

### Node.js runtime — dev/CI bump + supported-floor bump (the floor is now EOL)

- [x] **⚠ Supported floor (Node 20.12, EOL) → `>=22` — DONE (Phase 2.6.F Step 1, commit `367e4f5`).**
  Node 20 was EOL (2026-04-30) with no `better-sqlite3` prebuild (forcing a C++ source build). **Both halves
  shipped together** in Step 1: **(A)** `.nvmrc` 22 → 24 (Active LTS); **(B)** the supported floor 20.12 →
  `>=22` — a **breaking release** for published `relavium` (pre-1.0 → a **0.x MINOR** bump, e.g. `0.2.0`, at
  publish — *not* a SemVer-major) that restored `better-sqlite3` prebuild coverage and unlocked ink 7, and
  superseded [ADR-0021](../decisions/0021-node-sqlite-driver-better-sqlite3.md) via
  [ADR-0067](../decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (`better-sqlite3`
  re-affirmed over node:sqlite). `vitest` 5 / `eslint` 10 remain deferred to their own PRs (see the 2.6.F
  deferral entries below *[Moved 2026-11-18: the open ones are in the [2.6.F section](deferred-tasks.md#26f-full-screen-renderer--deferred-by-adr-0067--adr-0068-recorded-2026-07-09) of the active register]*). Analysis: [phases/node-runtime-upgrade.md](phases/node-runtime-upgrade.md).
  *(package.json engines + .nvmrc + pnpm-workspace catalog @types/node + tech-stack.md + ci.yml floor leg)*

### MVP-2 planning — the global `~/.relavium` is found as a project folder (2026-11-08)

> **Closed on development by MVP-2 step 3 (2026-11-10, `ee49871d`):** the
> shared discovery/authoring guard and `init` now exclude global state and its
> aliases. Existing artifacts stay in place; catalog `list` and `/doctor` name the
> [move/import remedy](../reference/cli/commands.md#relavium-init). Three cumulative
> reviews and the separate filesystem sitting passed; the
> [acceptance record](phases/phase-2.6-conversational-authoring.md#step-3-acceptance-2026-11-10)
> records the actual-target corrections and verification.

> **Merged to `main` — 2026-11-11:** PR #98 (`0db4c940`); see the
> [MVP-2 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-2-merge-checkpoint-2026-11-11).

Found while planning `init`. `findProjectConfigDir` (`apps/cli/src/config/paths.ts`) walks up from the working
directory to the filesystem root and returns the first `.relavium/` directory it finds. The global configuration
directory is `~/.relavium/`, and it always exists after a first run. From any directory under the home folder that has
no project `.relavium/` of its own, the search therefore returns the global folder.

Verified on 2026-11-08 by calling the function with a fake home: from `<home>/projects/foo` with no project folder it
returned `<home>/.relavium`.

- `relavium create` and `import` (through `resolveProjectConfigDir`) and the chat's `/export` (through the loaded
  `projectConfigDir`) write workflow and agent YAML into `~/.relavium/workflows/` and `~/.relavium/agents/`.
- `relavium list` and `relavium run <id>` then find those files from every such directory, so authored workflows
  leak across unrelated projects.
- A `workspace.toml` or `project.toml` placed in `~/.relavium/` would load as project configuration for every
  directory under the home folder. Relavium does not create those files.

**Fix:** the search stops before the global configuration directory, which is never a project folder. Existing files
already written into `~/.relavium/workflows/` are left in place; slice 2b decides how an affected user is told.

### `chat-resume` opens on an empty viewport (2.6.C spin-off, 2026-07-12)

> **Closed on development — MVP-2 step 4, 2026-11-10 (`cecb6191`).**
> Both renderers restore safe visible history, with explicit legacy placeholders,
> archive/memory notices and initial entry budgets. The
> [acceptance record](phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10)
> owns the evidence. The description and scheduling discussion below are historical.

> **Merged to `main` — 2026-11-11:** PR #98 (`0db4c940`); see the
> [MVP-2 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-2-merge-checkpoint-2026-11-11).

> **Found while fixing 2.6.C's F1** (the `/models` reseat blanking the alt-screen viewport). Deliberately scoped
> OUT of that fix, and recorded here so it is tracked work rather than a discovery that gets lost.
>
> **Scheduled 2026-11-04:** the CLI MVP's MVP-2 repaints a resumed session's transcript
> ([current.md](current.md#next-work--the-cli-mvp)); close this entry when that lands.

`relavium chat-resume <sessionId>` restores the model's context from `history.db`, but opens on an **empty
viewport** — the prior conversation is never repainted. This is **not** the 2.6.F regression F1 is: it has been
true in *every* mode and *every* version, because **nothing anywhere projects `session_messages` into rendered
`TranscriptEntry`s** — that projection has simply never been written. Inline and alt-screen behave identically.

It shares F1's *root* (`SessionViewSeed.transcript`, now the seam 2.6.C adds) but not its *cause*, and fixing it
needs machinery F1 does not:

- a DB → `TranscriptEntry` projection (`session_messages` rows → the `{role, text}` / `{role:'assistant', text,
  summary}` union), including what to do with rows a `/compact` or `/trim` dropped;
- a decision on whether the **inline** renderer should repaint history on resume too — which would be a genuine
  behaviour *change*, not a regression fix (today it prints nothing, and that is consistent).

Why it was not folded into 2.6.C: F1 is a regression on the just-shipped default surface and ships as a hotfix; this
is a long-standing UX gap that would have added a DB read path and an inline behaviour change to a view-only fix.
The seam it needs (`SessionViewSeed.transcript` + `carriesSeedTranscript`) is already in place after 2.6.C Step 2,
so the remaining work is the projection and the inline decision.

**Original schedule → 2.6.G** (the `/agents > Sessions` browser owned resume-in-place).
MVP-2's closure above supersedes that schedule. The earlier "2.6.C's natural sibling or 2.6.G, whichever reaches it first" hedge is spent: 2.6.C shipped 2026-07-13 without it.

### Cross-turn tool-call memory as a default-off toggle (2.6.C spin-off, 2026-07-12)

> **Status, 2026-09-14: decided, and this entry is superseded by three records.**
>
> - **The three prerequisite defects** it names are decided in
>   [ADR-0096](../decisions/0096-a-request-is-measured-before-it-is-sent.md) and scheduled into `W7`, tracked
>   since 2026-09-18 as register item `CR-98`:
>   - no measurement of a request before it is sent;
>   - an overflow that kills the turn;
>   - a budget estimate that ignores input.
> - **Carrying itself is deferred** in
>   [ADR-0095](../decisions/0095-what-an-agent-session-remembers-across-turns.md) §2. Its deferral record is in the
>   Phase 2.6.5 deferrals above *[Moved 2026-11-18: now in [deferred-tasks-parked.md](deferred-tasks-parked.md#phase-265-deferrals--cr-93-and-cr-95-long-half-recorded-2026-09-06-cr-70-cr-94-remainder-and-the-in-turn-overflow-continuation-recorded-2026-09-14-the-errored-or-aborted-turn-residual-the-pre-upgrade-free-page-bytes-and-the-estimators-calibration-recorded-2026-09-18)]*. The default-off toggle idea survives there as a user-scoped `[preferences]` key,
>   not a `[chat]` key.
> - **Some analysis below is out of date.** It was written before `W1`–`W6`, and its line numbers no longer match.
>   It is kept as the record of the original analysis.

> Raised while investigating a "`/models` reseat forgets tool calls" report (2.6.C / PR #75). The investigation's
> findings are restated in full below — every claim carries its own `file:line`, so this entry stands alone.
> Recorded here — deliberately **not actioned** — pending a maintainer call on sequencing and risk.

The premise behind the original report is wrong: the engine drops `tool_use`/`tool_result` pairs at **every**
turn boundary, model switch or not — a deliberate design cut (ADR-0062 §6, deferred to Phase 3 by ADR-0059).
This is the same gap already tracked below as **"Faithful cross-turn transcript (tool + reasoning history)"**
in the AgentSession (1.V) follow-ups section. This entry adds one new idea surfaced during the analysis —
gating the eventual fix behind a default-off config toggle — plus the risks that come with it.

**The idea:** ship cross-turn tool-call carry behind a **default-off** `[chat]` config toggle (e.g.
`carry_tool_history`), the same opt-in-then-flip pattern ADR-0068 already established for the mouse-wheel
default. Note the toggle really only has **one** meaningful axis, not several: reasoning/`signature` can never
be carried regardless of any toggle (ADR-0030 — a structural, cryptographic replay boundary, not a
preference), and `@`-mention file content already carries correctly today (fixed in `8ba7737`). So "which
data types carry across a model switch" reduces to a single boolean, not a multi-way settings panel.

**What the toggle would gate (confirmed touchpoints — no schema migration needed):**
- `DurableContentPart` (`packages/shared/src/content.ts:626-660`) already has `tool_call`/`tool_result` arms;
  `session_messages.content_parts` (`packages/db/src/schema.ts:475`) already round-trips them. The
  `tool_calls`/`tool_call_id` columns are write-only denormalized metadata never read back
  (`packages/db/src/session-store.ts` `fromSessionMessageRow`) — not a blocker.
- The persister (`apps/cli/src/chat/persister.ts` `appendText`, lines 118-131) writes **text only**; it never
  touches `agent:tool_call`/`agent:tool_result` events.
- `reconstructSessionState` (`packages/core/src/engine/session-resume.ts:110-141`, `textOf` 43-48) flattens
  every non-text part to text on replay — would need to splice paired assistant/tool `LlmMessage`s back in
  instead.
- `agent-session.ts` builds `#messages` text-only today (declaration :363, pushes at :548/:575-576) with an
  explicit deferral comment at :567-574 — this is the actual splice point.

**Why the toggle doesn't remove the prerequisite risk.** The three 🔴 gaps the analysis found are independent,
**already-live** bugs today, not side effects of tool-carry:
1. No pre-egress context-window check — `#maybeAutoCompact` (`agent-session.ts:619`) runs after the request
   already went out; nothing checks the outbound request against the window before sending.
2. Overflow kills the turn outright — a 400 (`bad_request`, `packages/llm/src/llm-error.ts:43`) isn't in
   `RETRYABLE_KINDS` (`:15-20`), so FallbackChain never engages; there's no `context_overflow` kind to catch it.
3. The budget gate only prices output tokens — `estimateMaxNextCost` (`packages/llm/src/budget-estimator.ts:16-26`)
   ignores a growing input history entirely.

A default-off toggle narrows **who** hits these (opt-in users only), not **whether** they're real. And the
opt-in population — power users, and especially the future VS Code coding-assistant surface where remembering
a file a tool read 3 turns back is the actual point — is exactly the segment most likely to run long sessions,
and therefore most likely to hit an overflow. Shipping the toggle before the three fixes trades a vague "model
forgot" complaint for a harder "turn died mid-conversation with no recovery" complaint, for the very users who
opted in.

**Sequencing implication:** fix the three prerequisite bugs first (independent value regardless of tool-carry);
design tool-carry from the start behind the default-off toggle so it can follow immediately after, rather than
waiting for a strictly separate later window. A new ADR is required either way — one that **supersedes**
ADR-0062 §6 (ADR-0059 needs no change; it already says "deferred to Phase 3").

**Also open:** the toggle's discoverability depends on a `/settings` surface, which doesn't exist yet (no
workstream scaffolds it today). Don't advertise "change this in `/settings`" in the model-switch notice
(`apps/cli/src/chat/repl-info.ts` `modelSwitchNotice`, lines 171-177) until that surface is real — pending a
maintainer call on whether to point at a `config.toml` key in the interim, or say nothing until `/settings`
ships.

**Home:** Phase 3 (or a later Phase-2.6 workstream) — natural sibling to the AgentSession (1.V) "Faithful
cross-turn transcript" item just below; whichever lands first should absorb the other.

### Phase 2.5.H (reasoning rendering + live-turn feedback) follow-ups

> **2026-07-07 2.5.H (EA6 + live-turn feedback).** The reasoning-event emit + the TUI reasoning/latency render
> shipped. The bounded pieces below were deliberately deferred (each additive, none blocks the feature):

- [x] **CLOSED 2026-11-18 (stale-entry sweep) — CLI render-layer (ink component) test harness.** The harness this entry
  asked for exists: `apps/cli` declares `ink-testing-library` as a devDependency (`apps/cli/package.json`) and mounts components with it
  (`transcript-viewport.test.tsx`, `measured-frame-acknowledgement.test.tsx`, `home-app.test.tsx`), and the very regression test the entry
  names — the Home live timer's elapsed counter advancing as the clock moves across `store.tick()`-driven renders — is
  `home-app.test.tsx` "advances the elapsed counter as the wall clock moves across ticks". 2.6.F is done (PR #74). The original entry follows.
  The CLI has **no** component-render test (no
  `ink-testing-library` / `react-test-renderer`) by design — all logic lives in pure reducers/formatters that ARE
  unit-tested. But this leaves the React **prop-plumbing / render-cadence** layer untestable: the 2.5.H Home
  live-timer fix (threading the clock as a `now: () => number` FUNCTION so the per-frame `ChatRegion` re-reads it,
  vs a frozen number captured at the parent `RootApp`'s render) is verified only by tracing + the type-shape guard,
  not by a regression test. Adding a harness is a first-of-its-kind test-architecture decision for `apps/cli`
  (a new devDependency; possibly an ADR) — track it, then a smoke test could tick a fake clock across two
  `store.tick()`-driven renders and assert the displayed elapsed advances. **Scheduled → 2.6.F** (behind the
  full-screen renderer + harness ADR). *(low · apps/cli/src/render/tui/home-app.tsx
  + chat-ink.tsx; testing.md "every bug fix lands with a regression test")*
- [x] **Compact abort hint during token streaming — DONE (2.5-close Step 12, Batch B; PR #69).** A pure
  `streamingAbortHint(busy)` renders a compact dim `Esc to stop` line beneath the streaming CONTENT (a STATUS line
  already carries its inline hint), so the abort affordance persists for the whole turn (EA7). *(apps/cli/src/render/tui/chat-projection.ts + chat-ink.tsx)*
- [x] **Bound the EXPANDED reasoning panel by rendered LINES, not just chars — DONE (2.5-close Step 12, Batch B; PR #69).**
  `formatReasoningPanel` now tails the expanded body to the last `MAX_REASONING_PANEL_LINES` (12) RENDERED rows
  (each logical line counts as `ceil(len/columns)` wrapped rows; a single over-budget line is head-sliced), so a
  full 4000-char buffer cannot wrap into a flickering, screen-filling panel on a short terminal. The live width is
  threaded via a `columns` prop (ChatApp reads `process.stdout?.columns`; the Home passes its resize-tracked
  `size.cols`). *(apps/cli/src/render/tui/chat-projection.ts + chat-ink.tsx + home-app.tsx)*
- [x] **Allow `Ctrl+T` / `/thinking` during a pending approval — DONE (2.5-close Step 14, D-4; PR #69).**
  `reduceApprovalKey` whitelists exactly the view-only reasoning toggle (Ctrl-without-meta `t` → `toggle-reasoning`,
  a pure store repaint with zero session/approval/decision effect) through the fail-closed swallow, so a user can
  expand the thinking to inform the decision; every other key (mode cycle, edits, the most-permissive approve/reject
  chord) stays swallowed. *(apps/cli/src/render/tui/chat-input.ts)*

### The CLI e2e suite opens and MIGRATES the developer's real `~/.relavium/history.db` (2.6.C spin-off, 2026-07-13)

> **DONE 2026-07-13 (PR #76 review fold).** `regression.e2e.test.ts` now redirects `HOME`/`USERPROFILE` to a
> fresh `mkdtempSync` dir in a suite-wide `beforeEach` (restored + removed in `afterEach`), so the full-shell
> `run(argv)` case migrates a throwaway db, never the developer's real history. A guard in the same hook refuses
> to proceed if the redirect fails to take (`resolveHomeDir({}) === realHome`), so a future test cannot silently
> re-acquire the default path. The evidence and rationale below are kept for the record.

> Found while diagnosing a red CI run during 2.6.C (PR #75). Verified, not inferred — see the evidence below.

`apps/cli/src/harness/regression.e2e.test.ts` drives the real CLI shell (`run(argv('run', …, '--json'), io)`)
without pointing it at a database, so the run resolves the **default** path and opens
`~/.relavium/history.db` — the developer's actual chat history. It does not merely read it: it **runs
migrations against it**.

**Evidence.** Executing that one test file with `HOME` pointed at an empty directory creates
`$HOME/.relavium/history.db` with all 11 migrations applied. Under a real `HOME` those migrations land on
real data. (The sibling test at `:315` does this correctly — `mkdtempSync` + an explicit `dbPath` — so the
isolation exists; this path just does not use it.)

**Why this is worth fixing rather than tolerating.** It is not a hypothetical: during 2.6.C the coupling
actively **hid a bug from CI and converted it into damage to real data instead**. A migration was re-cut
while in development, which changes its journal timestamp; drizzle replays such a migration, so
`CREATE TABLE session_costs` ran a second time against the table it had itself created. On CI this is
invisible — a fresh runner has no `~/.relavium/history.db`, so nothing had been applied and nothing could
conflict. The failure surfaced only on the maintainer's machine, against a 3.3 MB database of real
sessions. A test suite that writes to real user data both damages it and blinds CI to the damage.

**Fix:** give the failing path the same isolation the sibling already has — a temp dir + an explicit db
path — and, as a floor, make the e2e harness refuse to run against the default history path at all, so a
future test cannot silently re-acquire it.

**Home:** a `chore` pass, or whichever workstream next touches the CLI harness.

### Declined findings (closed — recorded for the record, never actionable)

- **Sandbox `Math.random` fallback re-check narrowness — DECLINED, accepted residual.**
  `packages/core/src/expression/sandbox.ts:219-225` re-checks `typeof Math.random === 'function'` after the
  neutralizing `delete`, not the wider "is not undefined"; a hypothetical future QuickJS variant that left
  `Math.random` as some non-function, non-undefined value after a failed delete would slip past this
  narrower guard. **Declined:** `Object.freeze(Math)` two lines later is the real backstop regardless of
  what value `Math.random` holds, the currently-pinned QuickJS variant is fully covered by
  `sandbox.test.ts` (lines 112-116, 533-545), and the finding's own analysis concludes no action is needed
  until the QuickJS variant changes. *(polish · packages/core/src/expression/sandbox.ts:219; #84)*

- **Alt-screen `restore()`'s idempotent latch-after-success design — DECLINED, verified strength, not a
  defect.** `apps/cli/src/render/alt-screen.ts:88-109` sets its idempotence latch only AFTER the
  terminal-restore write succeeds, so a transient EIO/EPIPE on a half-dead TTY during one teardown net
  (finally / `process.on('exit')` / a signal handler) leaves the terminal recoverable by the NEXT net rather
  than being permanently marked "restored" after a failed write. **Declined:** the review confirmed this is
  the correct pattern, not a bug — recorded here as the bar (`suspend.ts`'s `suspendFullScreen` already
  matches it) the rest of the codebase should be held to, not as an item to fix.
  *(polish · apps/cli/src/render/alt-screen.ts:88; #67)*

- **Full-repo `knip` dead-export inventory — DECLINED, no further action beyond its two spin-offs.** A
  full-repo `knip` pass surfaced 3 unused-file hits (2 false positives — ESLint fixture configs consumed via
  ESLint's file-path API, not a TS import), 7 "unused dependency" hits in `apps/cli/package.json` (all false
  positives — declared for ADR-0051's tsup bundle closure, not directly imported), 39 "unused" function/const
  exports, and 112 "unused" exported types. Manual verification of all 39 function/const exports found every
  one but `isDispatchableId` is used internally within its own declaring file (an unnecessary `export`, not
  dead code); the 112 types are near-entirely `...Deps`/`...Options`/`...Args` DI interfaces exported for
  documentation, a standard low-cost pattern here. **Declined:** the finding's own conclusion is no action
  beyond the two genuine hits it already spun off (`isDispatchableId`, the `@relavium/llm/adapters` subpath
  export) — already tracked under the quality dead-code cleanup work; the remaining ~150 hits are confirmed
  false positives, not deferred work. *(polish · packages/db/src/media-write.ts; #245)*

## Closed entries moved out of active sections

### Multimodal forward-obligations (carry the not-yet-coded pieces — see ADR-0031) — closed entries

*Origin: the section [Multimodal forward-obligations (carry the not-yet-coded pieces — see ADR-0031)](deferred-tasks.md#multimodal-forward-obligations-carry-the-not-yet-coded-pieces--see-adr-0031) of the active register.*

- [x] **MCP SDK network transport — upgrade to connect-by-validated-IP ([ADR-0053](../decisions/0053-mcp-network-transport-egress-security.md) §2).** *Closed in 2.6.5 `W4` Step 2 ([ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md) §2–§4). `http`/`sse` take an injected validated `fetch`, so the pin covers the whole session rather than the first dial, and the local opt-in's `host:port` scope is enforced at the dial — which is what `SEC-EGRESS-3` required of any wiring of it. Two clauses of the entry below were NOT met as written and were superseded rather than quietly dropped: a redirect is **refused** instead of re-validated per hop, and `websocket` — whose SDK transport accepts no dialer and parses frames before Relavium sees a byte — is **narrowed to a local endpoint** instead of carrying the floor. The original text is kept below for the record.*  2.R ships **pre-connect host validation** as the floor for the `http` (Streamable HTTP) / `websocket` MCP transports — the `@modelcontextprotocol/sdk` opens its **own** socket, architecturally distinct from the `EgressCapability.fetch` hook above. When the SDK transport exposes an injectable `fetch`/dialer hook, upgrade to **connect-by-validated-IP**: resolve DNS → validate the IP against the shared range-block primitive → connect to that IP, re-validating on each redirect hop — closing the residual DNS-rebind window. **The dialer + redirect re-validation MUST enforce the authored `host:port`** (ADR-0053 §3 / SEC-EGRESS-3), not just the host: an `allow_local_endpoint` server is permitted exactly its declared `host:port`, so a resolved/redirected target on a *different* port of the same permitted-private host (`:6379`/`:5432`/`:22`/the Docker socket) must be re-blocked. (2.R's pre-connect floor is host:port-safe by construction — the SDK dials exactly the one authored url — so this constraint binds the dialer, not the floor.) Each MCP network mechanism gets a dedicated security-review pass when it lands. *(packages/mcp/src; ADR-0053 §2/§3; ADR-0043 mechanism)*
- [x] **MCP `stdio` spawn — consent before a local spawn ([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md), CR-16).** *Closed in 2.6.5 CR-16, and **re-scoped on the way**: the original entry gated only an "untrusted-provenance" import, which drew the line in the wrong place — a `git pull` changes a committed `.relavium.yaml` with no import step, and "my own repo" is a provenance claim about a file, not about the program it names. ADR-0084 gates **every** stdio server on **every** CLI path that can open an MCP-bearing artifact, per machine and per resolved declaration. Resolution happens **before** the decision and the resolved absolute path is what is spawned, so a `PATH` change cannot substitute a binary under an approved fingerprint; the declared-environment denylist is now shared with `run_command`. The desktop's Rust spawner is **outside** this gate and owes the same contract — see [mcp-integration.md](../reference/shared-core/mcp-integration.md#consent-before-a-local-stdio-spawn-cross-surface-contract). *(apps/cli/src/engine/mcp-consent\*.ts; packages/shared/src/{canonical,declared-env}.ts; ADR-0084)*
- [x] **MCP host boundary — strip `McpConnectError.cause` from `--json` / event output (2.R Step 3, [ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2).** *Resolved in the 2.R Step 3 host wiring:* `startMcpClientFailLoud` (apps/cli/src/engine/mcp-servers.ts) wraps an `McpError` into a typed `CliError` whose message is the secret-free MCP summary with **no** `{ cause }` attached, and the top-level `--json` renderer (apps/cli/src/process/render-error.ts) serializes only `{ type, code, message }` — never `cause`. Regression-locked by `run.test.ts` (`expect(err.cause).toBeUndefined()`). *(apps/cli; packages/mcp/src/errors.ts; 2.R Step 3)*
- [x] **Per-model `media_surface` lookup — wired by the CLI (✅ PR #52, 2.S; verified + checked off 2026-07-08).**
  Section C added `AgentRunnerDeps.resolveMediaSurface?(model) → MediaSurface` (the inline-vs-generative routing
  discriminator, default `'chat'`; tests inject it). The production wiring — the host reading
  `model_catalog.media_surface` and supplying the lookup — landed with 2.S: `media-wiring.ts` supplies
  `catalog.resolveMediaSurface` (the `model_catalog` projection) and `build-engine.ts` threads it into
  `AgentRunnerDeps`, so a generative model routes by its catalog surface on the CLI. The sibling D15/D17/D8
  host-wiring items were checked off at PR #52; this one was missed then. The desktop/VS Code surfaces reuse the
  same injectable port (Phase-3/Phase-4). *(apps/cli/src/engine/media-wiring.ts + build-engine.ts; PR #52)*
- [x] **SUPERSEDED 2026-11-18 (ADR-0071) — Verified generative model rates + `MODEL_PRICING` rows (1.AG Section C → 1.AH).**
  *Stale-entry sweep, 2026-11-18:* the `MODEL_PRICING` table this entry asks to extend no longer exists —
  [ADR-0071](../decisions/0071-models-dev-as-the-model-metadata-source.md) retired it (`packages/llm/src/pricing.ts`
  now only defines the contract), and the ADR's media-output-rates row records the rates as **absent** (`cost: null` on
  every image model), "filled from a Relavium overlay if ever needed"; a user can price a modality with `models pricing
  --image`. What survives of the entry is its **test follow-up** (no non-zero media-cost dispatch assertion, because no
  shipped model carries a rate): it is tracked by the "Budget-governor media-cost block/warn/fail path has no
  non-zero-estimate test" entry in the 1.AF section of the active register and by the `CR-55` residuals. The original entry follows. The Section C cost
  mechanism (pre-egress estimate + the one realized `cost:updated`) reuses `estimateMediaCost`/`mediaCost`, which
  **degrade to 0 on a missing rate** (H4). No generative model rows were added to `MODEL_PRICING` — fabricating
  billing rates is a mis-bill risk and the existing rows are all "verified". Add the generative rows (gpt-image-1,
  Imagen, OpenAI-TTS, Sora, Veo) with **verified** `mediaOutputRates` (image per-image; audio/video per-second) when
  the catalog/pricing-page values are confirmed; until then a generative call is correctly gated/folded at 0 cost
  (no mis-bill). **Test follow-up:** the realized-cost vertical (`realizedMediaCost` → a non-zero `cost:updated`)
  cannot be exercised end-to-end until a generative model carries a rate; the cost MATH is unit-tested via
  `mediaCost` against a constructed rate, and a non-zero dispatch assertion lands with these rows. *(packages/llm/src/pricing.ts; verified rates → 1.AH)*
- [x] **Durable realized cost for a FAILED/CANCELLED paid media job — ✅ Done (PR #52, 2.S Part 3).**
  `node:failed`, `run:cancelled`, AND `run:failed` now each snapshot `cumulativeCostMicrocents` onto the durable
  terminal (the `#emitMediaJobCost` fold runs just before the terminal), so a durable-log reader reconstructs a
  billed-but-failed/cancelled media job's cost from the persisted log, not only the live `cost:updated` stream.
  The checkpoint fold reads cost only from `node:completed`, so resume is unaffected (ADR-0045 §5).
  *(packages/core/src/engine/engine.ts; shared/run-event.ts; PR #52)*

### 1.AF P4 forward-obligations — engine policy landed, HOST WIRING deferred (review 2026-06-19) — closed entries

*Origin: the section [1.AF P4 forward-obligations — engine policy landed, HOST WIRING deferred (review 2026-06-19)](deferred-tasks.md#1af-p4-forward-obligations--engine-policy-landed-host-wiring-deferred-review-2026-06-19) of the active register.*

- [x] **`validateWorkflowWithCatalog` (D15) — wired by the CLI loader (✅ PR #52).** `run` and `gate` call it
  post-parse via `assertWorkflowCatalogValid` (the shared `drive.ts` helper) over the DB `model_catalog`, so an
  incapable / malformed-generative authored `output_modalities` fails fast at LOAD (exit 2) on a fresh run AND a
  resume — not only at the runtime FallbackChain pre-skip. The desktop/VS Code loaders reuse the same
  `WorkflowModelCatalog` projection (phase-3/phase-4). *(apps/cli; PR #52)*
- [x] **`[defaults].media_cost_estimate` → `AgentRunnerDeps.mediaCostEstimate` (D17) — wired by the CLI (✅ PR #52).**
  `config/resolve.ts` reads the key and `media-wiring.ts` / `build-engine.ts` thread it into the engine, so the
  media cost governor uses the configured per-modality estimate (falling back to `DEFAULT_MEDIA_UNIT_ESTIMATE`
  only when unset). *(apps/cli; PR #52)*
- [x] **`resolveForEgress` (D8) — wired by the CLI host (✅ PR #52).** `build-engine.ts` injects the
  `FilesystemMediaStore.resolveForEgress` re-materialization hook, so a durable handle in a transcript message is
  re-materialized on the failover/egress path rather than sent unchanged. *(apps/cli; PR #52)*
- [x] **CAS-orphan crash window for `save_to` — ✅ Done (PR #52).** The host media GC's CAS-orphan sweep
  (`runHostMediaGc` step 3, ADR-0042 §4) deletes row-less CAS bytes (a crash between `put` and `recordObject`) —
  gated on no other active run AND an `orphanMinAgeMs` age-guard so a concurrent writer's fresh blob is never
  swept. *(apps/cli host GC; PR #52)*
- [x] **Clean-terminal media-reclaim retry — ✅ Done (PR #52).** The host media GC's clean-terminal reclaim-retry
  (`runHostMediaGc` step 1) re-attempts `removeRunReferences` for every settled (terminal/gone) run whose inline
  `#reclaimRunMedia` was dropped by a crash — never the current run (the engine reclaims it inline) and never a
  paused run (its media must survive a resume). *(apps/cli host GC; PR #52)*
- [x] **`save_to` resumer-cwd vs original-run project root — ✅ Done (PR #53).** `run` now persists the run's cwd
  to `runs.project_root` at run-start (threaded through `openHistoryStore` → `RunHistoryStoreDeps.projectRoot`),
  and `loadRunSnapshot` returns it; `gate` re-jails `save_to` under that ORIGINAL root (`snapshot.projectRoot ??`
  the resumer's cwd for a pre-column run), so a run started in dir A and resumed from B writes its deliverables
  under A. The `realpath`+`commonpath` jail holds under either root. *(apps/cli + @relavium/db; PR #53)*
- [x] **`[defaults].media_gc_grace_days` wired (✅ PR #53).** Added to the config Zod schema; `config/resolve.ts`
  resolves it (last-writer-wins) and normalizes DAYS → ms (`mediaGcGraceMs`); `run`/`gate` thread it into
  `sweepHostMediaBestEffort`'s `graceMs`. Absent ⇒ the built-in `DEFAULT_MEDIA_GC_GRACE_MS` (7-day) default
  (ADR-0042 §4c). *(apps/cli + shared config; PR #53)*
- [x] **`read_media` result must be schema-conforming for a multi-turn message (1.AH read_media contract).**
  ~~`read_media` returns a `{ type:'media', source:{ kind:'base64', data } }` MediaPart placed in
  `tool_result.result` … the result should carry a **handle**.~~ **Closed 2026-09-02 by `CR-50`**
  ([ADR-0089](../decisions/0089-media-correctness-four-boundaries.md) §1), and closed differently from what
  this item proposed: the tool returns **no `MediaPart` at all**. Its result is a short text descriptor and
  the media travels the media-INPUT rail on a synthesized `user` message, because `tool_result.media` is a
  position nothing lowers. Sub-item (c) — threading `AbortSignalLike` into `describe` — landed and is
  pinned by a test. Sub-item (b), narrowing `MediaReadAccess.readRange`, is **superseded**: the engine no
  longer calls `readRange` at all, so the wide type is no longer reachable from here; it is re-recorded in
  the `CR-50` residuals above *[Moved 2026-11-18: now in [deferred-tasks.md](deferred-tasks.md#phase-265-w5-residuals--cr-50-adr-0089-1-2026-09-02)]* as an arm awaiting its 1.AH desktop caller. *(Marked closed rather than
  deleted: this item and the `CR-50` residual disagreed with each other in the same file for a day.)*

### PR #95 independent review — unactioned findings (2026-10-18) — closed entries

*Origin: the section [PR #95 independent review — unactioned findings (2026-10-18)](deferred-tasks.md#pr-95-independent-review--unactioned-findings-2026-10-18) of the active register.*

- **DONE 2026-10-19 — SonarCloud's quality gate was red on `main` after every merge.** *(author)* The `main`
  analysis failed `new_security_rating` (C, required A) against the `previous_version` baseline (2026-06-04) because nine
  vulnerabilities were open there: seven `githubactions:S6505` ("omitting `--ignore-scripts`") on the
  `pnpm install --frozen-lockfile` lines in `.github/workflows/ci.yml` (120, 432, 463, 487), `release.yml` (94) and
  `models-catalog.yml` (51, 95); one `jssecurity:S8707` at `tools/budget-replay-compat/lifecycle-smoke.mjs:47`; one
  `javascript:S4036` at `tools/cli-package/aggregate.mjs:58`. The gate had failed after the PR #90, #92, #94 and #95
  merges while the PR-level analyses passed, because SonarCloud statuses are per branch and the existing dispositions lived
  on PR branches and on other `main` records. SonarCloud is not a required check. At the maintainer's direction the
  dispositions were applied on `main` through the SonarCloud API after re-verifying each rationale at `6d2a7372`: the seven
  S6505 and the S8707 as false positives (same reasons as their `main` siblings; the install-script posture comment at the top of
  `ci.yml` and the Sonar backlog section below *[Moved 2026-11-18: the active register's [Sonar backlog](deferred-tasks.md#sonar-code-quality-backlog)]*), the S4036 accepted as on the PR #95 branch. SonarCloud then reported zero
  open vulnerabilities and an OK gate for `main`. No rule, threshold or gate was changed; the per-issue record is local
  and Git-ignored. *(was medium · process)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. An `api-key` header label erases the `Bearer`/`Basic` label that follows it, so the token leaks.** *Low (security).* *(author)* `scrubSecrets('api-key:Bearer abcdefghijkl123456')` returns `api-key:[REDACTED] abcdefghijkl123456` — the `api-key` rule consumes the word `Bearer` as the header's value and the Bearer rule then has no label to anchor on. The pre-PR matcher returned `api-key:Bearer [REDACTED]`. Surfaced by the post-merge security sitting, reproduced independently; it came from the PR's rule order, not from `a3e164b5`, and was not fixed when recorded. A plain `Authorization: Bearer …` was unaffected. **Closed by the PR95 increment:** a header value may begin with up to eight `Bearer`/`Basic` labels, and the example now returns `api-key:Bearer [REDACTED]` (re-checked at `b3cf117e`, 2026-11-04). *(low · packages/llm/src/scrub-secrets.ts)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. URL userinfo containing a raw `?` or `#` before the first `:` (or with no `:`) is not masked.** *Ruled 2026-10-19:* mask unless the text before the `?`/`#` is host-shaped (a dotted hostname, `localhost` or a bracketed IP, with an optional `:port`) **and** an `=` assignment lies between the `?`/`#` and the authority `@`; a plain host-shaped exemption would still leave `https://my.user:1234?TOKEN@h/` open. The same predicate applies to core's twin in `packages/core/src/tools/bounding.ts` (its colonless short-handle rule and `]` delimiter stay, recorded as differences). *Low (security).* *(author, from two independent differential runs)* When recorded, `https://us?er:TOKEN@h/`, `http://#TOKEN@h` and `https://my.user:1234?TOKEN@h/` passed through unchanged; the pre-PR matcher masked all of them. **Closed by the PR95 increment:** all three return masked userinfo (re-checked at `b3cf117e`, 2026-11-04). It follows from the deliberate host-query policy in `maskUrlUserinfo` (a raw `?`/`#` may begin public query text, e.g. `https://host?contact=a@b.c`) and the colon-first cases are pinned by tests; it is identical at `19c99968` and is not introduced by the follow-up. (As recorded, it asked for a maintainer call and proposed the host-shaped exemption the 2026-10-19 ruling above adopted.) *(low · packages/llm/src/scrub-secrets.ts)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. Credentials in URLs of other schemes are outside the finite rule.** *Ruled 2026-10-19:* extend the finite list with postgres, postgresql, mysql, mariadb, redis, rediss, mongodb, mongodb+srv, amqp, amqps, ssh, sftp, ldap, ldaps, smtp and smtps, masking only colon-bearing userinfo for the new schemes; malformed `https:/u:p@h`, a raw `/` inside a password and invisible characters inside the scheme stay documented limits. *Low, informational.* When recorded, `postgres://`, `redis://`, `mongodb(+srv)://`, `ssh://` userinfo, malformed `https:/u:p@h`, a raw `/` inside a password, and invisible characters inside the scheme were not masked, identically before and after the follow-up. **Closed by the PR95 increment** as ruled: the listed connection-string schemes mask colon-bearing userinfo (`postgres://u:p@db` → `postgres://[REDACTED]@db`; a bare `ssh://git@host` stays), and the other three stay documented limits (re-checked at `b3cf117e`, 2026-11-04). The file states its shapes are finite; a database connection error is the realistic carrier (as recorded, it asked for the decision the 2026-10-19 ruling above made). *(info · packages/llm/src/scrub-secrets.ts)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. The URL rule's split-credential scan costs 2.1–2.5× on letter-heavy input, and nothing times that loop.** *Low / nit.* When recorded, with `NO_BOUNDARY` the scanner tested every ASCII letter start for the URL rule; at 8 MiB the worst case stayed under about 1.1 s and linear (1–16 MiB scaling checked), and the 8 MiB timing case of the time contained no `@`, so it returned before the loop. **Closed by the PR95 increment:** the URL rule's split probe now runs only within 32 characters of a `://` (`anchor: { text: '://', window: URL_SCHEME_WINDOW }`), and `reaches the split URL scan over admitted-size letter-heavy text` drives 8 MiB of letters through it under the case deadline instead of a wall-clock assertion (re-checked at `b3cf117e`, 2026-11-04). *(low · packages/llm/src/scrub-secrets.ts)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. Two latent invariants in `hasSplitCredential` are unchecked.** *Nit.* A boundary-bearing rule with neither `\b` nor a `joinedPattern` makes `scrubSecrets` throw a `SyntaxError` on LF/TAB input no earlier rule has redacted (the suite fails at once, so it is caught, but it would break `makeLlmError`'s no-throw claim); and `wordBlocksStart` tests `boundary.test('a')` as a proxy for "rejects every ASCII word character", true for all current boundaries. An assertion at module load would pin both. **Closed by the PR95 increment:** `splitProbe` checks the scanner's two invariants at module load, so a misconfigured rule fails fast with a typed error (re-checked at `b3cf117e`, 2026-11-04). *(nit · packages/llm/src/scrub-secrets.ts)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. The userinfo control's joined-view half is not separately witnessed.** *Low (coverage).* *(author, from an independent run)* When recorded, mutating only `joinedPattern` of the URL rule left 111/111 tests green, and no causal control pinned the glued-scheme behaviour. **Closed by the PR95 increment:** the `diagnostic-joined-url-userinfo` control replaces the URL rule's `joinedPattern` with a never-matching pattern, and `diagnostic-url-glued-scheme` pins the glued-scheme behaviour (re-checked at `b3cf117e`, 2026-11-04). *(low · tools/secrets-controls/mutations.mjs)*
- **DONE 2026-10-22 — Wave 3 PR95 increment, closed under the maintainer's round cap. `bounds admitted-size failed header and URL preparation` is load-sensitive.** *Low.* *(author)* It allows
  5 s for two 8 MiB scrubs that take about 0.75 s in total, and it failed twice with the load average near 65 (6.4 s
  in the run that logged the duration). Measured alternately, the pre-change code and the corrected code take the same
  time, so the failures were load, not the correction. Two independent reviewers saw it too (5,590 ms and 3,453 ms at load averages near 88–97) and recorded that `tools/secrets-controls/README.md` says the fixture runs without a machine-speed threshold, which this assertion contradicts; six controls run this file, so a loaded runner can turn a fixed phase red. The test
  guards against a quadratic regression, so any loosening must stay far below minutes. **Closed by the PR95
  increment:** the eight-MiB cases no longer assert a duration; their bound is the case deadline
  `ADMITTED_SIZE_CASE_TIMEOUT_MS` (15 s, the largest the secrets causal-control phases admit), far below the minutes a
  quadratic scan would need (re-checked at `b3cf117e`, 2026-11-04). *(low · packages/llm/src/scrub-secrets.test.ts, `SECRETS_B2_HEADER_PREPARATION`)*
- [x] **DONE 2026-10-24 (Wave 3 Step 9a.1) — the two tooling nits → 9a.1. Tooling and documentation nits (closed half).** *Split off in the 2026-11-18 stale-entry sweep from the "Tooling and documentation nits" entry, which had been left wholly open although its tooling half was closed; the open half (the duplicate headings, Wave 3 19b) stays in the PR #95 section of the active register.* *The tooling half is accepted with Wave 3 Step 9a.1 (implemented 2026-10-22, accepted at `cf97b7f1` on 2026-10-24):* the unreachable `TAR_FORMAT` branches are removed, and `installedModulesOwner` (`tools/cli-package/smoke/installation.mjs`) replaces the ancestor loop. *Nit, (reviewer).* Unreachable `TAR_FORMAT` branches at
  `tools/cli-package/archive.mjs:126,135`; no `break` in the ancestor loop at `tools/cli-package/smoke/worker.mjs:64-65`
  (the outermost `node_modules` wins). *(nit · the files above)*
- **No action, recorded 2026-10-19 — informational items kept in view.** No change is proposed for any of them; the `git_commit` approval wording is already covered by Wave 3 Step 5's #308 disposition. *(reviewer)* `packages/mcp/src/manager.ts:228-236` — a comment omits
  the bare `Error` in the throwing-observer branch (behaviour is canonical); `packages/core/src/tools/bounding.ts` —
  the removed 4k pre-clip in `makeSummary` is required for correctness (8 MiB takes about 49 ms, about 200 ms with
  line feeds) and the alias DAG is `2^d` (depth 18 is 786k nodes in 404 ms) for host/embedder graphs only, never model
  JSON; `packages/core/src/tools/builtins.ts:451-452` — the `git_commit` description promises human-gate approval
  while no producer sets `gateApproved=true` (not verified by the reviewer); `commands/workflow-lifetime.ts:204`
  can return a raw signal code above 9 that the physical exit never uses, a note for future embedders. No action
  is proposed for any of these.

### AgentRunner (1.O) / reasoning-replay follow-ups — closed entries

*Origin: the section [AgentRunner (1.O) / reasoning-replay follow-ups](deferred-tasks.md#agentrunner-1o--reasoning-replay-follow-ups) of the active register.*

- [x] **Gemini part-level `thoughtSignature` replay** — ✅ closed 2026-09-02 by `CR-52`. Gemini carries the
  continuity signature on any `Part`, and the adapter dropped it on a `functionCall` while `toGeminiParts`
  dropped every `reasoning` part outright — so the token was captured and then discarded one function away.
  Both halves now round-trip:
  [ADR-0090](../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md) put an optional
  `signature` on the canonical `tool_call` part and on the streamed `tool_call_end`, with
  `DurableContentPartSchema` forking a signature-less arm so "never persists" is structural; and a SIGNED
  reasoning part is now lowered back as a `thought` part carrying its token. ADR-0089 §3's sidecar was
  unbuildable — capture and replay straddle two adapter calls on a stateless adapter. The sibling
  **`redacted_thinking` opaque `data`** deferral is untouched and still open, as is the text/`inlineData`
  half recorded immediately below.
  *(was high · packages/llm/src/adapters/gemini.ts; ADR-0030 follow-up)*
- [x] **`output_schema` deep JSON-Schema conformance** — ✅ **DONE (2026-09-03, `CR-61`,
  [ADR-0092](../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)).** An
  `agent` node's `output_schema` was validated **parse-as-JSON only**, so `{"wrong":true}` passed for a
  `{ n: number }` schema; `transform` shared the gap and did not check its schema at all. Both now compile
  the schema at PARSE in `strict` mode and enforce conformance at run time, a miss failing `validation`
  (`retryable: false`).
  **The premise this entry rested on was false, and that is the part worth keeping:** it said deep
  conformance "needs a JSON-Schema validator … a new runtime dependency requiring an ADR". The project
  already owned a dependency-free JSON-Schema→Zod compiler at the MCP boundary, one package away. The
  deferral outlived its own reason by three phases because nobody re-checked the sentence that created it.
  *(packages/core/src/engine/agent-runner.ts, packages/core/src/engine/node-handlers/transform.ts,
  packages/shared/src/json-schema-compiler.ts; docs/reference/shared-core/json-schema-subset.md)*

### Node-type handlers (1.P) follow-ups — closed entries

*Origin: the section [Node-type handlers (1.P) follow-ups](deferred-tasks.md#node-type-handlers-1p-follow-ups) of the active register.*

- [x] **`secret`-typed input flowing into an agent prompt (1.O parallel to the 1.P fix)** — the AgentRunner
  resolves `{{ inputs.<name> }}` in a `prompt_template` against the **raw** `RunScope` (agent-runner.ts), so a
  `secret`-typed input interpolates raw into a USER message sent to the provider. This is provider **egress**
  the author opted into (not an event-payload leak, so it does not violate the events rule the 1.P fix
  enforces), but whether a `secret`-typed input should be silently interpolated into a prompt — vs masked /
  rejected at parse — is a policy call. **Decided (2026-06-21, maintainer): REJECT AT PARSE** — a
  `{{ inputs.<secret_name> }}` reference inside a `prompt_template` is a parse-time error with a clear
  message (secure-by-default; surfaces author intent explicitly rather than silently egressing or silently
  masking). **Resolved — verified already-satisfied during 2.D (2026-06-22).** The decided policy was
  already enforced by the 1.L2 parse-layer taint analysis: `collectReferences` covers the agent node's
  `prompt_template` (`collect.ts`), `analyzeSecretTaint` flags any tainted reference reaching model-visible
  text, and `parseWorkflow` turns a non-empty result into a `WorkflowSecretLeakError` (`secret_interpolation`)
  before a `WorkflowDefinition` is ever produced — so a run never starts on such a file. Covered by tests for
  the direct case (`analyze.test.ts` "rejects a secret-typed input interpolated directly into a prompt"), the
  transitive-via-`context` case, and `$ref`/registry agents (`analyzeResolvedAgentTaint`). 2.D made
  `relavium run` the first live `prompt_template` consumer and confirmed the guard holds end-to-end; no new
  code was required. *(low → 2.D · packages/core/src/interpolation/analyze.ts + collect.ts + parser.ts;
  security-review.md)*

### Checkpoint/resume + human gate (1.R / 1.Q) follow-ups — closed entries

*Origin: the section [Checkpoint/resume + human gate (1.R / 1.Q) follow-ups](deferred-tasks.md#checkpointresume--human-gate-1r--1q-follow-ups) of the active register.*

- [x] **Re-arm a still-pending gate's timeout on cross-process rehydration — ✅ Done (Phase 2.6.5 `CR-22`, 2026-08-27).**
  Closed exactly as this note predicted: no backfill was needed, because `timeoutAction` + `expiresAt` were
  already durable on `human_gate:paused`. The gap was one layer up — `reconstructCheckpointState`'s fold
  dropped both fields, so `#seedFromCheckpoint` had nothing to re-arm from. The fold now keeps them and
  rehydration arms at `expiresAt − now`; a past deadline arms at zero so it travels the same
  `#onGateTimeout` path as a live expiry. The original entry follows.
- [x] ~~**Re-arm a still-pending gate's timeout on cross-process rehydration**~~ — `resumeFromCheckpoint` applies
  the target gate's decision immediately, but a *remaining* pending gate (multi-gate run, crash-while-paused)
  is rehydrated without re-arming its timer, so its deadline is lost until the next restart. The data needed
  (`timeoutAction` + `expiresAt`) is now persisted on `human_gate:paused` (PR #22), so no backfill — Phase-2
  crash-reconciliation re-arms from the log against a real clock. **Scheduled → 2.6.K.** *(low · packages/core/src/engine/engine.ts `#seedFromCheckpoint`; Phase-2)*

### AgentSession (1.V) follow-ups — closed entries

*Origin: the section [AgentSession (1.V) follow-ups](deferred-tasks.md#agentsession-1v-follow-ups) of the active register.*

- [x] **Structural transcript/export implemented in W7; carrying stays separately deferred (`CR-70`).** **Superseded 2026-09-14:** persistence and
  export are decided by [ADR-0095](../decisions/0095-what-an-agent-session-remembers-across-turns.md) §1 and §3
  (`CR-71`, implemented in `W7`), and carrying is deferred under the `CR-70` record in the Phase 2.6.5 deferrals section.
  Reasoning is never carried (ADR-0030). The original note follows. 1.V appends only the final
  assistant **text** across turns: the turn core keeps the within-turn `tool_use`/`tool_result` pairs internal
  (so the transcript carries no orphaned `tool_use` and stays protocol-valid), and reasoning is dropped (a
  `signature` is a within-turn same-provider replay token — ADR-0030/0039 — that must not span turns). Carrying
  the full per-turn tool/reasoning history needs the turn core to **expose its intermediate messages**
  (`runAgentTurn` copies its input and returns only final content) — revisit when 1.X persistence / 1.Z export
  needs faithful turns, once `agent-turn.ts` is settled. *(medium · packages/core/src/engine/agent-session.ts + agent-turn.ts; 1.X/1.Z)*
- [x] **`[chat].max_turns` surface wiring — RESOLVED in 2.5.G S11 (PR #66).** The hard turn cap is an
  **engine-API** knob in 1.V (`SessionDeps.maxTurns`, finite default 50); the CLI now maps the `[chat].max_turns`
  config default onto `SessionDeps.maxTurns` (`config/resolve.ts` `max_turns`→`maxTurns`, threaded through
  `session-host.ts`, enforced by a `session-host.test.ts` pin). *(config-spec.md + surfaces)*

### Phase 2.5.D (`@`-mention / input ergonomics) follow-ups — closed entries

*Origin: the section [Phase 2.5.D (`@`-mention / input ergonomics) follow-ups](deferred-tasks.md#phase-25d--mention--input-ergonomics-follow-ups) of the active register.*

- [x] **Advisory `.gitignore` / `.relaviumignore` completion trim — DONE (2.5-close Step 15, Batch E; PR #69).** A
  dependency-free, ReDoS-safe in-house matcher ([gitignore.ts](../../apps/cli/src/render/tui/gitignore.ts)) folds
  the workspace-root `.gitignore` + `.relaviumignore` into the `@`-mention candidate filter (comments/blanks, `!`
  negation, dir-only `/`, anchoring, `*`/`**`/`?` globs; a LINEAR two-pointer glob matcher — no regex, so no
  backtracking/ReDoS on a crafted pattern), complementing the fixed `NOISE_DIRS` set. A
  UX/privacy nicety, NOT a security control — the confidentiality floor + listing-gate remain the authoritative
  fs-capability enforcement. Documented subset limits: nested per-dir ignore files + `[a-z]` char classes deferred
  (they only UNDER-hide, never a security gap). *(apps/cli/src/render/tui/gitignore.ts + mention.ts; ADR-0061)*
- [x] **Strip Unicode bidi/format controls at the shared display boundary — DONE (2.5-close Step 14, D-5; PR #69).** The
  shared `stripTerminalControls` (chat-projection.ts) now strips the Trojan-Source reordering family (U+202A–202E,
  U+2066–2069, LRM/RLM/ALM) at every display boundary; ZWJ/ZWNJ preserved; the source uses `\u` escapes (no literal
  bidi bytes). *(apps/cli/src/render/tui/chat-projection.ts)*

### Phase 2.5.E (chat modes + per-tool approval) follow-ups — closed entries

*Origin: the section [Phase 2.5.E (chat modes + per-tool approval) follow-ups](deferred-tasks.md#phase-25e-chat-modes--per-tool-approval-follow-ups) of the active register.*

- [x] **`[c]` reject-with-typed-reason approval prompt — DONE (2.5-close Step 14, D-1; PR #69).** A `[c]` at the approval
  prompt opens a keyboard-owning reason-input sub-mode (both `relavium chat` + the Home); on submit it rejects with
  the sanitized + 300-char-bounded reason via the existing `ToolApprovalDecision.reject.reason` seam. The floor is
  unchanged. *(apps/cli/src/render/tui/chat-input.ts + chat-ink.tsx + home-controller.ts)*
- [x] **Conversationally recover from a SCOPE denial in chat — DONE (2.5-close Step 14, D-3; PR #69).** The `recoverable`
  flag moved to the base `ToolDispatchError`; exactly two `tool_denied`s opt in — `ToolPolicyError('media_scope_denied')`
  and the fs **pure scope-tier escape** (`FsScopeDeniedError` from `assertInScope`) — so on the `recoverToolFailures`
  surfaces the model is fed the denial and adapts to an in-bounds path. The confidentiality / protected-path / symlink
  / SSRF / user / guardrail denials stay FATAL. *(packages/core/src/tools/errors.ts; apps/cli/src/engine/tool-host/fs.ts; ADR-0057)*
- [x] **Plain / non-TTY non-interactive approval policy — DONE (2.5.E "High 9" + consolidated in 2.5-close Step 14,
  D-2; PR #69).** A non-interactive driver (plain non-TTY / `--json` / one-shot `agent run`) uses the one canonical
  `nonInteractiveApprovalPrompt` — every governed dispatch is DENIED (never a hang, never an auto-approve).
  *(apps/cli/src/chat/chat-mode.ts; apps/cli/src/commands/chat.ts + agent-run.ts)*
- [x] **Approval-consent-line zero-width hardening — closed in MVP-3 on development (2026-11-12).** The shared render
  floor strips the Trojan-Source REORDERING controls everywhere (the CVE-2021-42574 vector is closed), but the
  highest-trust surface — the approval consent line's target (`formatApprovalTarget` → `sanitizeInline`) — still
  passes NON-reordering zero-width chars (ZWSP U+200B / word-joiner U+2060 / BOM U+FEFF), which the provider-URL echo
  already strips. Running the stricter zero-width superset on the consent-line target would be defense-in-depth. Not
  a CVE gap (those chars cannot reorder a command to masquerade). **2026-11-06:** they can still hide content in an
  approved diff or argument (a tag-character run, a zero-width space in a literal); ADR-0120 (accepted 2026-11-11, implementation pending) makes the
  approval preview escape every default-ignorable and format code point, which covers this target when it lands.
  **Scheduled → 2.6.M** (with tool-render v2). **2026-11-11 preflight correction:** the
  earlier 2026-11-04 exclusion is superseded by ADR-0120's mandatory approval-preview
  escaping in MVP-3; see the [accepted plan](phases/phase-2.6-conversational-authoring.md#mvp-3-plan--editing-search-and-reviewable-effects-2026-11-11).
  Design acceptance is complete; implementation remains pending and this item is not closed by design approval.
  **Implementation closure 2026-11-12:** the mandatory ADR-0120 projection escapes
  default-ignorable/format and other hidden source code points in targets and
  review fields, with actual inspection/visibility guards on both hosts. The
  [Step 2 acceptance](phases/phase-2.6-conversational-authoring.md#mvp-3-step-2-acceptance-2026-11-12)
  records implementation tests and separate security sittings; earlier pending
  wording above is historical. Shared `[c]` extraction below remains separate.
  *(low · apps/cli/src/render/tui/chat-projection.ts)*
- [x] **`relavium budget resume` CLI command — accepted in W7 Step 11, 2026-10-04.**
  The maintainer deferred this security-sensitive cross-process surface on 2026-07-08 and moved it to
  W7 on 2026-09-18. It now shares the resume core in `commands/gate.ts`; the manifest and dispatch expose
  `relavium budget resume <runId> [--gate <gateId>] --approve-amount <microcents> | --abort` without a
  second command core. The amount must exactly match the recorded frozen allowance, and engine admission
  remains authoritative. See the [canonical command](../reference/cli/commands.md#relavium-budget-resume),
  [ADR-0097](../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md) and the
  [W7 execution plan](phases/phase-2.6.5-core-reliability-remediation.md#w7-pre-implementation-review-and-proposed-execution-plan--2026-10-02).
  [Step 11 round 3](https://github.com/HodeTech/Relavium/blob/f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a/docs/reviews/2026-10-04T01-17-23-w7-step-11-round-3-review.md) accepts the complete
  path after the two corrective rounds; this closes the moved command follow-up, not the W7 register.
  *(low · apps/cli/src/commands/gate.ts + manifest.ts + dispatch.ts; ADR-0028, ADR-0097)*
- [x] **`project`-tier invocation roots/selectors (carried from 2.5.A; accepted 2026-10-12).** Independently accepted in [Wave 2 Step 2](phases/phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12), including platform gates. Explicit invocation grants provide authority; strict project/workspace selectors only narrow it. Full Phase 2.6.M remains open.
- [x] **Exact host-issued scratch floor prerequisite (L605; accepted 2026-10-12).** Independently accepted in [Wave 2 Step 2](phases/phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12), including platform gates. This replaces the historical inert `tmpDir` prerequisite with a host-only exact private descriptor/factory, lexical/canonical containment, identity checks, POSIX private-directory checks and retained nested floors. Automatic global tmp provisioning is removed without deleting existing directories. Windows retains the owner-controlled profile/ACL assumption. Ordinary chat has no production allocator; production provisioning/isolation/join/cleanup/recovery remains 2.6.N.

### Phase-2 CLI (2.D) follow-ups — closed entries

*Origin: the section [Phase-2 CLI (2.D) follow-ups](deferred-tasks.md#phase-2-cli-2d-follow-ups) of the active register.*

- [x] **`relavium budget resume` workstream — single tracking point.** The former unnumbered Phase-2
  follow-up was moved to W7 on 2026-09-18 and is implemented under Step 11. Its acceptance state is tracked
  only in the Batch-E entry above; the [canonical command](../reference/cli/commands.md#relavium-budget-resume)
  describes the actual flags and frozen-allowance boundary. *(ADR-0028, ADR-0097)*
- [x] **Re-provide `secret`-typed inputs on cross-process resume — shared path accepted, 2026-10-04.**
  The 2026-07-08 deferral required stdin rather than argv and an independent security review. The ordinary
  human-gate path already implements ADR-0083 §6: `--secret-stdin` reads `name=value` lines, requires every
  masked slot and refuses unknown, missing or empty values without echoing secret values. Without the flag,
  a secret-bearing resume still fails closed with exit `2`. W7 Step 11 reuses that implementation for budget
  resume and verifies secret admission alongside frozen amount, ownership and MCP consent. Drained stdin
  disables a later interactive gate prompt. See the [canonical stdin contract](../reference/cli/commands.md#relavium-gate)
  and [ADR-0083](../decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md).
  [Step 11 round 3](https://github.com/HodeTech/Relavium/blob/f267bb0d4e9a4b4e2b51cb2c44ff744284d5228a/docs/reviews/2026-10-04T01-17-23-w7-step-11-round-3-review.md) accepts the complete shared
  path. The inherited secret-stdin interval before the connect/build signal guard remains qualified
  in the canonical command; this does not introduce a whole-stdin signal-handling promise.
  *(medium · apps/cli/src/commands/gate.ts; ADR-0006, ADR-0083)*

### 2.I read-command follow-ups (PR #48 multi-agent review, 2026-06-24) — closed entries

*Origin: the section [2.I read-command follow-ups (PR #48 multi-agent review, 2026-06-24)](deferred-tasks.md#2i-read-command-follow-ups-pr-48-multi-agent-review-2026-06-24) of the active register.*

- [x] **History-read query indexes — DONE (2.5.B, migration 0005).** The `(created_at DESC, id DESC) WHERE
  deleted_at IS NULL` partial index landed on **both** `runs` (`idx_runs_created`) and `agent_sessions`
  (`idx_agent_sessions_updated`), so `listRuns`/`listActiveRuns`/`listSessions` order off the index instead of a
  `USE TEMP B-TREE` filesort, and the 2.5.B Home reads bound to an indexed top-N (`{ limit }` on
  `listRuns`/`listSessions`). **Still open (cloud-scale only):** offset/cursor **pagination** for the read
  *commands* (`relavium list` / `loadLatestRunPerWorkflow` still return the full set) — genuinely unneeded at
  single-user CLI scale; add a cursor API before the desktop/cloud surfaces drive these reads at volume.
  *(low → scale · packages/db/src/run-history-store.ts; database-schema.md)*
- [x] **`AgentParseError` line/column — DONE (2.5-close Step 13, `fix(core)`; PR #69).** `agentSyntaxErrorFrom` (the
  agent sibling of parser.ts's `syntaxErrorFrom`) now threads `LineCounter` positions into a positioned
  `YAMLParseError`: optional 1-based `line`/`column` fields (parity with `WorkflowSyntaxError`) plus a folded
  `(source — line L, column C)` locator in the message so the position reaches every `.message`-surfacing
  consumer. The echoed YAML rule is secret-free (`prettyErrors: false`; verified across a 14-case + 12-case
  adversarial sweep — no authored key/value ever rides the message). *(packages/core/src/agent-parser.ts)*

### Phase 2.5.A (tool-environment factory) follow-ups — closed entries

*Origin: the section [Phase 2.5.A (tool-environment factory) follow-ups](deferred-tasks.md#phase-25a-tool-environment-factory-follow-ups) of the active register.*

- [x] **`egress` + `os` host arms wired (governed) — RESOLVED in 2.5.E.** *Landed in 2.5.E ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md), PR #63, merged 2026-07-03):* `apps/cli/src/engine/tool-host/egress.ts` (over the shared `connectValidated` connect-by-validated-IP mechanism, Host/`:authority`-header-strip) + `os.ts`, wired by the `chat-read-write` factory profile as **governed** classes on the fail-closed approval floor (denied in `ask`, prompt in `accept-edits`). *(apps/cli/src/engine/tool-host/; security-review.md)*
- [x] **Project-tier path-allowlist (`extraRoots`) — historical 2.5.A carry.** The invocation-grant/selector prerequisite is accepted in [Wave 2 Step 2](phases/phase-2.5.5-hardening-and-remediation.md#step-2-acceptance--2026-10-12) and the Phase 2.5.E entry above. This reconciles the duplicate pointer; full M/N workstreams and production child/scratch lifecycle remain open.
- [x] **Write-capable chat — RESOLVED in 2.5.E.** *Landed in 2.5.E ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md), PR #63, merged 2026-07-03):* the `relavium chat` default profile is now the full-capability `chat-read-write` host — `write_file` is wired and gated by the per-tool approval floor (denied in the default `ask` mode as `tool_denied`, not `tool_unavailable`); a declared `full` tier is still **clamped to `project`** for the chat surface (an unjailed read exfiltrates `~/.ssh` / `~/.aws`, a write-capable chat shares that risk). *(apps/cli/src/chat/session-host.ts; ADR-0057)*
- [x] **Profile-unaware advertise-filter — DONE (2.5-close Step 15, Batch E; PR #69).** `wiredToolIds` now takes a
  `{ readOnly }` option: on a read-only host a WRITE-class (`fsWrite`) tool is no longer advertised (its `fs` arm is
  wired but always denies the write — an always-denied advertisement), the advertise-side complement to the
  read-only fs arm's dispatch refusal. The default (read-write) is unchanged, so the live `chat-read-write` session
  host is inert. *(apps/cli/src/engine/tool-host/assemble.ts)*
- [x] **Two transitively-covered test gaps — DONE (2.5-close Step 11, Batch A; PR #69).** Both now have an
  explicit pin: the chat-session-dispatches-`git_status` e2e was ADDED this round (session-host.test.ts —
  "dispatches git_status through the process arm end-to-end", asserting the tool_result folded back with a clean
  `{"exitCode":0}`); the failed-turn **real**-token persister fold was CONFIRMED already explicitly pinned
  (persister.test.ts — "flushes the running cost on a failed turn so a resumed budget governor sees the true
  spend"). *(apps/cli/src/chat/session-host.test.ts + persister.test.ts; testing.md)*

### 2.6.F (full-screen renderer) — deferred by ADR-0067 / ADR-0068 (recorded 2026-07-09) — closed entries

*Origin: the section [2.6.F (full-screen renderer) — deferred by ADR-0067 / ADR-0068 (recorded 2026-07-09)](deferred-tasks.md#26f-full-screen-renderer--deferred-by-adr-0067--adr-0068-recorded-2026-07-09) of the active register.*

- [x] **Step 4b-2: harden `displayWidth` so it never UNDER-counts vs ink (grapheme-aware) — DONE (Step 4b-2).**
  `displayWidth` + `wrapLogicalLine` now segment with `Intl.Segmenter` (Node 22, ADR-0067) + measure per grapheme
  cluster: a VS16 `❤️` / enclosing keycap `1️⃣` counts 2 (was 1 — the dangerous under-count), a ZWJ family counts 2 (was
  4), a flag/skin-tone counts 2, and a cluster is never split mid-glyph — so the 1-DisplayLine-==-1-real-row invariant
  holds under the persisted-offset scroll. Pinned in viewport.test.ts.
- [x] **Step 4b-3: memoize the transcript wrap so an append/resize doesn't re-segment all of history — DONE (Step 4b-3).**
  `wrapTranscript` (`chat-projection.ts`) memoizes per ENTRY in a `WeakMap<TranscriptEntry, { cols, lines }>` keyed on
  the immutable, append-only entry object: an append is O(history) map lookups + ONE `wrapEntry` (the new entry), a
  resize replaces each entry's single cached wrap, and it NEVER thrashes (holds exactly the live entries, GC-reclaimable)
  — `viewport.ts` `wrapText` is pure again. (The first cut was a fixed-size per-line LRU; the Step-4b-3 Opus review
  showed it thrashed to a 0% hit rate once a session exceeded the cache size, so it was replaced.) Pinned in
  chat-projection.test.ts (incremental append + same-object-on-hit + a >8192-entry repeatability case).
- [x] **Step 4b-3: route mid-session raw-`io` notices through the CURRENT session's view store so they survive alt mode
  — DONE (Step-4b-3 Sonnet fold).** The budget-cap **`onBudgetWarning`** (fires mid-turn) and the `/clear`/reseat
  **MCP-skipped** diagnostic were writing via raw `io.writeErr` WHILE the hoisted alt buffer was entered, so ink's next
  frame overwrote them → LOST on the default full-screen path. Fixed with a file-private `liveSessionNotice` pointer
  that `driveOneSession` sets to the live session's `store.notice` for its lifetime (a REPL runs one session at a time)
  and clears in its finally: all four `onBudgetWarning` wiring sites now route through it (falling back to raw `io` only
  when no session is live), so the warning renders as a transcript notice. The re-drive MCP-skipped diagnostic (which
  fires between sessions, before the sink is live) routes to the fresh session's `store.notice` directly via the new
  `mcpSkippedLines` helper. Pinned by a live-routing test (break-verified) + the fallback test + a `mcpSkippedLines` unit test.
- [x] **Step 4b-3: keep the alt buffer entered across a `/clear` / `/models`-reseat re-drive (inter-session flicker) — DONE (Step 4b-3).**
  Fixed by the HOIST (chosen over DEC-2026, which cannot span a primary↔alt switch): `driveInk` now passes the ink
  render option `alternateScreen:false` (ink toggles the buffer no more — it still full-screen-renders via log-update),
  and the hoisted `runReplLoop` (`withHoistedAltScreen`) enters DECSET-1049 ONCE above the per-session loop, clears
  between re-drives, and exits ONCE, so a `/clear` / reseat no longer flips the terminal. Exit-safety net (ink's own
  1049-exit is now inert): idempotent `restore()` on the finally + a `process.on('exit')` net (the second-SIGINT force
  quit) + explicit SIGTERM/SIGHUP/SIGQUIT handlers. Verified against ink 7.1.0's compiled build; unit-tested
  (`withHoistedAltScreen`, 10 cases); real-TTY signal validation (double-Ctrl-C, `kill -TERM`) is a manual PR-time check.

### Full-project review (2026-07-19) — deliberately unscheduled findings — closed entries

*Origin: the section [Full-project review (2026-07-19) — deliberately unscheduled findings](deferred-tasks.md#full-project-review-2026-07-19--deliberately-unscheduled-findings) of the active register.*

- [x] **Agent memory policy (`memory: none|window|summary`) implemented in W7 (`CR-72`).**
  The shared projection consumes frozen authored memory before folding, including empty completed turns
  and restored summary exclusion. The same policy controls after-turn, pre-send and overflow recovery.
  Workflow nodes have no cross-turn session memory. See the
  [canonical memory contract](../reference/contracts/agent-session-spec.md#request-projection-and-history-operations)
  and [W7 closing review](phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10).
  This closes the old ownership/implementation follow-up; tool-history carrying remains CR-70.

### Wave 3 approved later-wave ownership — 2026-10-16 — closed entries

*Origin: the section [Wave 3 approved later-wave ownership — 2026-10-16](deferred-tasks.md#wave-3-approved-later-wave-ownership--2026-10-16) of the active register.*

- [x] **Closed on `main` — MVP-2 step 1: alt-screen word wrapping (#61).**
  Implemented and independently accepted at `b636be5f` (2026-11-10), with Unicode,
  tab, prefix-exhaustion, source-preservation and both-renderer regression evidence;
  see the [acceptance record](phases/phase-2.6-conversational-authoring.md#step-1-acceptance-2026-11-10).
  Merged 2026-11-11 through PR #98 (`0db4c940`); the
  [MVP-2 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-2-merge-checkpoint-2026-11-11)
  closes its combined verification and maintainer gate.
  **Historical scheduling:** the maintainer
  approved retaining character-wrap replacement with render-v2/D18 and picker
  positioning #60, so that renderer restructuring and the palette sweep occur
  once. Wave 3 still owns grapheme/tab/resize/cache/editor bounds; this disposition
  does not waive Phase 2.5.5.I's eventual word-wrap/full acceptance. The
  [approved execution plan](phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments)
  and [Wave 5a owner](current.md#wave-5a--paint-before-you-build) retain the split; close only
  after actual word-wrap implementation and regression evidence land.
  **Moved 2026-11-04 (D65):** into the CLI MVP's MVP-2 ([current.md](current.md#next-work--the-cli-mvp)); the Wave 5a
  ownership ends, and the close condition above stands.

### MVP-3b, MVP-3c, MVP-3d and the PR #99 reviews (2026-11-16 to 2026-11-18) — closed entries

*Origin: the section [MVP-3b, MVP-3c, MVP-3d and the PR #99 reviews (2026-11-16 to 2026-11-18)](deferred-tasks.md#mvp-3b-mvp-3c-mvp-3d-and-the-pr-99-reviews-2026-11-16-to-2026-11-18) of the active register.*

- [x] **DONE 2026-11-18 (merged in PR #99) — ADR-0119 — a failed, aborted or refused turn stays in the session (MVP-3c, ahead of MVP-4).**
  **Accepted 2026-11-16** after a twelve-finding design review (see the ADR's disposition table); **implemented on
  `development` the same day** (shared field and event, migration `0021`, turn-core history channel, `AgentSession`
  retention, persister, restored transcript, export, effect-journal disclosure); the author's chosen mutants are all killed (see the register's "Mutation evidence" — not an exhaustive sweep).
  **Rounds 1–3 with their separate security sittings, the gates (before the final fixes) and a two-provider real sample have run** (see the
  phase register; `smoke:cli-package` and `check:map-controls` are owned by the platform CI legs). **Closed:** round 4, four separate security sittings, the gates on the final source and the maintainer's merge of PR #99 on
  2026-11-18 (no fifth round was run on round 4's fixes; see the [MVP-3 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-3-merge-checkpoint-2026-11-18)); the follow-ups are the entries below *[Moved 2026-11-18: in the active register's [MVP-3b section](deferred-tasks.md#mvp-3b-mvp-3c-mvp-3d-and-the-pr-99-reviews-2026-11-16-to-2026-11-18)]*. Work list in the
  [phase register](phases/phase-2.6-conversational-authoring.md#mvp-3c--the-failed-turn-stays-and-mvp-3d--ask_user-2026-11-16).
  *(high · product · packages/core/src/engine/agent-session.ts, apps/cli/src/chat/persister.ts)*
- [x] **MVP-3b D64 round and separate security sitting (approval card, modes, denial text — ADR-0129/0130/0131).** Recorded as owed in ADR-0129 and
  ADR-0130, the phase register and `current.md`, but until the PR #99 independent review (2026-11-17) there was no entry here. **Decision (maintainer,
  2026-11-17): run one combined round and a separate security sitting over MVP-3b and that day's consent-path corrections** (a repository config layer can
  no longer choose `accept-edits`; the review card's target projection now reserves the verb prefix so a long path cannot hide its end behind an unlocked
  Allow; the "Allow stays locked" sentence only before inspection; `[n]` accepted while the card is not visible; `agent run` no longer offers governed
  tools). **Done 2026-11-17** — one four-reviewer D64 round (one high, three mediums, all fixed), a separate security sitting (one high, two mediums, one low) and two further
  sittings (a medium and two lows; a medium and three lows) ran; every finding is fixed, the lows and residuals are in the entries below *[Moved 2026-11-18: in the active register's [MVP-3b section](deferred-tasks.md#mvp-3b-mvp-3c-mvp-3d-and-the-pr-99-reviews-2026-11-16-to-2026-11-18)]*, and the 21-step gate passes on the final source
  (the [record](phases/phase-2.6-conversational-authoring.md#pr-99-independent-review-corrections-2026-11-17)). The last medium's fix (the Enter-confirmed `[a]`) was verified
  by the third sitting's own reproductions, not by a fourth sitting; the maintainer decides whether D64 needs one. The maintainer's acceptance is owed. *(high · process · apps/cli/src/render/tui, apps/cli/src/chat)*
  **Update 2026-11-18 (stale-entry sweep):** the maintainer merged PR #99 on 2026-11-18 (see the [MVP-3 merge checkpoint](phases/phase-2.6-conversational-authoring.md#mvp-3-merge-checkpoint-2026-11-18)); the checkpoint records MVP-3 as complete and merged, so the acceptance this entry lists as owed is no longer pending. The phase register still states that the last medium's fix was verified by the third sitting's own reproductions, not by a fourth sitting.
- [x] **DONE 2026-11-17 — the full gate and the required CI check were shortened without weakening a control (maintainer authorised the actions after the private analysis of 2026-11-17).** *(author, reviewed by an independent read-only reviewer)* (1) **`pnpm gate`** ([tools/ci/local-gate.mjs](../../tools/ci/local-gate.mjs)): the local gate in parallel. It reads the steps from the root `ci` script (no second list), runs the ordinary steps serially, the wire/usage/filesystem/secrets causal controls as parallel lanes cut into the same `--shard i/n` counts CI runs, then the enforced coverage run alone, adds the workspace tests under the CI environment (`CI=true GITHUB_ACTIONS=true`, `--concurrency=1 --force`), and fingerprints the working tree before and after. 24 tests; thirteen mutations of the runner were each killed by them. (2) **C1**: the required context `ci` (job id and name `lint · typecheck · test` unchanged) is now a thin `if: always()` aggregate; the 14.8-minute lint/typecheck/test/build/smoke work moved to a new job `ci-work` (`needs: native-fs-assets` only) that runs beside the long control jobs, and the aggregate asserts its result like the others. The pins moved with it: `tools/ci/workspace-scheduling.test.mjs` pins the join (15 mutation cases), every `ci-work` step (10 mutation cases; the old pins never covered a `continue-on-error`, a conditional or an echo on most of its steps, and the review found the aggregate's own `continue-on-error` unpinned after the split), `require-w8-acceptance`, `require-packed-cli` and `native-fs/delivery`. (3) **C2**: the secrets causal controls run in three shards instead of two (47/46/46 of 139 controls; a half took 41–52 minutes on CI and was the critical path), under every unchanged bound. *Evidence:* the prototype of the runner measured **44 minutes** twice (against 94); the Node runner's first full run passed every step except five mutation lanes that failed together at one minute with "missing completed report" — every causal phase has a 90-second deadline, and one-minute load had spiked machine-wide (the first coverage run on 2026-11-17 failed the same way at a load of 56, unexplained) — and the same five lanes passed when re-run alone through the same runner (17 minutes, peak load 18); so no single end-to-end green run of the Node runner exists, only the prototype's two and this pair. The runner now logs the load while the lanes run. The unit pins pass (1,180 acceptance-tool cases), `actionlint` is clean. **Not verified:** a real CI run of the split workflow (the first push is its test), GitHub's concurrent-job limit (the workflow now peaks at about 15 jobs per run, two runs per push), Windows (the runner stops only a step's own process there, not its process group). *Follow-up 2026-11-18 (after the push `2ca08aec`):* SonarCloud's gate on PR #99 failed on the new reliability rating (C) and the new security rating (B), both from this runner and nothing else. S3403 (`result.code === 0` in `runGate`, a bug): the TypeScript checker inferred the elements of the untyped `results` array as `code: undefined`, so the comparison looked always false although `code` is a number at run time; the array now carries a JSDoc type (`number | undefined`), checked with the compiler's own API. S4036 (a vulnerability): `treeFingerprint` ran a bare `git`, and pnpm puts every `node_modules/.bin` of the workspace first on the PATH of the scripts it runs, so a dependency could have installed a `git` there. `resolveGit` now takes the first `git` on the PATH that is not inside the repository (empty and relative entries and links into the repository are refused; no git outside it is an error, never a fallback). Two tests were added (1,182 acceptance-tool cases); seven mutations of `resolveGit` and its use are each killed. The eight S4036 findings accepted earlier on this PR were for fixed-argument calls in tools the maintainer reviewed; this one was fixed in source instead, so no disposition needs a token. *First real CI run of the split workflow (PR #99 head `bb6f1671`, 2026-11-18):* it worked as designed. The required `ci` aggregate ended 36.5 and 36.8 minutes after the downstream jobs started (the same point in four earlier runs, at `de0573b1` and `a15c8f8e`, took 63 to 68 minutes), the secrets shards took 27 and 33 minutes (41 to 52 as halves) and `ci-work` 14 and 18 beside them. It also moved the critical path: the required `coverage` job, 26 to 38 minutes before, now outlasts everything and hit its limit (see the next section *[Moved 2026-11-18: "PR #99 merge CI observations" in [deferred-tasks.md](deferred-tasks.md#pr-99-merge-ci-observations-2026-11-18)]*), and the downstream jobs started 34.5 and 38.5 minutes after the runs were created because the macOS arm64 native leg only started about 33 minutes in (a runner wait; the downstream jobs of those earlier runs started 2 to 4 minutes after the run was created). GitHub's concurrent-job limit is still not verified.

## Earlier file headers (verbatim)

The header paragraphs the register carried before the 2026-11-18 split, kept unchanged.

> Last updated: 2026-11-04 — the CLI MVP comes first (maintainer, 2026-10-26; decisions D58–D72 ruled 2026-11-04): Wave 3 is paused after Step 9b.2 and its Steps 9c–19 are pending, not declined; the order is in [current.md](current.md#next-work--the-cli-mvp). Wave 2 is merged in PR #94 and Wave 3 Steps 1–8 in PR #95; PR95, 9a.1, 9a.2a, 9a.2b, NI (its Windows clause closed on 2026-10-26), 9b.1 and 9b.2 are accepted with their recorded findings below and reached `main` with the `development`→`main` checkpoint (PR #96, merged 2026-11-04). The independent PR #95 review's findings keep the maintainer's 2026-10-19 owner rulings, and the masker's edge cases the 2026-10-21 bar and the 2026-10-22 rulings. Existing approved deferrals remain; entries the MVP pulls forward say so.
> The [merge checkpoint](phases/phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15) records completed prerequisites; full M/N lifecycle and other scheduled work remain with their owners.
>
> Earlier triage: the Phase-2.6 rewrite triaged every open item, the 2026-07-19 full-project
> review added the deliberately-unscheduled block at the end, Phase 2.6.5's `W1` and `W2` residual
> sections were appended as those waves closed, and the `W7` document review added three deferrals, re-owned
> the `memory` policy and the delegate fields, and moved `relavium budget resume` into `W7`.
>
> **Lifecycle states**, because this file mixes three: `- [ ]` = unscheduled and actionable ·
> **Scheduled → 2.6.X / → 2.5.5.X** = owned by that workstream, still unchecked until the PR that lands it ·
> **DONE / DECLINED** = closed history, written as a plain bullet, never a checkbox.
