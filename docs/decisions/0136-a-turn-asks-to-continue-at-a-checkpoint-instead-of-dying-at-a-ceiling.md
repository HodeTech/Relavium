# ADR-0136: A turn asks to continue at a checkpoint instead of dying at a ceiling

- **Status**: Accepted — 2026-11-19, by the maintainer, after the revision recorded in the Alternatives and two independent document reviews. Engine side implemented in MVP-4 step 1; the checkpoint card and the host's wiring of the hook are owed (step 2); the D64 rigor tier applies.
- **Date**: 2026-11-19
- **Decides**: [MVP-A11](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04) (configurable, finite ceilings with conservative defaults, [D67](../roadmap/current.md#wave-gating-decisions)), with the maintainer's decision of 2026-11-19 that a productive turn must not die at a fixed number of tool rounds.
- **Amends**: [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) (it builds the host-override seam its §9.3 promised, for the chat limits only; the authored-value ceilings are untouched), [ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md) (the correction budget becomes configurable and its off-by-one wording is corrected), [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md) §5's 2026-11-16 note ("at most 16 tool rounds … then the turn ends": on a surface with a person the bound is now this ADR's), and the agent-turn limits contract in [agent-runner.md](../reference/shared-core/agent-runner.md) (`AgentTurnLimits` gains one optional hook; where no host wires it the hard stop is unchanged).
- **Related**: [ADR-0028](0028-workflow-resource-governance.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)

## Context

A chat turn is a loop: the model asks for tools, the host runs them, the model is called
again. Three numbers bound it today, and only one of them is configurable.

| Limit | Meaning | Today |
|---|---|---|
| `maxToolTurns` | Tool rounds in one turn | 16, hard-coded |
| `maxToolCorrections` | Consecutive rounds in which no call ran to a result ([ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)) | 3, hard-coded |
| `[chat].max_turns` | Turns in one session | 50, configurable, no upper bound |

The first two are `DEFAULT_AGENT_TURN_LIMITS`, written in Phase 1 as the "run-default loop
bounds" of the workflow agent loop, and the chat host copies them
(`{ ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true }`). Neither was derived from what
an interactive coding turn needs.

**How the loop counts today.** A turn calls the provider, and when the model asks for tools
the host dispatches them at once; only then does the loop come back to its guard
(`toolTurn > maxToolTurns`). So at the limit the model's *last* tool calls **run**, and the
turn then fails with `turn_limit` before the model sees their results: a write can land in
a turn the person is told failed. A turn makes at most `maxToolTurns + 1` provider calls and
dispatches `maxToolTurns + 1` rounds.

**What the round ceiling protects.**

- **Spend with nobody watching.** The chat has no cost cap by default (`max_cost_microcents`
  is 0, unbounded). Read-only tools (`read_file`, `search_files`) need no card, even in
  `ask`. A model that loops, or one a prompt injection steers into a read loop, spends
  until the context fills or the person presses `Esc`. In `auto` and `accept-edits` the same
  holds for edits. On the unattended surfaces (a workflow agent node, a one-shot `agent run`,
  a plain or `--json` chat) there is no one to press `Esc`.
- **The budget governor's arithmetic.** When a budget pause is approved, the allowance is
  quoted as `calls × attempts × E` with `calls = maxToolTurns + 1`
  ([ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) §1). The pre-egress
  check stays armed for every call, so the quote is a conservative upper bound per pause.

**What it costs.**

- A turn that reaches the ceiling ends with `turn_limit`, mid-task. The next turn is told
  the structure of what ran, not what was read: a session remembers tool calls without their
  contents ([ADR-0095](0095-what-an-agent-session-remembers-across-turns.md),
  [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md); cross-turn tool
  memory is v0.2.1). "Continue" makes the model read the files again.
- 16 rounds is small for an interactive coding turn: a read, search, edit and test cycle over
  a handful of files passes it.
- Making the number configurable, as MVP-A11 first planned, only moves the cliff.

The protection is real and the failure mode is wrong: the ceiling is there so that nobody
pays unknowingly, not so that a productive turn is thrown away. A person who is at the
keyboard can be asked.

## Decision

**On a surface with a person, a turn that has run its interval of tool rounds pauses before
the next round and asks whether to continue; "continue" grants another interval. Nothing runs,
and nothing is spent, while the question is open. On a surface with no person the limit is a
hard stop with a conservative default, as today. An absolute constant stays above everything.
The limits are configurable within published bounds, a repository can only lower them, and a
value outside its bounds is rejected, never clamped.**

**A surface with a person** is a chat surface whose host wires the checkpoint hook: the
standalone chat and the Home's chat in the ink renderer, the same surfaces that wire the
approval and question cards (`canAsk`). A one-shot `agent run`, the plain and `--json` chat
drivers and workflow agent nodes are not, even though
[ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md)'s refusals return to the model on
`agent run` too: that ADR's "interactive surface" means a surface that corrects tool failures
(`recoverToolFailures`), this one means a surface that can be asked.

### 1. The limits, as configuration

| Key | Meaning | Default | Bounds |
|---|---|---|---|
| `checkpoint_tool_turns` | Tool rounds per interval **where a person can answer**: the turn pauses and asks | 32 | 1 to 256 |
| `max_tool_turns` | Tool rounds in a turn **where nobody can answer**: a hard stop with `turn_limit` | 16 | 1 to 256 |
| `max_tool_corrections` | Consecutive no-progress rounds the turn tolerates ([ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)) | 3 | 0 to 10 |
| `max_turns` | Turns per session (the existing key) | 50 | 1 to 1,000 |

- **Two keys for two meanings.** An earlier draft used one key as both the checkpoint
  interval and the hard stop, which silently doubled the headless default from 16 to 32. Two
  keys give each meaning one default.
- **Who may raise them.** The operator, in the global `[preferences]` table, which carries the
  same four keys. A repository layer (`[chat]` in a project or workspace file) may only
  **lower** a value: a value above the operator's (or, when none is set, above the default)
  is a strict-config error naming the file, the key, the value and the limit, never a clamp.
  This follows the rule [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
  and [config-spec.md](../reference/contracts/config-spec.md) already apply to the starting
  mode: a cloned repository can only tighten a person's protections, never loosen them, and
  a larger `checkpoint_tool_turns` is exactly a prompt removed. Setting a lower value is
  allowed and takes effect (more checkpoints, a shorter hard stop, a shorter session).
  `max_turns` is an existing repository-layer key; it gets the same rule and the upper bound
  it never had. No global `[chat]` table is introduced.
- **The bounds are published as data** in `@relavium/shared` (one object read by the config
  schema and by the engine's own check), so the loader, the session and the documentation
  cannot drift. The config schema uses `.int().min().max()`; that is deliberate, and
  different from [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) §7's
  choice not to put `.max()` on the public workflow schema, which these keys are not part of.
  A breach is a rejection, as ADR-0086 §1 says. The lower bounds only exclude nonsense (zero
  rounds); `max_tool_corrections` may be 0, which the engine already supports: the first
  round in which nothing ran ends the turn.
- **No transition.** The product has no deployed users (maintainer, 2026-11-19): a
  `max_turns` above 1,000 is rejected from the day this lands, with a message naming the key,
  the value and the bound.
- `max_tool_corrections` ends the turn in the round that would be the *(N+1)*th consecutive
  no-progress round: with 3, a model gets three corrections and the fourth consecutive
  failing round ends the turn ([ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)
  and the troubleshooting runbook said "the third", off by one; the code was right). It is
  independent of the checkpoint: a "continue" does not reset it, because a checkpoint can
  fall in the middle of a failing streak and the streak is still the same streak.
- The workflow agent loop and a one-shot `agent run` keep `DEFAULT_AGENT_TURN_LIMITS`
  (16 and 3): they are not chat sessions, and nothing here reads `[chat]` for them.

### 2. The checkpoint

**Where it sits.** The engine decides at the moment the model has asked for another tool
round and `allowed` rounds have already been dispatched, **before that round runs**. The
rounds the model asked for are held, not discarded.

- `allowed` starts at `checkpoint_tool_turns` on a surface with a person and at
  `max_tool_turns` elsewhere.
- **Where nobody can answer** (no hook): the turn ends with `turn_limit`, and the held round
  does not run. This fixes the behaviour described in Context: the limit now stops the turn
  *before* the effects of a round the model will never see the result of, and a turn makes at
  most `allowed + 1` provider calls and dispatches at most `allowed` rounds. The workflow
  agent loop shares the engine, so it gets the same correction, in the safe direction (fewer
  effects, never more).
- **Where a person can answer**: the engine calls an optional host hook,
  `AgentTurnLimits.onToolRoundLimit`, `(info, signal) => Promise<'continue' | 'stop'>`, with
  `info` carrying the rounds dispatched so far and the interval.
  - **`continue`** runs the held round and raises `allowed` by one more interval, never past
    the absolute constant of §3.
  - **`stop`** ends the turn with `turn_limit`, the held round not run
    ([ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md) retains it as an
    interrupted turn).
  - **An abort while the hook is open** (the session is being ended, a second `Ctrl+C`, a
    signal) takes the usual cancellation path, as at any other wait. `Esc`, `Ctrl+N` and the
    first `Ctrl+C` are **answers**, not aborts: each resolves the hook with `stop`
    ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §1), so the turn ends
    the same way whichever of them the person pressed.
- **Nothing happens while it is open.** The hook is called between provider calls, with no
  call, lease or admission held, so an unanswered checkpoint is a stopped spend: a person who
  walked away comes back to a paused turn, not a bill. There is no timeout. The turn's elapsed
  time excludes the wait, as it does at an approval card
  ([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) §6).
- **`continue` gives rounds, not money.** A configured cost cap still governs every provider
  call, a pause for budget still follows ADR-0097 and CR-95's refusal once tools have run,
  and a turn that "continues" into a cost cap ends with `budget_exceeded`, not with a
  checkpoint stop. A checkpoint is not a budget decision.
- **No new event and no history field.** The host owns the question and its answer; the
  `agent:*` stream and the schema do not change.
- **What each surface says.** The chat's failure line and its hint
  (`chat-projection.ts`) say the person stopped at a checkpoint when the host recorded a
  "stop" answer, and keep the general "reached a limit on tool use" wording for a hard stop.
  That distinction lives only in the live view: the stored interruption (and so a resumed
  transcript, and what the model reads on the next turn) says the general
  `turn_limit` sentence either way, because no history field is added.

### 3. The absolute backstop

The engine keeps one constant, `ABSOLUTE_TOOL_ROUNDS = 256`, in `limits.ts` beside the
ADR-0086 ceilings. No answer can pass it: when 256 rounds have been dispatched and the model
asks for the 257th, the turn ends with `turn_limit` at once, even where a person could
answer. One turn therefore makes at most 257 provider calls and dispatches at most 256 rounds
of at most 16 calls, 4,096 tool calls, however the person answers and whatever any config
says. A `checkpoint_tool_turns` of 256 has no checkpoint, only the backstop. The constant is
not configurable: it is the number that makes "finite" true.

### 4. The card

The checkpoint is a small docked card, a sibling of the approval card
([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)):

- a rule labelled `Checkpoint`, then one fact line (`This turn has used 32 tool rounds in
  3m12s. Continue for 32 more?`) and the keys: **`Ctrl+Y` continue**, **`Ctrl+N` stop here**,
  and `Esc` and `Ctrl+C` stop ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md));
