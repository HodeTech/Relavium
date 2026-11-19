# ADR-0136: A turn asks to continue at a checkpoint instead of dying at a ceiling

- **Status**: Proposed — 2026-11-19. Awaiting the maintainer's acceptance.
- **Date**: 2026-11-19
- **Decides**: [MVP-A11](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04) (configurable, finite ceilings with conservative defaults, [D67](../roadmap/current.md#wave-gating-decisions)), with the maintainer's decision of 2026-11-19 that a productive turn must not die at a fixed number of tool rounds.
- **Amends**: [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) (it builds the host-override seam its §9.3 promised, for the three chat limits only; the authored-value ceilings are untouched), [ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md) (the correction budget becomes configurable, and its "ends the turn on the third consecutive round" wording is corrected to the code's fourth), and the `maxToolTurns` rule of the agent-turn limits contract in [agent-runner.md](../reference/shared-core/agent-runner.md) (the limit is a checkpoint where a person can answer).
- **Related**: [ADR-0028](0028-workflow-resource-governance.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md), [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md), [ADR-0128](0128-content-free-tool-receipts-ground-later-chat-turns.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)

## Context

A chat turn is a loop: the model asks for tools, the host runs them, the model is called
again. Three numbers bound it today, and only one of them is configurable.

| Limit | Meaning | Today |
|---|---|---|
| `maxToolTurns` | Tool rounds in one turn (a turn makes at most `maxToolTurns + 1` provider calls) | 16, hard-coded |
| `maxToolCorrections` | Consecutive rounds in which no call ran to a result ([ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)) | 3, hard-coded |
| `[chat].max_turns` | Turns in one session | 50, configurable, no upper bound |

The first two are `DEFAULT_AGENT_TURN_LIMITS`, written in Phase 1 as the "run-default loop
bounds" of the workflow agent loop, and the chat host copies them
(`{ ...DEFAULT_AGENT_TURN_LIMITS, recoverToolFailures: true }`). Neither was derived from what
an interactive coding turn needs.

**What the round ceiling protects.**

- **Spend with nobody watching.** The chat has no cost cap by default (`max_cost_microcents`
  is 0, unbounded). Read-only tools (`read_file`, `search_files`) need no card, even in
  `ask`. A model that loops, or one a prompt injection steers into a read loop, spends
  until the context fills or the person presses `Esc`. In `auto` and `accept-edits` the same
  holds for edits. On the unattended surfaces (a workflow agent node, a one-shot `agent run`,
  a plain or `--json` chat) there is no one to press `Esc`.
- **The budget governor's arithmetic.** When a budget pause is approved, the allowance is
  quoted as `calls × attempts × E` with `calls = maxToolTurns + 1`
  ([ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) §1).

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

**On a surface with a person, reaching the round limit pauses the turn and asks whether to
continue; "continue" grants another full interval. Nothing runs, and nothing is spent, while
the question is open. On a surface with no person the limit is a hard stop, as today. An
absolute constant stays above everything. All three limits are configurable within published
bounds, and a value outside its bounds is rejected, never clamped.**

### 1. The three limits, as configuration

| Key | Meaning | Default | Bounds |
|---|---|---|---|
| `[chat].max_tool_turns` | Tool rounds per **interval**: the checkpoint on a surface with a person, the hard stop on one without | 32 | 4 to 256 |
| `[chat].max_tool_corrections` | Consecutive no-progress rounds the turn tolerates ([ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)) | 3 | 1 to 10 |
| `[chat].max_turns` | Turns per session | 50 | 1 to 1,000 |

- The bounds are published as data in `@relavium/shared` (one object, the schema's `.int()`,
  `.min()` and `.max()` and the engine's own check read it), so the config loader, the
  session and the documentation cannot drift. The same pattern is
  [ADR-0086](0086-absolute-admission-ceilings-on-authored-values.md) §1's "a breach is a
  rejection, never a clamp": the config error names the key, the value and the bounds, and
  `max_turns` finally has an upper bound.
- The keys resolve per field, last writer wins (project over workspace), like the other
  `[chat]` keys. A repository can therefore choose any value within the bounds for a clone;
  the worst a clone can do is the absolute constant of §3, and the budget governor and the
  person's checkpoint answer still apply.
- `max_tool_corrections` ends the turn in the round that would be the *(N+1)*th consecutive
  no-progress round: with 3, a model gets three corrections and the fourth consecutive
  failing round ends the turn. [ADR-0131](0131-a-round-that-made-progress-resets-the-correction-budget.md)
  and the troubleshooting runbook said "the third", which was off by one; the code was right.
- The workflow agent loop and a one-shot `agent run` keep `DEFAULT_AGENT_TURN_LIMITS`
  (16 and 3): they are not chat sessions, and nothing here reads `[chat]` for them.

### 2. The checkpoint

When a turn has completed `max_tool_turns` tool rounds and the model asks for another, the
engine calls an optional host hook before the next provider call.

- **The hook** is `AgentTurnLimits.onToolRoundLimit`, `(info, signal) => Promise<'continue' |
  'stop'>`, with `info` carrying the rounds so far and the interval. It receives the turn's
  abort signal; an abort while it is open is the usual cancellation path, not an answer.
- **`continue`** raises the allowed rounds by one more interval and the turn proceeds. The
  pre-egress budget check stays armed for every call, as it is for every call of every turn.
- **`stop`**, or a surface with no hook, ends the turn with the existing `turn_limit`
  ([ADR-0119](0119-an-interrupted-turn-stays-as-a-content-free-marker.md) retains it as an
  interrupted turn). The chat's footer says the person stopped at a checkpoint when that is
  what happened, and says the plain "reached a limit on tool use" when it was a hard stop.
- **Nothing happens while it is open.** The hook is called between rounds, with no provider
  call, no lease and no admission held, so an unanswered checkpoint is a stopped spend: a
  person who walked away comes back to a paused turn, not a bill. There is no timeout. The
  turn's elapsed time excludes the wait, as it does at an approval card
  ([ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) §6).
- **No new event and no history field.** The host owns the question and its answer; the
  `agent:*` stream and the schema do not change.

### 3. The absolute backstop

The engine keeps one constant, `ABSOLUTE_TOOL_ROUNDS = 256`, in `limits.ts` beside the
ADR-0086 ceilings. No answer can pass it: at round 256 the turn ends with `turn_limit` even
at a checkpoint, so one turn makes at most 257 provider calls and at most 4,096 tool calls
(16 per response) however the person answers and whatever a repository's config says. A
`max_tool_turns` of 256 therefore has no checkpoint, only the backstop. The constant is not
configurable: it is the number that makes "finite" true.

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
  chat alike, and it is one in the busy line's `Waiting for your answer` family.

### 5. What does not change

- `maxToolCorrections`' consecutive-rounds meaning and `recoverToolFailures`.
- The 16-calls-per-response and the other ADR-0086 admission ceilings.
- The budget governor: a configured cost cap still governs every provider call, and the
  `maxToolTurns + 1` in the allowance quote now means "per interval", which is what a pause
  can approve at once.
- The plain and `--json` chat drivers, `agent run` and workflow nodes: a hard stop at their
  limit, with no card to show.

### Alternatives considered

- **Keep a hard ceiling and make it configurable** (MVP-A11 as first planned, defaults 16 and
  3, caps 64 and 10). Rejected by the maintainer on 2026-11-19: it moves the cliff and keeps
  the behaviour that throws away a productive turn.
- **A higher hard default** (64, up to 256), no card. Rejected: smaller, but the turn still
  dies at the number and the model still forgets what it read.
- **No ceiling on the interactive surface.** Rejected. The chat has no default cost cap and
  read-only tools need no card, so nothing but the person's `Esc` would stop a loop, and the
  person may not be there.
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
- The three limits are visible, documented and bounded, and `max_turns` gains the upper bound
  it never had.
- The unattended surfaces keep their hard, conservative stop.

### Negative

- The engine gains a pause point and the host a new keyboard-owning card. Both are
  consent-adjacent (a continue spends), so the increment carries the approval-path rigor
  and a security sitting.
- A clone's config can raise `max_tool_turns` to 256, so a person who answers "continue"
  repeatedly spends more on a hostile repository than the default would allow. The backstop,
  the budget governor and the person's own answer bound it.
- A turn on a surface with a person can now run to 257 provider calls, up from 17.
- Two meanings of one key (checkpoint with a person, hard stop without) have to be
  documented once and in one place.