- `Ctrl+Y` is an affirmative answer (it spends), so it passes the same input guards as an
  approval's (the dwell, the quiet gap, the typeahead window, the lockout), and a bare letter
  answers nothing; `Ctrl+N`, `Esc` and `Ctrl+C` are never delayed;
- it carries only host-authored fixed text and two numbers, so it is not a terminal sink for
  untrusted content;
- it owns the keyboard as the approval card does, in the standalone chat and in the Home's
  chat alike, and it is in the busy line's `Waiting for your answer` family.

### 5. What does not change

- `maxToolCorrections`' consecutive-rounds meaning and `recoverToolFailures`.
- The 16-calls-per-response and the other ADR-0086 admission ceilings.
- The budget governor: a configured cost cap still governs every provider call, and the
  `maxToolTurns + 1` in the allowance quote stays a conservative per-pause bound.
- The plain and `--json` chat drivers, `agent run` and workflow nodes: a hard stop, with no
  card to show.

### Alternatives considered

- **Keep a hard ceiling and make it configurable** (MVP-A11 as first planned, defaults 16 and
  3, caps 64 and 10). Rejected by the maintainer on 2026-11-19: it moves the cliff and keeps
  the behaviour that throws away a productive turn.
- **A higher hard default** (64, up to 256), no card. Rejected: smaller, but the turn still
  dies at the number and the model still forgets what it read.
- **No ceiling on the interactive surface.** Rejected. The chat has no default cost cap and
  read-only tools need no card, so nothing but the person's `Esc` would stop a loop, and the
  person may not be there.
- **One key for both meanings.** Rejected after review: it doubled the unattended default.
- **A repository may raise the limits within the bounds.** Rejected after review: a larger
  checkpoint interval is a prompt a clone removes, and the starting-mode rule already says a
  clone may only tighten.
- **Ask on every round.** Rejected: a card per round is the prompt fatigue the project's
  other cards work to avoid.
- **A progress-aware limit** (extend while rounds make new progress). Rejected: "progress"
  cannot be told from a model that keeps reading, and a heuristic that grants more spend
  without a person is the failure this ADR removes.
- **A timeout on the checkpoint that continues or stops by itself.** Rejected. An unanswered
  question is the safe state; a timer would turn it into one of the two outcomes without the
  person.

## Consequences

### Positive

- A productive turn is never thrown away: it asks, and the person decides with the rounds and
  the time in front of them.
- A walked-away turn stops spending at the checkpoint instead of at a number nobody chose.
- The limit no longer lets the last round's effects land in a turn reported as failed.
- The limits are visible, documented and bounded, and `max_turns` gains the upper bound it
  never had.
- The unattended surfaces keep their hard, conservative stop at the same default (16).

### Negative

- The engine gains a pause point and the host a new keyboard-owning card. Both are
  consent-adjacent (a continue spends), so the increment carries the approval-path rigor
  and a security sitting.
- A turn on a surface with a person can now run to 257 provider calls, up from 17, if the
  person keeps answering "continue". `max_turns` does not bound that (it counts turns, not
  rounds); the backstop, the budget governor and the person's own answer do.
- The operator who wants a larger interval or session cap edits the global config by hand:
  there is no writer for these keys and no global `[chat]` table.
- The engine's turn loop changes where its guard sits, so tests that pinned "a turn makes
  `maxToolTurns + 1` rounds" are rewritten to pin the new count.

### Landing obligations

- [config-spec.md](../reference/contracts/config-spec.md): the four keys under `[chat]` and
  `[preferences]`, the bounds, the lower-only rule and its strict-config error, and the
  `max_turns` upper bound.
- [agent-session-spec.md](../reference/contracts/agent-session-spec.md): the hard-turn-cap
  section and the within-turn limits (the three-way distinction between `max_turns`, the
  round limit and the correction budget; the checkpoint; the absolute constant).
  [agent-runner.md](../reference/shared-core/agent-runner.md): `AgentTurnLimits.onToolRoundLimit`
  and the guard's new position. [built-in-tools.md](../reference/shared-core/built-in-tools.md):
  the "16 tool rounds" sentence in the `ask_user` section.
  [chat-session.md](../reference/cli/chat-session.md): the checkpoint card and the `turn_limit`
  hint.
- Dated amendment notes on [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md),
  [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) (the quote is a
  per-pause bound), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) (the ceilings
  are configurable) and [ADR-0132](0132-the-model-can-ask-the-user-a-structured-question.md)
  §5; the troubleshooting runbook's "three consecutive rounds" sentence is corrected already.
- The phase document's MVP-A11 row and the MVP-4 entry of [current.md](../roadmap/current.md).

### Implementation note — 2026-11-19 (MVP-4 step 1)

The engine side is implemented; the card and the host wiring of the hook are step 2. Details the decision leaves open:

- The engine does not trust the hook. It is raced against the turn's abort, so a host that never settles it cannot hang the turn and an abort wins over any answer; a rejection or a throw is a classified `turn_limit` stop; and only the literal `'continue'` continues, so `undefined` from a buggy host is a stop.
- `info.interval` is what a "continue" will actually grant: the interval, or what is left of the 256-round backstop at the last checkpoint.
- A held response the dispatch would refuse anyway (no call, or more than the per-response ceiling) is not asked about; the dispatch's own refusal ends the turn.
- A non-numeric or negative limit fails closed (a NaN stops the turn before any round), so the backstop holds for a direct caller that bypasses session admission.
- The resolver names the **layer** in its error, not the file, because it sees parsed configs; §1's "names the file" is read that way.
- A one-shot `agent run` keeps the engine's tool-round and correction bounds in the host (`session-host.ts`), because it builds its session through the same host as a chat; `max_turns` is still passed, which is moot for a single turn.
- A recoverable denial that is not a user decision now also carries its fixed text on the live tool row's completed event, so `/details` can say why a row is denied: the fs scope-tier escape, `media_scope_denied` and the lexical protected-path refusal. A user rejection, a mode refusal, the *unavailable* refusal and a repeat (all `ToolDeniedByUserError`) carry none, and neither does a recoverable host failure that is not a denial.
