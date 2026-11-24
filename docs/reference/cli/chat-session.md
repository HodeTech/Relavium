# `relavium chat` — Agent Session REPL

> Last updated: 2026-11-21

- **Status**: Reference — the whole chat family is live: the interactive REPL + `--agent`, `/exit`/`/cancel`, exit code 4, durable persistence (**2.M**); `chat-resume` (**2.N**); `chat-list` (**2.O**); `chat-export` + the in-REPL `/export` (**2.P**); `chat --json` + `agent run` (+ `--fixture`) (**2.Q**); the chat modes + fail-closed per-tool approval (**2.5.E**); and the mid-chat **`/models` reseat** + per-message `modelId` attribution + the `/effort` control (**2.5.G**) — this page is the reseat's behaviour home
- **Surface**: CLI (`relavium chat`)
- **Scope**: Phase 1 design, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [commands.md](commands.md), [home.md](home.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0026-session-export-to-workflow.md](../../decisions/0026-session-export-to-workflow.md), [../../decisions/0057-cli-chat-modes-and-per-tool-approval.md](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md), [../../decisions/0059-cli-mid-session-model-reseat.md](../../decisions/0059-cli-mid-session-model-reseat.md), [../../decisions/0063-cli-config-write-contract.md](../../decisions/0063-cli-config-write-contract.md), [../../decisions/0064-live-model-catalog.md](../../decisions/0064-live-model-catalog.md), [../../decisions/0066-normalized-reasoning-effort-control.md](../../decisions/0066-normalized-reasoning-effort-control.md)

`relavium chat` is the CLI's **agent-first entry point** — a multi-turn conversational REPL with a single agent, sitting beside `relavium run` on the **same** engine. Both are entry points into `@relavium/core`: `run` drives a workflow DAG, `chat` drives an [agent session](../contracts/agent-session-spec.md), and they reuse the same `ToolRegistry`, the `@relavium/llm` seam, and the event bus (see [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). This document is the command-surface reference for the chat REPL; it **cites** the session contract rather than restating it.

Interactive assistant answers use the [Markdown display pipeline](markdown-rendering.md)
in both renderers. User echoes, notices, reasoning and tool rows stay plain and
sanitized. Color-disabled output retains Markdown source markers. Tabs expand to
eight-cell stops and prose wraps at word boundaries with whole-grapheme fallback.
Tool rows show `…` while pending, `✓` for a successful result and `✗` for a failed
result. This changes only the in-flight mark; persistent tool-row presentation
and interrupted-turn storage remain with their later MVP slices.

## Entry

```bash
# start a session with the default chat agent/model
relavium chat

# bind a specific agent for the whole conversation
relavium chat --agent ./agents/coder.agent.yaml
relavium chat --agent code-reviewer            # resolved inside .relavium/
```

`relavium chat` opens an `ink`-rendered interactive REPL when a TTY is attached. The session is **auto-persisted and resumable** from the moment it starts — there is no separate save step (see [agent-session-spec.md](../contracts/agent-session-spec.md#validation-and-persistence)). Resume a prior conversation with `relavium chat-resume <sessionId>` and list past sessions with `relavium chat-list` (see [commands.md](commands.md)).

Preliminary credential setup uses the same [native provider setup](home.md#first-run-onboarding-wizard-25g-s8)
as Home, including the actual adapter's safe destination origin before asking for
a key. Restart chat after changing a provider endpoint in another process; its
existing resolver and displayed recipient stay pinned together.

On resume or `/models` reseat, including Home reseat, a notice lists unresolved external effects and effects
that landed in a turn that did not persist, or in a retained interrupted turn (persisted but not completed); legacy rows with no durable attribution are reported conservatively.
Completed model turns and committed `!` commands are silent. Earlier effects are **never auto-retried**: check
the target before sending the message again. TTY/Home notices appear in the active transcript; plain/JSON modes
use stderr. A failed disclosure preserves the audit evidence for a later resume. The exact retention and
privacy guarantees live in [effect-journal.md §8–§11](../shared-core/effect-journal.md#8-needs_attention).

Since Step 4b-3 the REPL **defaults on a TTY to the full-screen alternate-screen** mode, with **inline** as the opt-out — **`--no-alt-screen`** (one invocation) or **`[preferences].alt_screen = false`** (durable) ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e; the resolution is shared verbatim with the [Home](home.md)). A non-TTY / `--json` path is always inline (byte-identical). The alt screen renders the transcript through a resize-tracked **viewport** with **scroll-back + auto-follow** — **PgUp/PgDn** page, **Ctrl+Home/Ctrl+End** jump to top/tail, an upward scroll pauses the tail-follow and reaching the bottom resumes it (gated behind any keyboard-owning overlay); a `/clear` or `/models` swap holds the alt buffer across sessions, so it no longer flickers (Step 4b-3). Mouse reporting captures click-drag, so the alt screen runs **its own selection** (ADR-0068 §e, Step 6): drag to select, release to copy over **OSC 52**; the highlight shows exactly what is copied, a brief **`Sent to terminal clipboard` toast** above the footer confirms the copy was emitted (OSC 52 has no acknowledgement — see [accessibility.md](accessibility.md)), dragging at the viewport's top or bottom row auto-scrolls to extend it, a plain click clears it, `Esc` dismisses it while idle, and `[preferences].copy_on_select = false` keeps the highlight without touching the clipboard. Because the alt buffer also has no scrollback, three **copy-and-search hatches** (Step 5d, Step 6e) give the transcript back to the tools you already have: **`/scrollback`** dumps it into the terminal's native scrollback (scroll, search, select, copy — then press Enter to return), **`/edit`** opens it read-only in `$EDITOR` (edits are never read back), and **`/copy`** sends the whole unwrapped transcript to the system clipboard. The first two suspend the renderer and restore every terminal mode on exit; `/copy` suspends nothing. None is available before the first turn. The full-screen mode is inherently inaccessible to screen readers; [accessibility.md](accessibility.md) documents the trade-off + the inline-renderer escape hatch.

A chat also starts from the bare-invocation **Home** (2.5.B): typing a message at a bare `relavium` on a TTY graduates the Home into a chat in the **same** process — bound to the built-in default chat agent (the zero-config first run) — and returns to a freshly-read Home when the chat ends (the chat's exit code `4` is consumed by the Home loop, never leaked). The in-Home chat is the same REPL described here; see [home.md](home.md) for the Home shell, its TTY gate, and the signal/exit-code lifecycle.

## Proposed restored transcript display — MVP-2

**Implemented and independently accepted on development — 2026-11-10.** The maintainer approved
[ADR-0123](../../decisions/0123-restored-transcripts-use-host-recorded-display-text.md)
and the [MVP-2 execution plan](../../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-preflight-and-execution-proposal--2026-11-09).
This section qualifies the earlier MVP-2 plan's literal display/model equality,
divider and permanent-store-ceiling wording. The historical heading remains for
stable inbound links. The complete implementation passed cumulative round 4 and
the separate resume security sitting at `cecb6191`; see the
[acceptance and checkpoint gates](../../roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10).

### Sources and selection

Repaint the archive's historical user prompts and final assistant answers through
the existing shared structural history rules with the drop boundary ignored:
`completedSessionTurns(messages, false)` supplies complete exchanges. Include
compatible legacy prefixes and the shared projection's trailing legacy context
even when no later completed exchange exists; expose/reuse that projection support
instead of copying its state machine into the UI. Omit tool-call preambles, tool rows,
reasoning and crash remnants (a user message with structural rows and no terminal row); a retained interrupted turn is
shown, as described below. An explicit empty assistant final remains
an empty answer entry and counts toward the restore budget; it has no invented
usage or stop-reason line. Preserve legacy bare-user prefix/trailing-context
identities wherever the existing reconstruction preserves them, without counting
them as additional completed turns. A final unanswered user still rolls back.

Model reconstruction is a different projection: `resumableSessionMessages`
honors the maximum drop boundary and removes empty assistant terminal text, but
keeps its user and completed-turn identity. Before the UI cap, selecting retained
whole exchanges and compatible legacy entries with the boundary-aware shared
projection, then omitting those empty assistant entries, must reproduce
reconstructed message identities/order. Never filter archive rows independently
at the boundary and leave an orphaned terminal. Include compatible
legacy context. Test this against actual `reconstructSessionState`; then test
the authored `none`/`window` request projection separately, before and after
adjacent-same-role folding. Neither archive selection nor visible strings are
required to equal the model's final request.

For every selected user entry, look up the host-recorded
[display metadata](../shared-core/database-schema.md#proposed-user-display-storage--mvp-2).
Display that sanitized text when present, including a recorded empty string.
Otherwise display `Earlier user message — compact display was not recorded.`
Explain once when this occurs: original user text remains in history and may
still enter model context; the screen does not reconstruct its earlier compact
form. Do not infer attachment presence or safe display from string syntax.
Assistant answers use sanitized stored final text and the markdown rendering
policy; restored answers carry no per-turn usage line.

The cap is 500 entries in full-screen and 200 inline, counting source entries,
legacy placeholders and restore notices/dividers. Form an ordered list of display
units: each completed exchange's user and terminal assistant entries are one
indivisible unit; each compatible legacy bare-user entry is a separate one-entry
unit. An arbitrarily long legacy prefix is not one indivisible group that can
prevent the latest complete exchange from appearing.

Choose the longest chronological suffix of whole units that fits after reserving
its actual restore notices/dividers. Compute required notice rows before admitting
the next older unit; never cut an exchange to fill the final slot. The first
restore notice reports the number of source entries omitted, counting each user
and assistant entry, including empty finals and legacy placeholders, but excluding
synthetic notices and tool rows. It says those entries remain in history and the
display cap does not change model context. With no omitted entries it reports
restoration without an elision claim. There is one initial restore notice in
either case, so changing the count never changes the reserved notice count.

This bounds the initial restored prefix only. Subsequent live entries append
under current behavior. A full-screen reseat carries its current view without
reapplying this cap; an inline reseat does not reprint earlier static entries.
Clear starts empty. A new process or explicit switch to another session constructs
a new bounded prefix. Wrap/layout caches are scoped to entries retained by that
view, not falsely described as a permanent 500/200-entry total ceiling. These are
entry-count limits, not byte limits or permission to silently clip a source entry.

### Saved-context dividers

Derive boundaries from the same ordered marker rows as actual reconstruction:
the maximum drop boundary is independent of the newest nonempty summary. Insert
a divider only before a nonempty displayed region, and reserve its entry first:

- **Archived history at/before the newest summary-producing boundary:** say
  `Archived history — compaction produced a saved summary.` Explain that a
  summary is lossy and need not include details or previously trimmed messages;
  never assert that every earlier visible message is represented in it.
- **History after that boundary but at/before a later trim boundary:** say
  `Later history removed by /trim — outside retained conversation text.` A prior
  saved summary may still survive; never claim trim erased it.
- **History past the maximum drop boundary:** say
  `Retained conversation text begins here.` With no markers this is the only
  region; archived text remains visible when it fits the display budget.

If no summary exists, entries at/before a trim boundary use
`Archived history removed by /trim.` If no retained entries are visible, report
that fact in a restore notice rather than placing a divider before nonexistent
text. Do not display a stored summary as an authored system instruction.

The region labels describe durable restoration, not the next model request.
Add a policy notice for `memory: none` (earlier conversation is excluded) or
`memory: window` (only its most recent permitted turns — an interrupted turn takes one slot — are selected;
earlier summaries are excluded). Under other policies a retained summary may
also enter the request as untrusted user context. The
[memory contract](../contracts/agent-yaml-spec.md#conversational-memory) remains
authoritative. Test plain restore, compact, trim, compact→trim, earlier trim→compact,
each memory policy, empty finals and long legacy prefixes against actual
`reconstructSessionState` plus the request projection; UI string equality alone
cannot prove that relationship.

### Failure, hatches and activation

A display lookup/validation fault refuses interactive restoration before host
activation, using a fixed safe diagnostic and retry/return action. Never replace
missing/unreadable metadata with canonical user content. Machine resume does not
read display metadata and keeps its existing behavior.

`/copy`, `/edit` and `/scrollback` use this same safe restored user representation
and assistant markdown source. They do not load older omitted entries or expanded
attachments behind the user's visible view. A hatch explains the same initial
elision instead of claiming to contain the complete archive. Input history is not
seeded from canonical restored messages. Selection, copy and the empty/failed
states work in both renderers with color off.

Plain and JSON session drivers explicitly supply their captured input line as
display text at submission (`processLine(line, line)`); they perform no `@`/`!`
expansion. The persister still has no default from canonical text. Verify that
a plain/JSON-created session later restores its recorded user display without
an absent-display placeholder, including literal frame-like prose.

Initial inline restoration prints the prefix once. Same-terminal reseat retains
the existing no-double-print rule. Repaint/picker selection is not an effect
disclosure acknowledgement: preserve the existing input-ready/render-acknowledged
activation and cleanup ordering before retiring any captured effect evidence.

### Finding a saved session

In Home (landing or idle chat), `/resume` opens the native searchable picker.
It initially lists the current canonical directory; Tab toggles all directories,
typing filters titles as a literal substring, PgUp/PgDn change bounded pages,
and arrows/Enter select. All-directory rows show a separate directory hint.
Esc/Ctrl+C returns without starting a session. Empty results retain the filter
and return affordance; a read error offers retry/return without exposing its cause.
Late or cancelled reads remain owned until settlement and cannot replace a newer
query. The picker reads six rows per page through the
[bounded discovery API](../shared-core/database-schema.md#bounded-session-discovery).

`relavium chat resume <sessionId>` is the canonical shell spelling; the existing
`chat-resume` alias uses the same executor. Omitting the ID opens the same picker
on an interactive terminal and refuses with exit 2 before history/key work
otherwise. Cancelling an omitted-ID picker exits 0. Explicit resume and the shell
picker restore the saved original workspace; Home keeps its original workspace
and refuses another directory with a fixed remedy. Discovery columns never grant
workspace authority. Selecting the already-open conversation is a no-op notice.

`relavium chat --continue` selects only the most recently updated session in the
canonical launch directory (stable ID tie-break), using a SQL limit of one.
No match is exit 2 with a start-chat remedy. It conflicts with `--agent` and chat
subcommands before runtime services start. Plain/JSON explicit-ID and continue
paths retain their existing streams and do not read presentation metadata.

After an interactive conversation with a completed durable turn ends, one line
on the restored primary terminal names `relavium`, `/resume` and the canonical
shell resume command. Clear/reseat retain the latest saved conversation when a
fresh replacement has no completed turn. Untrusted IDs that are not safe shell
arguments use the picker remedy. Plain/JSON and empty fresh conversations emit
no extra line.

## Filesystem authority and resume

A fresh session persists its canonical absolute working directory. Invocation grants and its immutable host-owned filesystem policy are process-local and never persisted. `/clear` and model reseat reuse that same policy only within the same process and canonical workspace; alias retargeting or root identity changes revoke access rather than silently authorizing replacement directories. Approval caches still reset as described below.

Chat admission refuses a workspace whose lexical or canonical policy view is a credential/secret-store directory before creating a session. This prevents canonical persistence from erasing a known workspace-floor denial. Ordinary benign workspace aliases remain supported. Lexical grant/selector provenance belongs to the current invocation; historical alias spellings are not stored or reconstructed, and this check does not repair an already-canonical legacy row's lost provenance.

Resume requires fresh [invocation grants](commands.md#global-options). It may open/read existing history to recover the original canonical absolute workspace, then discovers **current** project/workspace TOML there and validates [root selectors](../contracts/config-spec.md#chat-filesystem-root-selectors) before creating or advancing a session/turn, constructing providers, accessing keys or connecting MCP. Historical TOML is not persisted. The current `--config` remains the global preference override. Launch cwd and `--cwd` cannot replace the saved workspace. Missing, relative or ambiguous legacy workspace aliases refuse.

The [tool filesystem contract](../shared-core/built-in-tools.md#filesystem-permission-tiers) owns the scope, confidentiality and protected-write floors, including the exact host-issued scratch prerequisite. Ordinary chats have no production scratch allocation.

## Agent and model selection

> **MVP-2 step 2 accepted on development:** the keychain/`RELAVIUM_*` descriptions
> below state current MVP-A4 behavior. Step 2 extends usable-source/default-model
> selection with the
> [eligible standard-variable contract](../contracts/config-spec.md#proposed-standard-environment-key-consent--mvp-2).
> A TTY's unapproved standard source is pending consent, not usable; plain/JSON
> callers use eligible sources directly. Custom endpoints stay excluded. Do not
> treat an ambient variable alone as authority to build an interactive provider.

A session **binds one agent for its whole lifetime** — there is no mid-session *agent* switching ([agent-session-spec.md](../contracts/agent-session-spec.md#what-a-session-is-and-is-not)). The **model** is switchable: **`/models`** performs a host-side **[reseat](#model-reseat-models)**, which starts a **new `AgentSession` instance** bound to the chosen model (2.5.G, [ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md)) — each instance still has exactly one model.

- `--agent <ref>` names the `.agent.yaml` (path or `.relavium/` id). If omitted, the chat-mode default applies.
- the model and `fallback_chain` come from that agent, exactly as a workflow `agent` node resolves them; the same fallback chain a workflow uses applies to a chat turn.
- when no agent names a model, the `[chat].default_model` from project config is used — the chat-mode **defaults** (`default_model`, `fs_scope`, the command allowlist, `max_turns` (the hard turn cap → `SessionDeps.maxTurns`), `max_messages`) live in the `[chat]` block of [config-spec.md](../contracts/config-spec.md), which references the workflow canonical homes rather than forking them.
- when **no** `--agent` is given, 2.M binds a **built-in default chat agent** over `[chat].default_model` (the ADR-0116 read/search/find/write/edit grant, plus `ask_user` where a card can answer — [ADR-0132](../../decisions/0132-the-model-can-ask-the-user-a-structured-question.md) — and `run_command`, every call of which the person decides on a card unless the person already approved that exact command (for this session, in any mode that asks; or, in `auto` only, by remembering it while no file write has outdated the grant: the repository's allowlist removes no card there), [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md); egress and ambient OS tools remain opt-in), so `relavium chat` is a zero-config first run.
- **the default model follows the stored key (MVP-A4).** With no `default_model` at any layer, the default agent's provider is the first of `anthropic`, `openai`, `gemini`, `deepseek` that has a key (keychain or `RELAVIUM_<PROVIDER>_API_KEY`). Anthropic keeps `claude-sonnet-4-6`; another provider gets the onboarding wizard's starter model for it, so a user with only an OpenAI key reaches a working chat. A `default_provider` set without a `default_model` is ignored, as [config-spec.md](../contracts/config-spec.md) resolves it. The check is a yes/no question to the key resolver and never reads a key into the session; one session build asks it at most once per provider.
- **a provider with no key is caught before anything is sent (MVP-A4).** Every session build asks whether the bound agent's provider has a key before it asks for MCP consent, spawns an MCP server or sends anything. The message is the one `provider set-key` documents: ``no API key for provider '<id>' — store one with `relavium provider set-key <id>` or set RELAVIUM_<ID>_API_KEY.`` What happens next depends on the surface:
  - `chat`, `agent run` and a non-interactive `chat-resume` refuse with exit `2`. `agent run --fixture` is the exception: it replays a cassette with no key, so it never refuses.
  - An **interactive** `chat-resume` opens anyway, because `/models` can move the conversation to a provider that has a key. Cancelling or deferring its preliminary credential setup preserves this recovery path. Its session build therefore goes on past the check: it still asks for MCP consent and starts the agent's MCP servers, and the notice comes when the view opens. The view says so on open, adding `Or switch to a model whose provider has a key with /models.`, and repeats it instead of sending each message, which is neither sent nor recorded. A key stored meanwhile, in another terminal, lets the next message through.
  - The Home shows the message as a banner and stays open.
  - A `/models` reseat or a `/clear` whose new session cannot be built ends the `chat` REPL with the reason and the `chat-resume` command. The in-Home chat keeps the conversation instead, with a fixed note.

  Without this the first turn failed inside the fallback chain, which deliberately replaces a credential error with a fixed `credential resolution failed` so a host message cannot leak a secret. Only the primary provider is checked: an `auth` failure ends the whole chain, so a keyless primary cannot answer until a key is stored or the model changes, while a keyless `fallback_chain` entry fails only if it is reached.

### Model reseat (`/models`)

`/models` opens the live model **picker** ([ADR-0064](../../decisions/0064-live-model-catalog.md)) — **interactive-only**, so in a plain / `--json` chat there is no overlay: the command reseats nothing and prints an actionable hint (one machine stream stays one session lifecycle, [ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Opening the picker changes nothing; the effect lands only on an explicit selection, and it differs by surface:

- **in a chat** — the live session is **reseated** onto the chosen model ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md)).
- **in the bare Home** (no live session) — nothing is reseated; the pick is written as the global **`[preferences].default_model`** (and, when the effort sub-step ran, the effort tier) for the *next* session, over the config-write contract ([ADR-0063](../../decisions/0063-cli-config-write-contract.md) §1). It is the lowest-precedence fallback *under* `[chat].default_model` — precedence in [config-spec.md](../contracts/config-spec.md).

A reseat is a **host-side** move — the engine is unchanged. It reconstructs the conversation and resumes a **new `AgentSession`** instance on the chosen model; the **session id and its `history.db` row continue unbroken** ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md)). Two different things are called "the transcript", and a reseat treats them differently:

- the **model-facing** transcript is reconstructed from surviving persisted conversation text **plus bounded, content-free receipts** of earlier completed turns' recorded tool calls — a built-in tool's name (every other name is the fixed label `other_tool`) and its recorded outcome, rebuilt from the content-free structure already persisted — **and, for the question tool alone, what the person was asked and how they answered** ([ADR-0133](../../decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md): a bounded, quoted note under that call's receipt, so a resumed or reseated session grounds on it like a live one) ([ADR-0128](../../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md); the [session contract](../contracts/agent-session-spec.md#content-free-action-receipts--adr-0128) owns the grammar and bounds). Prior model-issued tool **arguments and results**, including file contents returned only through those tools, are excluded. User-injected `@` file content and `!` shell text remain user text, subject to the existing history boundaries and authored memory projection. A one-line notice discloses exactly this on every switch: arguments and results are not carried, content-free records of tool names and outcomes are (and, for the question tool, what you were asked and how you answered — the new model, possibly another provider, receives it), and text you sent is. Carrying tool history *content* into context remains deferred under [ADR-0095 §2](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) and [CR-70](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md), rather than waiting for a new persister/schema.
- the **rendered (on-screen)** transcript **carries too** (2.6.C). The reseated view opens with the conversation you were having, and the switch **marker** — `⇄ model changed <old> → <new>` — lands *beneath* it, so the switch reads as an interruption of a conversation you can still see. This matters most on the **full-screen alt screen**, the TTY default ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e), where the viewport windows the store's in-memory transcript and the alt buffer has **no native scrollback** to fall back on: before 2.6.C the reseated view opened empty and the whole chat vanished from the screen. The **inline** renderer deliberately carries nothing — its lines were already printed by ink's `<Static>` and survive the swap in the terminal's own scrollback; re-seeding them would print the conversation **twice**. (`/clear` carries nothing on either renderer — a fresh start is its entire contract.)

The **cumulative cost** carries forward from the session row. The **turn count** is *re-derived* from the surviving reconstructed transcript, so a reseat after a `/compact` or `/trim` — or after an errored turn the engine did not retain (a retained interrupted turn is persisted and counted, ADR-0119) — resumes at a **lower** count than the pre-switch session. The hard turn cap is measured against the reconstruction, not the session's lifetime total.

What a reseat does **not** carry:

- the original agent's **`fallback_chain`**. The new instance builds the default chain for the chosen model, exactly as a fresh session on that model would.
- the chat **mode** — the new instance starts in the **currently configured starting mode**, resolved exactly as a fresh session resolves it (`auto` still needs the revocable startup-auto authority, and a repository config layer can never supply `auto` or `accept-edits`), not in the mode the old instance had ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md), amended 2026-11-11). [`/clear`](#the-multi-turn-loop) does the same.
- the per-tool **approval once/always cache** — it is instance-scoped, so previously-approved tools **re-prompt** on the new model ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md); a new model is a new trust context).
- a live **`/effort` override** — a stale tier from the old model is never carried; the new instance takes the tier picked in the reseat's effort sub-step, or none.

**The effort sub-step has two outcomes**, and only one of them reseats ([ADR-0066](../../decisions/0066-normalized-reasoning-effort-control.md) §6):

- picking a **different** reasoning-capable model — the chosen tier rides into the reseat and is bound on the new instance, so it is in force from its **first** turn.
- re-picking the **model you are already on**, just to change its tier — a live **per-turn session override**, identical in mechanism to [`/effort`](#the-multi-turn-loop). **No reseat.** (Re-picking the same model with *no* effort sub-step is a no-op: the picker stays open with a hint.)

Each **assistant** message is persisted with the `model_catalog` id of the model that actually produced it — resolved from the turn's last billed egress, so it is failover-aware ([ADR-0059](../../decisions/0059-cli-mid-session-model-reseat.md)). User rows carry none. A turn that never billed, or a model absent from the catalog (a live-catalog or custom-`base_url` model), leaves it **null**. Attribution resolves by model **string**, not by provider, so an id shared across two providers can mis-attribute — a known low-severity edge (ADR-0059).

[`/cost`](#the-multi-turn-loop) surfaces the money side of this, per model ([ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md)). It does **not** read the per-message `modelId` above — a message row holds exactly one model, but a single turn can bill **two** (a tool loop that fails over mid-turn), which no per-message column can represent. Spend is attributed in its own durable table, whose rows are **guaranteed to sum to the total** `/cost` shows — for every session, across resume, reseat, failover, compaction, and errored turns. Two honesties it carries: a `$0` row with real tokens is a model we could not **price**, not a free one; and a session older than 2.6.C says its breakdown is unavailable rather than pretending it used one model.

> The guarantee is against Relavium's **own event stream**, not the provider's invoice. An egress that streamed content but ended without a usage chunk, and a mid-stream failure, are recorded as zero on **both** sides — so the reported spend is a systematic **under**-estimate of the bill. Closing that gap is seam work, tracked in **2.6.Q**.

## The multi-turn loop

Each prompt you type is one user turn; the assistant turn that follows may include tool-call round-trips before it completes, then control returns to the prompt:

1. you type a message → it is appended as a `user` [`SessionMessage`](../contracts/agent-session-spec.md#session-messages);
2. the `AgentRunner` streams the assistant turn (tokens, tool calls, tool results);
3. the assistant's final **text** is appended — within-turn tool call/result pairs are not carried into later turns ([ADR-0095](../../decisions/0095-what-an-agent-session-remembers-across-turns.md) §2); the turn's content-free **receipts** (tool names and recorded outcomes, never arguments or results) are kept with it and shown to the model on later requests ([ADR-0128](../../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md)); the prompt returns for your next turn.

Messages are **append-only** and persisted per turn; the loop is the same code path a workflow `agent` node uses — the difference is the entry point and lifetime, not the execution.

A small, **alias-free**, curated set of slash commands drives the REPL itself (not the agent) — the in-REPL surface of the command system ([ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md), 2.5.C; the curated REPL set is `apps/cli/src/commands/repl-commands.ts`, distinct from the shell command surface). The `/help` list, the unknown-slash hint, and the `/` palette all derive from that one registry, so they cannot disagree. A slash command never spawns a shell subcommand. Under [ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md) every routine task gets an in-TUI form that re-hosts the same core as its subcommand, milestone by milestone; until a task has one, it is reached through its subcommand.

| Command | Effect |
| --- | --- |
| `/help` | List the available slash commands (**2.5.C**). Typing `/` at an idle prompt instead opens the interactive, filterable **`/` palette** over these commands (in both the chat and the bare Home). |
| `/exit` | End the session cleanly and quit the REPL (**exit code 4**, below). |
| `/cancel` | End the session **terminally** (aborting any in-flight turn). **Ctrl+C** reaches it only as the *second* press inside the arming window ([the interrupt keymap](#the-interrupt-keymap--mvp-4-adr-0115) below), so one stray press never ends a session. The session is **persisted and resumable** via `relavium chat-resume <sessionId>` (2.N). Exits with code 4. For a mid-turn abort that KEEPS the session alive, press **Esc** (2.5.E, below) or the first **Ctrl+C** — that is distinct from `/cancel`. |
| `/export` | Export the session-so-far to a `.relavium.yaml` scaffold (same ADR-0026 contract as `relavium chat-export`). Writes the file where workflows live — `<project>/.relavium/workflows/<id>.relavium.yaml`, where `<project>/.relavium/` is the nearest actual project directory found walking up from the working directory (global `~/.relavium/` and its aliases are excluded by the [project-location contract](commands.md#relavium-init)), or `<cwd>/.relavium/workflows/` when there is no project — with the session title's slug as the id (written into the file as `workflow.id`), and shows the path and the command that runs it (``run it with `relavium run <id>` ``) (MVP-A3) — in the transcript on the interactive chat and Home, on stderr on the plain driver. Under `--json` no path line or run hint is printed: the path is the `session:exported` event's `workflowPath`. A refusal (`export failed: …`) goes to the transcript, or to stderr on the plain and `--json` drivers. It never overwrites another workflow: the id is the first of `<slug>`, `<slug>-2`, … that no catalog file or `workflow.id` already holds. The one file it rewrites is the session's own earlier export, recognized from the file itself — a regular file, never a link, at one of those names whose `metadata.relaviumExport` names this session — so a later `/export` of the same session updates it in place, atomically, across a `/models` reseat, a `chat-resume` or a Home reopen, while a workflow put where an old export used to be is left alone. The rewrite re-checks the file just before it replaces it, so a file changed or replaced after it was recognized is left alone too and the export moves on through the same names: another of this session's own exports there is rewritten instead, otherwise the next free id is taken; the check compares the file's bytes as well as its stat, so a same-length rewrite is caught too; a swap in the moment between that check and the replace is not detected. Under `--json` it emits a `session:exported` event on the stream. It does **not** mark the session row `exported` (a later turn's persist would clobber that) — use `relavium chat-export` for the durable provenance mark. **Live (2.P / 2.Q).** |
| `/permissions` | Open the **permissions sheet**: the commands **remembered for this project** and the ones **approved for this session**, docked under the conversation. `d` (or `Delete`) then `Enter` withdraws the selected row, `Esc` or `Ctrl+C` closes; it takes no argument ([ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2; [ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2; [command-permissions.md](command-permissions.md#in-the-chat-permissions-a-sheet)). In a chat it lists both; the bare Home's `/permissions` opens the same sheet with the project's list only (MVP-4 step 7). On a plain, `--json` or one-shot chat it says remembered commands are not available. |
| `/agent` | Show the **agent this chat is bound to**, read-only ([ADR-0140](../../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3): its id and name (and that it is the built-in chat agent, when it is), the **provider and model the session runs on now** (a `/models` reseat builds a new session, so it shows the new pair), the temperature, the **session's current reasoning effort** (the tier the footer shows, which `/effort` and the `/models` effort step change on the session and never in the definition; where the definition declares another the row adds `(declared: …)`, as in `high (declared: medium)`, and `not set` means no tier), the tool grant as the definition declares it and the first 240 characters of the system prompt (scrubbed whole before the cut, as the `/agents` page does). **Two facts come from the host, not from the definition.** A declared tool this chat's host does not wire (the model is never offered it: a question tool where no one can answer a card, a delegate wired nowhere) is **marked `(not available in this chat)` after its name**, and the list then leads with how many are offered (`7 of 9 offered: read_file, …`); a grant the host wires whole shows no mark and no count, and the grant itself is never changed, only marked. Where the list does not fit its lines, a cut leaves out *offered* names (one `…` for each run) before it leaves out a mark, and a name is never split from its mark over two lines. The marks describe the host's wiring, not the chat mode, which hides governed tools per turn. A **`File` row** (after the name) gives the label of the file the agent was read from, **relative to the working directory and never absolute**, cut from the front when it is long so the file's name stays; it is shown for a chat started with `relavium chat --agent <ref>` or from the Home's `c` on an agent's page, and not for the built-in agent, a resumed session, or a chat after `/clear` or a `/models` reseat, which hold the definition and not the file. Nothing else of the definition is shown: no absolute path, no full prompt, no key. An interactive chat (standalone or in the Home) docks it under the conversation as a sheet of the same family as `/permissions`: at most twelve rows at 80×24, a field that does not fit is cut with `…`, `Esc` or `Ctrl+C` closes it, every other key and a paste are dropped, and only one such sheet is open at a time; below 80×24 it says to enlarge the terminal. The view is made afresh each time the sheet opens. A plain, `--json` or one-shot chat has no sheet and prints the same fields as a notice on stderr, never on the `--json` stream. It takes no argument and reads and writes nothing. |
| `/workflows` | List the project's discovered workflows + agents (the disk catalog) as an in-view **notice** (**2.5.C S4**). A project-less cwd is reported, not an error. Chat-only today. |
| `/cost` | Show the session's spend as an in-view **notice** — the total, then a **per-model breakdown** (**2.5.C S4**; the breakdown is **2.6.C**, [ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md)). Read from `history.db`, not from memory, so a **resumed** session shows the whole session's models and not just this process's. A `$0` row with real tokens is flagged *price unknown* — an unpriced model is not a free one. A model carrying a **conservative budget commitment** ([ADR-0074](../../decisions/0074-durable-conservative-budget-commitments.md) §1/§4 — money a provider may already have billed for an attempt that returned no trustworthy usage) shows it as *estimated, possibly billed*, **never added into the spend figure or the share**; a commitment made before any completed call on that model reads `(no completed call)` rather than claiming `0 calls`. That is what explains a `$0.0000` session whose next turn the cap refuses. Chat-only. |
| `/mode [name]` | Switch the chat **mode** — `ask` / `plan` / `accept-edits` / `auto` (**2.5.E**, below); bare interactive `/mode` opens the mode/default picker. In idle Home it configures startup only. `Shift+Tab` cycles current modes without saving. |
| `/thinking` | Show / hide the collapsible **reasoning ("thinking") panel** (**2.5.H**; also `Ctrl+T`). A pure UI-view toggle (no session/engine effect); the panel is only rendered while the model is actually streaming reasoning. Default collapsed. Chat-only. |
| `/doctor` | Run a setup health check as a **notice** (**2.5.C S5**). Fast tier: OS keychain reachable · config valid · wired tool capabilities. `--deep` adds provider-key validation (a bounded, **redacted** live ping per configured key — the key never reaches the output) + the live session's MCP status (the bound agent's connected servers + any tools the manager dropped). The `--deep` MCP tier is **read-only** — it reports the already-connected session, never a fresh connect/spawn (a security-review decision). Available in **both** the chat and the bare Home (pre-chat diagnostics); the Home palette runs the fast tier, `--deep` is typed in a chat. |
| `/compact` | **Model-summarise** the conversation so far to reclaim context — an LLM call ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md), **2.5.F**; see § Context compaction below). Reports context-token estimates, known summary-token observations (qualified when incomplete), and a summary preview as a **notice**. Acknowledged summariser money remains in the session's qualified totals and `/cost`. Checks the bound agent's [memory policy](../contracts/agent-yaml-spec.md#conversational-memory) before showing progress; a policy refusal names why without starting a call. Effect `write` (spends tokens). Chat-only. |
| `/trim [n]` | **Deterministically** drop older messages down to the last `n` (default `[chat].max_messages`), **no LLM call** (ADR-0062, 2.5.F); keep a user boundary even if that retains an extra message. Checks the [memory policy](../contracts/agent-yaml-spec.md#conversational-memory) before missing/invalid-bound notices. When permitted, a bare `/trim` with no config bound prints an actionable notice; a bound larger than the history is a reported no-op. Chat-only. |
| `/models` | Open the live catalog **picker** ([ADR-0064](../../decisions/0064-live-model-catalog.md)) — **interactive-only**. In a **chat**, picking a *different* model **reseats** the live session onto it; re-picking the model you are already on only sets its effort tier (a per-turn override, **no reseat**). In the **bare Home** it writes the next session's defaults instead. Both paths — and what a reseat does and does not carry — are in § [Model reseat](#model-reseat-models) (**2.5.G**). Opening the picker changes nothing — the effect lands only on an explicit selection. Under `--json` / a plain non-TTY there is no overlay: nothing is reseated and an actionable hint is printed. |
| `/effort [tier]` | Set the **reasoning-effort** tier — `off` / `low` / `medium` / `high` / `max` ([ADR-0066](../../decisions/0066-normalized-reasoning-effort-control.md)); bare `/effort` shows the current tier + the options. A **per-turn session override** on the live session — **no reseat** (unlike `/models`), and it does **not** survive one. Always available in a chat: on a model with no controllable reasoning tier the command says so and the tier is stored but **inert** (gated off at send) — it is the picker's effort sub-step and the footer indicator that are capability-gated, not this command. Chat-only. |
| `/details` | **MVP-3 Step 2 accepted on development:** inspect bounded live tool-call details using the [shared interaction contract](#proposed-mvp-3-interaction-contract). Interactive chat-only; a plain/JSON session prints a fixed remedy. It executes no tool, sends no model message and reconstructs no historical preview. |
| `/scrollback` | Dump the transcript into the terminal's **native scrollback** (to scroll, search, select, copy — Enter returns). One of the three copy-and-search **hatches** described under § [Entry](#entry) — the alt screen has no scrollback of its own. Not available before the first turn. Chat-only. |
| `/edit` | Open the transcript **read-only** in `$EDITOR` (to search or copy). See the hatches under § [Entry](#entry). Not available before the first turn. Chat-only. |
| `/copy` | Copy the **whole unwrapped transcript** to the system clipboard over **OSC 52**. See the hatches under § [Entry](#entry). Not available before the first turn. Chat-only. |
| `/clear` | Start a **fresh conversation** — end the current session (**persisted + resumable** via `relavium chat-resume <sessionId>`) and swap in a new one under a new `sessionId` ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §7, **2.5.F**). Effect `destructive`; the fresh session resolves the configured starting mode, preserves its bound agent grant and resets budget/turn/cost totals to zero (the old totals stay on the resumable row). Its notice names the prior session + the exact resume command. **Interactive-only** — rejected under `--json` / plain non-TTY, where one machine stream is one session lifecycle ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Works in `relavium chat`, `chat-resume`, and the in-Home chat (swap in place, staying in chat); in the **bare** Home (no live session) it is an honest "nothing to clear" notice. |

An unrecognized `/…` command — or an **undeclared argument** on a known one (`/exit now`) — prints a one-line, secret-free notice and the prompt returns. A command may accept flags (`/doctor --deep`) or a single positional value (`/mode plan`); the `/` palette runs the bare form, so a flag/value is opt-in by typing it. The idle footer surfaces `/ for commands` at an empty prompt (2.5.C S6). In a TTY, **Ctrl+C** is the interrupt keymap's, not `/cancel`'s: the `ink` REPL runs in raw mode, so the kernel does not raise SIGINT and the REPL handles the key itself — the first press interrupts, clears or arms, and only a second press inside the arming window ends the session ([the interrupt keymap](#the-interrupt-keymap--mvp-4-adr-0115)).

<a id="proposed-mvp-3-interaction-contract"></a>

## MVP-3 interaction contract

**Accepted design (2026-11-11); Step 2 accepted on development (2026-11-12):** approved together with
[ADR-0116](../../decisions/0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
and [ADR-0120](../../decisions/0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md).
Step 2's approval/details and structural restoration complete native-write
integration, independent implementation/security reviews and combined CI in the
[acceptance record](../../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-step-2-acceptance-2026-11-12).
Step 3's mode/default picker and new built-in grant are independently
[accepted on development](../../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-step-3-acceptance-2026-11-12).
The checkpoint PR carries combined CI and maintainer review. These contracts
describe that implementation.

**Mode picker.** In a live interactive chat, bare `/mode` opens a shared picker
with current-mode selection and a separate `Save startup default` action. Direct
`/mode <name>` and Shift+Tab change the mode for the next turn without saving. The engine takes the turn policy once, when a
turn starts, so while a turn is running Shift+Tab changes nothing and shows `Mode changes apply between turns — Esc stops the running
turn.`; the footer never names a mode the running turn is not under.
In idle Home, `/mode` opens only startup-default settings, with no imaginary
active session; `/mode <name>` there does not silently save. Show the effective
start and any project/workspace override before saving globally. Confirm `auto`
explicitly, explain approval-free ordinary writes, and preserve hard path floors.
Cancel saves nothing. The hint names Shift+Tab, `/mode` and the configurable
start; persist its acknowledgement only after visible delivery. Fresh/resumed/
cleared/reseated interactive instances bind the configured start and first-frame
footer together, with a fresh approval cache. Preserve frozen agent grants;
older read-only sessions require a new built-in conversation to gain new tools.
The [config contract](../contracts/config-spec.md#proposed-starting-chat-mode--mvp-3)
owns authority and publication outcomes. Non-TTY/JSON never open this picker and remain
effective `ask`; direct mode commands cannot create a headless approver.

**The docked card ([ADR-0129](../../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)).**
While an approval waits, its card sits in the live region below the conversation, which stays
on screen; the full view (`[v]`) and the call list (`/details`) are the only screens that take
the terminal over. The card takes at most three fifths of the rows (twelve at 80×24) and never
leaves fewer than eight for the transcript. It shows, in order: a thin rule; the **effect and
target** (`Create merhaba.md`, `Edit src/app.ts`, `Overwrite notes.txt`); the **diff body**
(`+n` additions, `-n` removals, context dimmed, coloured when colour is on) sized to the
height; one summary row — the tool's id, `+added −removed · N bytes`, and, when the body is
cut, `… N more lines (M bytes hidden)`; **only the warnings that apply** (a shortened target, masked
values that require inspection, a non-LF or changed line-ending convention or a final newline added or removed, a lock with no
other stated cause), each wrapped to the card's width; and two key rows —
`[Ctrl+Y] Allow   [Ctrl+G] Allow all <file writes|file edits|<tool> calls> this session` and
`[Ctrl+N] Deny   [Ctrl+R] Deny + reason   [v] Full diff   Esc stops the turn`. While Allow is locked behind an
inspection the first key row says so (`(Allow is locked until you inspect the change)`) and the second still offers `[Ctrl+N] Deny`. The card's body opens on the first changed line with up to three lines of unchanged context above it, not on the top of the file;
if any changed line is not drawn it adds `⚠ N changed lines not shown — press [v] for the full diff.` and withholds `[Ctrl+G]`. A session-wide
grant is never offered on a partial view, on the card or in the full view: `[Ctrl+G]` appears only while the page drawn shows every changed line, and a call
without a diff whose content is clipped shows `⚠ N lines of this call are not shown — press [v] for the full view.` and offers no `[Ctrl+G]` either
(`[Ctrl+Y]` and `[Ctrl+N]` stay). **Every answer key is a Ctrl chord, never a bare letter** — a letter typed while a turn runs is typing, and "yes do it" would otherwise approve a write with its first character; the question card's `Ctrl+S` skip follows the same rule ([ADR-0132](../../decisions/0132-the-model-can-ask-the-user-a-structured-question.md)), and `Ctrl+A` is deliberately not an answer (the line-start key of every readline habit and the prefix of GNU screen). A bare `y`, `a`, `n` or `c` answers nothing and counts as typed text. An affirmative chord (`Ctrl+Y`, or the first `Ctrl+G` or `Ctrl+O`) counts only when it is a deliberate answer: the card has been on screen for at least 400 ms,
the previous key of any kind is at least 300 ms old, no key that is not a card action (text typed into the composer while the turn ran, a key the card
ignores, text typed into a search, a reason box or a question card's own answer) arrived in the previous 1.5 s, and no card was resolved by a key in the previous 2 s (a held
key keeps extending that window). The session-wide `[Ctrl+G]` takes two steps: the first `Ctrl+G` shows
`Press Enter to allow all … this session · any other key cancels` and Enter 0.8–5 s later with no other key between grants; a second `Ctrl+G`, typed text or a held key never does. `[Ctrl+O]` (Remember, on a command card only) is the same two steps with its own question, `Press Enter to allow this exact command now and remember it for this project` (and `[Ctrl+G]` on a command asks `Press Enter to allow this exact command for this session`), and the same guards. A refused chord is ignored
without effect and the card says why, once. `[Ctrl+N]`, `[Ctrl+R]`, `[v]`, `Esc` and Ctrl+C are never delayed (`Ctrl+N` needs no visible frame, so a card that cannot be read can still be refused); all timing uses a monotonic clock. Typed text can never resolve a card; the one stray source left is a held chord, whose repeats the 2 s lockout refuses. A chord is not an answer inside the reason box, the full view's search box or the call list. The card opens with a yellow rule labelled `Approval needed`,
its answer keys are coloured, and while it is open the busy line reads `Waiting for your answer <time> · Esc stops the turn`;
the wait is excluded from the turn's elapsed time and from the footer's duration, which shows `<active> · <wait> waiting for you`. `[Ctrl+N]` and `[Ctrl+R]` deny and
**continue**; `Esc` (at the card) and Ctrl+C (from anywhere) **stop** the turn and **reject the pending call first** (below); `Esc` inside the reason box or the full view's search box only closes the box, and `Esc` on the full view returns to the card with the call still pending. A clean change shows no zero counts. An ending
token (`<LF>`, `<CRLF>`) is printed only where a line's ending differs from the rest of its side or
from the other side; `<EOF:NO_NEWLINE>` always prints. Everything below about inspection,
masks, exact-frame acknowledgement and resource limits applies to the card and the full view alike.

### The full view and the tool details

([ADR-0134](../../decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md))
`[v]` on the card and Enter on a `/details` call open **one** screen. The card, its answer keys and its guard are unchanged.

- **Listing.** One row per unchanged line, in the card's format (a gutter number, `+`/`-`, dim context, colour where on); a call's
  fields read as a name with its value indented below. The second copy of an unchanged line (`=before N`) is listed only when a
  mask touches it. Every escape, mask and ending token rule is unchanged.
- **Opens** on the first change with up to three unchanged lines above it, like the card — or on the top when the card shortened the
  target (it is read first) or when field rows come before the diff. Details open on the top.
- **Chrome**: a header (the screen's name, the tool's identity and the counts — always — on one row when they fit; otherwise the identity on one row under the title), a `target` row while the body is scrolled away from it,
  only the warnings that apply (the lock names its cause and its key; a met requirement prints nothing; line endings only for a
  change of convention), the body, a status rule (`64% · changed lines off this page: 2 above, 4 below`, plus `masked values
  revealed (view only)` and `Unicode code points` while on), a message row (always one row, blank when empty) and a search row while the search box is open, the navigation legend
  (`[key] words`, keys coloured; only keys that do something; movement and inspection on their own rows), the answer rows (the card's
  grants row, and a second row with `[Ctrl+N] Deny   [b] Back to the card   Esc back   Ctrl+C stops the turn`) and one closing note: the protected-path sentence on an approval,
  `[b] Back to the list   Esc closes · viewing never executes a tool` on details. One row stays empty.
- **Keys** (none answers anything; one that acts is not typing evidence): `↑`/`↓` or `k`/`j` one listed line · `PgUp`/`PgDn` or
  `Space` a page (a page cut inside a long line continues there) · `Home`/`End` · `Tab`/`Shift+Tab` the next/previous change (a
  run of changed lines; runs six unchanged lines or fewer apart are one, and a change is about 40 listed lines at most; inside a
  change longer than a page `Tab` lands on the next page that shows a changed line not yet seen and `Shift+Tab` on the page that ends on the nearest one above, so none is stepped over) · `/` search · `r` reveal (only where something is
  masked) · `p` every non-ASCII character as its code point (`<U+0131>`; ASCII stays readable) · `c` copy the masked page · `b` back to the card on an approval (back to the list on details) · `Esc` one level back: it closes an open search box, then returns an approval's full view to its card (the call stays pending, nothing is answered, and no visible frame is needed), and on the card it rejects the call and stops the turn; on details it closes · `Ctrl+C` stops the turn from anywhere on an approval and closes details. While a session-wide or remember question waits on the full view `Esc` cancels it and steps back too (the second row says `Esc back · Ctrl+C stops the turn`); a screen too small to read says `[Ctrl+N] denies · Esc back · Ctrl+C stops the turn.` on the full view and `[Ctrl+N] denies · Esc stops the turn.` on the card. An approval never shows the call list: it opens only for details.
  Scrolling down stops at the last page that begins on a line (the screen ends on the document's last row). A row is measured as the whole string the renderer
  (`string-width`) measures and is never cut by it: a row wider than its page would wrap — one wrapped row uses the spare row and is drawn
  whole, a second makes the frame too tall and it is refused — and a row holds at most three tokens per column, so a run of zero-width
  characters goes on in the next row.
- **The call list**: oldest first, opening on the **newest**; a row is a mark (`✓`, `✗ failed`, `⊘ denied`, `? outcome unknown`,
  `… running`), the tool, what it touched, `+a −r`; never a result (read it in the details view, through the masks). `↑`/`↓`,
  `PgUp`/`PgDn` (ten), `Home`/`End` select; Enter opens; Esc closes.

**Approval and details.** Both chat hosts reuse one pure state machine and views.
The card names the target, exact changed/hidden byte and line counts, and `[Ctrl+G]`'s tool/session
scope; mask counts and line-ending notes appear on it when non-zero or non-LF, and the full view always
lists them. `[v]` opens its full view — one readable inspection screen shared with
`/details` ([ADR-0134](../../decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md);
see [the full view and the tool details](#the-full-view-and-the-tool-details)) with
search, code-point inspection and an explicit `[r]` reveal action. A compact target header states its exact omitted
byte count when shortened; the full target remains a paged source field in the
full view. A shortened target blocks affirmative answers until its complete
source has actually been displayed there in acknowledged frames. Readable,
unmasked target bytes need no reveal action; a placeholder never proves visibility
of its hidden bytes. A bare `[r]` (reveal) is never an approval key; `Ctrl+R` is the deny-with-reason chord. Any masked
changed content, or a flagged target/field span, blocks `[Ctrl+Y]`/`[Ctrl+G]`/`[Ctrl+O]` until revealed
deliberately and the required revealed spans have actually been displayed in
acknowledged frames; an entirely masked changed line is inspectable under that
rule, not a blind exception. The approval projection escapes invisible/control/blank
characters and distinguishes literal escape text, tabs, trailing spaces and line
endings under ADR-0120. Reveal is overlay-local, re-escaped and reset on close,
card/owner replacement, geometry invalidation or abort. Structurally excluded
secrets are never available to reveal.

A retained workflow result uses the
[saved-result confirmation contract](../shared-core/tool-registry.md#proposed-prepared-writes-and-live-previews--mvp-3),
when an approval regime is present. Its live card labels delivery of a saved
result with no new filesystem operation, shows no invented fresh diff, and
cannot grant `always` authority for a later mutation. Current mode/denial,
ownership, visibility and cancellation controls remain. Session effects never
replay; this does not add replay to chat history or restore previews at rest.

Every affirmative input must match the exact current card, owner, geometry and
actually flushed measured frame. A mere React render or terminal-size check is
insufficient. Below 80×24, clipped mandatory card content or controls, suspend,
output backpressure or a stale/mismatched frame disables affirmatives. Intentional
diff pagination is different: the shortened card may be approved when its target
is fully visible or has completed the required full-view inspection, its
effect/truncation/mask disclosures and answer controls are fully visible, its
full view can traverse every admitted change and all required mask inspections
are acknowledged. Visiting every unmasked diff page is the operator's choice,
not an implicit approval prerequisite. Coalesced input or paste
cannot reveal and approve unseen content, and typed-ahead, repeated or double-tapped keys are refused by the rules above. Existing rejection, abort, suspend
and mouse-consumption controls remain; Esc/Ctrl+C cancel these overlays. Resize
requires fresh visibility acknowledgement. This also applies to an idle Home's
focused Continue row; prompt/keyless/error/notice rows get explicit priority,
and optional rows cannot displace the focused row or active input/card. MVP-8
still owns workflow/run/gate content and actions.

The approval content projection has one color-independent token alphabet:
`<U+HEX>` for escaped code points, `<TAB>`, `<SP>` for trailing ASCII spaces,
`<LF>`, `<CRLF>`, `<EOF:NO_NEWLINE>` and labelled `<MASK:id=N;bytes=N>` spans.
Every source `<` becomes `<U+003C>` before inserting synthetic tokens; process
source characters once, never re-escape generated tokens. Masked source ranges
are projected before this escaping. Literal token-shaped text therefore differs
from every synthetic token in both sides, inline/stacked layouts and color-off.
Gutters/status labels are typed UI framing, never inferred from source prefixes.
Wrap tokens as indivisible atoms or disable approval if the complete required
notation cannot be inspected. The final-line ending is `LF`, `CRLF` or `none`;
show differing/missing final endings on both sides. Empty files have zero lines
and an explicit empty-file state; a new empty file still has a new-file effect.
Test literal middle dots/tokens/tabs, empty/new files and final-newline-only
additions/removals as adversarial pairs, not just snapshots of one projection.

Live `/details` opens a keyboard-selectable bounded tool-call list (opening on the
newest call) and the same inspection screen as the full view, with declared preview and
bounded result summary. It is a view
action, never a new execution or approval. Keep targets and write diff stats
after a live turn and order assistant text segments between calls. Failure,
denial and unknown have distinct marks/words; missing facts never become success.
No interrupted-turn persistence is added. Both hosts provide inline and no-color
parity, scroll/search and explicit copy of the escaped, masked representation
with truthful clipboard feedback. Copy uses the masked companion of the exact
acknowledged page's original source intervals and row boundaries, including a
cursor inside a mask. It never independently projects a larger or differently
collapsed source window. Partial masked intervals retain their original mask id
and report only the intersecting byte count. Revealing never copies raw secrets;
a stale or unacknowledged page cannot be copied.
Ordinary transcript hatches, `/edit`'s temporary file, `/export`, logs and display
metadata exclude previews/reveal buffers. No preview-to-disk hatch is introduced.

**Review resource limits.** Each diff side admits at most 8 MiB of UTF-8 and
100,000 lines. The in-house line diff caps graph work at 1,000,000 steps,
retained search trace at 8 MiB and output at 200,000 operations. Source spans
use UTF-16 offsets; displayed byte counts use UTF-8. These units are not
interchangeable. A review document also caps target text at 4,096 code units,
fields at 64 (256 per name, 4,096 per value), and required inspection intervals
at 8,192. Invalid spans, incomplete diff coverage or inconsistent counts make
the document unavailable for approval rather than silently dropping changes.

Live detail retention admits 64 calls and 32 MiB of source text per store,
keeping an active review pinned. Older evicted details are labelled
unavailable. Navigation keeps no history stack (motion is by geometry, ADR-0134 §5), searches accept
256 code units, and a projected page consumes at most 65,536 source code units
and 200 display rows. Display targets/summaries have separate 512/2,048-character
caps and explicit omission counts; these abbreviated labels never replace the
full approval document. Teardown seals preview retention before joining host
resources, clears reveal/detail buffers and ignores late preview delivery.

**Restored safe tool groups.** Extend the existing restore projection only with
content-free call names/engine ids/outcomes already retained for completed turns.
Join within the same turn by engine call id, never name or adjacency. Do not
restore tool-call preambles, arguments, targets, diffs, result bodies or reasoning.
Live diff statistics are also absent after restore; only the retained safe
structural facts supply the group, with missing outcomes shown as unknown.
Retain at most 16 structural call summaries per turn, displayed as a collapsed
group of at most four logical rows with explicit omitted-call counts. Treat
that bounded group and its user/final assistant as one restore unit; reserve
its rows inside the existing 500/full-screen or 200/inline logical-entry budget
before admitting an older unit. A tool-heavy latest completed turn must still
fit. Report omitted conversation entries and omitted tool calls separately;
physical wrapping is independently measured. Keep existing legacy-user display
substitution, empty finals, compaction dividers and model-context projection.
Since [ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md) (MVP-3c), a restored
**interrupted turn** shows its user message, its structural tool calls and a fixed dim row, `Interrupted — the user
stopped it` / `it failed (<code>)` / `a tool call was refused and the turn ended` / `it reached a limit on tool use`,
where an assistant answer would be; it restores no argument, target, diff or result, and counts as two entries in the
restore budget (the user line and the dim row), like a completed turn.
Historical unavailable preview/detail content is labelled unavailable, never
reconstructed from text. This needs no new history payload or migration.

## Chat modes + per-tool approval (2.5.E, [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md))

The session's `ToolHost` is bound **full-capability** for its lifetime (fs read+write, process, egress, os); a **mode** is a policy layer on that one instance — **no reseat**, so switching never loses tool context. `Shift+Tab` cycles **`ask → plan → accept-edits → auto`** and `/mode <name>` jumps directly; the active mode is always shown in the footer. Absent a configured start, the default is **`ask`**; [starting-mode authority](../contracts/config-spec.md#proposed-starting-chat-mode--mvp-3) governs every new instance. Two layers enforce it: a best-effort per-turn **advertise-filter** (a governed tool is not offered to the model) and the **authoritative, fail-closed `confirmAction` hook**. The names say what the modes do ([ADR-0130](../../decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md)):

| Mode | Advertised tools | A governed action (write / command / network / clipboard) |
| --- | --- | --- |
| `ask` (default) | every granted tool | **a card, every time** — `Ctrl+Y` once · `Ctrl+G` (then Enter) always for this tool this session (for a command: this exact command, plus `Ctrl+O` then Enter to remember it for this project) · `Ctrl+N` deny and continue · `Ctrl+R` deny with a reason · `[v]` full view · `Esc` stops the turn |
| `plan` | granted **non-governed** tools (the built-in agent has read/list/git status/search/find, and `ask_user` where a card can answer) | **refused** with a fixed mode text that **returns to the model** ([ADR-0117](../../decisions/0117-a-denied-tool-call-returns-to-the-model.md)); nothing is asked or changed |
| `accept-edits` | every granted tool | a **file edit is applied without a card** — inside the workspace or inside a root the operator authorised with `--allow-fs-root` (its transcript row keeps the target and diff statistics); a command (see below: it is the one class keyed by its exact argv), network call, ambient OS action or delivered saved result still gets a card unless the person already granted `Ctrl+G` for that tool this session (for a command, `Ctrl+G` is that **exact argv**, never the tool: approving one command approves no other). A protected path is refused while the write is prepared, before any card, in every mode |
| `auto` | every granted tool | **auto-approved** for granted actions; hard protected-path and scope refusals remain (a protected target is refused while the write is prepared, before any card) |

**A command is the one governed class with a different rule** ([ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1; its card, answers and `/permissions` are in [command-permissions.md](command-permissions.md#the-command-card)). A command is *pre-approved* by the person when a [remembered grant](command-permissions.md) covers its exact argv or this session already approved that exact argv; the `[chat]` allowlist admitting it is the repository's say and is shown on the card (`Standing: on this project’s allowlist`) but pre-approves nothing in a chat. `ask` and `accept-edits` **ask even for an allowlisted or remembered command** — an allowlist or a remembered grant removes the *unknown*, not the person's per-call consent, so a repository's allowlist cannot turn them into silent execution — and only a Session answer given in the current chat removes their card. `plan` refuses. `auto` runs **only** a command the person remembered or approved for this session; anything else asks, including an allowlisted one. A remembered command asks again in `auto` once a file write a chat applied in this project is newer than the grant (the write may have changed what the command does): that holds in this chat and in every later one, until *Remember* renews the grant, and a *Session* answer ends the asking for the one chat only ([ADR-0138](../../decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md); the write marks are in [command-permissions.md](command-permissions.md#the-write-marks)). A *Remember* also approves the command for the chat it is made in, so that chat does not ask about it after a write either. The session memory for a command is keyed by its **exact argv**, never by the tool id, so approving one command never approves another. A plain, `--json` or one-shot surface opens no grant store and hides `run_command` as below. The built-in agent is granted `run_command` (its tool grant and prompt say so), and the `!` escape reaches the same card; both show the command as one quoted line, one row per argument, with where it stands and where it runs, and offer *Once*, *Allow this session* (`Ctrl+G`, Enter), *Allow + remember* (`Ctrl+O`, Enter) and *Deny* as [command-permissions.md](command-permissions.md#the-command-card) specifies.

With **no one to answer** — a plain, `--json` or one-shot surface — the effective mode stays `ask`, but the governed tools are **hidden** from the model as in `plan`, and a call that names one anyway is refused with the *unavailable* text. The model never sees a tool it cannot use.

**Governed classes** (what the floor gates): a write (`fsWrite`), any egress (`http_request` / `web_search` / `mcp_call` / a discovered MCP tool), an `os` action (`read_clipboard` — an un-jailed read of ambient, secret-bearing OS state — and `notify`), and a `run_command` with a model-chosen command. Read-only fs reads + `git_status` are never gated. **Protected paths** (`.git/`, `.relavium/`, `.ssh/`, shell-startup files) are refused in **every** mode including `auto`; only the ancestor `.relavium` component of an exact [host-issued scratch descriptor](../shared-core/built-in-tools.md#host-issued-scratch) has a contextual exemption, with nested floors retained. No mode escapes the `fs` jail / scope tier. An **`Esc`** mid-turn aborts the in-flight turn but **keeps the session alive** (distinct from `/cancel`): it settles one `session:turn_completed` (an `aborted` stop-reason), and returns to idle; a turn the provider had already accepted (returned content) is kept as an interrupted turn ([ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md)) and an Esc before the provider returned anything rolls back the pending message (the full list of rolled-back turns is in the session spec). The once/always memory is **in-memory** and per-session — a `chat-resume` re-prompts. The one-shot `relavium agent run` (non-interactive) runs `ask` (governed actions denied — no approver). On the interactive surface a host tool EXECUTION failure to an **idempotent read** (e.g. a file-not-found `read_file` — the #1 cause is launching `chat` from a directory that does not contain the path) is **fed back to the model** so it can adapt / explain rather than ending the turn (`recoverToolFailures`, scoped via `ToolExecutionError.recoverable`); a **governed / side-effecting** failure stays fail-fast. When a turn does die on `tool_failed`, its one-line summary shows a **static, secret-free hint** ("a path may be outside this session's workspace, or the target was unavailable") — never the raw error message (which may carry model / MCP context).

## Context compaction (2.5.F, [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) · [ADR-0081](../../decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md))

A long conversation grows its transcript every turn until it approaches the model's context window. Three
mechanisms bound it — all **append-only** (nothing is deleted; the full transcript always survives for
`/export` and audit) and **resume/reseat-preserving**.

The bound agent's [memory policy](../contracts/agent-yaml-spec.md#conversational-memory) controls
request selection and permission for history operations. Its frozen value survives resume and
model reseat. A policy refusal is shown before any progress indicator or `/trim` bound validation.

- **`/compact`** — model-summarises the earlier conversation into a **session-level summary** and keeps the
  **last exchange verbatim**. An LLM call: it reports the
  token deltas + spend and shows the summary (a lossy, paid operation is inspectable). The summary is produced
  by the session's **own bound model** (no second binding — [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)).
- **Automatic compaction** — measures the projected next request against the first
  attemptable model's authoritative window at pre-send and after-turn entry
  points. Permission follows the bound memory policy; `[chat].auto_compact`
  governs an omitted policy. Automatic operations skip unknown/custom windows
  and self-managed context providers. Pre-send failure preserves and sends the
  original request, suppressing recovery; budget refusal preserves history and
  never trims. Ordinary after-turn summarization failure may use the configured
  deterministic fallback. The [engine contract](../contracts/agent-session-spec.md#measured-compaction-and-one-shot-recovery)
  owns threshold measurement, bounded passes, accounting and failure outcomes.
  Last-turn input usage in the footer is observability, not this trigger.

### Where the summary goes, and why it is not an instruction

The summary is **model output over untrusted input** — the conversation handed to the summariser contains
user messages, tool results, and the contents of every document the session read. It is therefore carried as
**data in the first `user` turn**, never concatenated into the system prompt
([ADR-0081](../../decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md),
superseding [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §1, which wrapped
it in an `<earlier-conversation-summary>` fence and put it in `system`). An XML fence is a formatting
convention the untrusted text can close, not a trust boundary — and the bytes survived a restart, because the
summary is persisted.

Three properties follow, and each is enforced rather than documented:

- **`system` carries authored text only.** `AgentTurnParams.system` is a branded type built solely by
  `authoredSystemPrompt()` from the agent's `system_prompt`, a node's `system_prompt_append`, or a named
  engine-owned prompt. A lint fence reports any assertion that would forge the brand.
- **The summary is `Untrusted<string>`** from the moment the summariser returns it, is re-marked at the
  reconstruction boundary on resume, and is unwrapped in exactly two places — both `user`-role positions.
  The persisted marker row's `role: 'system'` is a **storage encoding only**; no consumer may read it as
  model-facing system authority.
- **The block is separated in-band.** It opens by stating that what follows is generated transcript data
  rather than an instruction, and closes by naming the user's message as what comes next. In-band because
  the OpenAI adapter joins content parts on the wire, so a part boundary would be invisible there — the
  guarantee available on every adapter is the role plus prose. The exact wording is derived from
  `packages/core/src/engine/turn-messages.ts`; it is not restated here.

The summary carries less weight with the model than a system instruction would. That is the deliberate
trade: instruction-adjacent context loses authority so that untrusted bytes cannot gain it.
- **`/trim [n]`** — a deterministic drop to the last `n` messages (default `[chat].max_messages`), **no LLM
  call, no cost**. Also the auto-compaction failure fallback.

**The durable boundary.** Each compaction/trim appends one `role: 'system'` **marker** row carrying the summary
(empty for a trim) + a `compaction_dropped_through_sequence`; original rows are never edited or deleted. On
resume, the summary is the one on the **newest marker that carries one** (a `/compact` — a summary-less
`/trim` marker advances the boundary but never blanks a prior summary), and only rows past the boundary re-enter
the working context — so a compacted session stays compacted across `chat-resume` and a model reseat.

**The summary prompt invariant (the product surface of `/compact`).** The summariser prompt (a fixed, authored
`COMPACTION_SYSTEM_PROMPT` in the engine — the conversation to summarise rides an untrusted user message, never
the authored system prompt) MUST preserve: **open tasks and their state; decisions taken and why; concrete code
identifiers / file paths / commands / values in play; the user's stated preferences; and which tool calls the
conversation records and how each ended** (the bracketed receipts of [ADR-0128](../../decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md),
reported as facts, never obeyed; where a record lists a question the assistant asked and the user's answer, **both are kept — the answer is the user's decision**, [ADR-0133](../../decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md)) and **that a turn ended without an answer** (the bracketed interruption record of
[ADR-0119](../../decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md), reported the same way). A summary that loses
these fails the feature. Under `--json`, an admitted compaction opens `session:compacting` and ends with
`session:compacted`, `session:compaction_failed`, or terminal session cancellation. First-admission
budget refusal opens no moment: manual `/compact` reports the safe cap to its caller, while optional
after-turn refusal emits `session:compaction_budget_refused`. Later refusal closes the existing
moment with `budget_exceeded`, once. These events never create a second user-turn terminal.

**The compaction moment.** The interactive surface shows "⟳ Summarizing conversation… · Esc to
cancel" after actual first admission. `Esc` aborts compaction and keeps the session alive; an
admitted failure clears the indicator through its engine event. Plain progress/refusal notices go
to stderr; JSON stdout remains schema-valid events. Manual unknown/mixed-window compaction first
shows an acknowledged fixed warning that fit cannot be guaranteed. Each pass respects the soft
input bound and every known candidate's actual output reservation/window. Automatic entry points
never use a guessed window. The [engine contract](../contracts/agent-session-spec.md#measured-compaction-and-one-shot-recovery)
owns measurement, four-pass atomic installation, one-shot recovery and idle/active budget outcomes.
A budget refusal preserves history and recommends no automatic trim.

The footer's fullness indicator remains last-turn input usage divided by the bound provider's
authoritative window. It is observability, not the automatic trigger. The host clears its denominator
for unknown/custom endpoints even when a model id matches the catalog, including resume and model
reseat. No soft input bound is displayed as model capacity, and no fullness appears before a turn.

## Input ergonomics (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))

The TTY prompt is a first-class line editor. All of these are **interactive-only** — a plain non-TTY / `--json` driver has no cursor UI, and the two data-moving affordances (`@` / `!`) are treated as a **literal leading character** there (no completion, no shell escape):

| Key | Effect |
|-----|--------|
| `Ctrl+J` | Insert a newline (compose a multi-line message); `Enter` sends. |
| `↑` / `↓` | Recall the previous / next submitted line (at the top/bottom edge of a multi-line buffer); mid-buffer they move the cursor by line. History is per-session (not persisted; a `chat-resume` starts fresh). |
| `Ctrl+R` | Reverse-incremental search of the session history — type to match, `Ctrl+R` steps older, `Enter` accepts, `Esc` cancels. |
| `Ctrl+T` | Toggle the collapsible **reasoning ("thinking") panel** (**2.5.H**; same as `/thinking`) — works mid-turn, so you can expand the model's thinking while it streams. |
| `Ctrl+A`/`Ctrl+E`, `Ctrl+←`/`Ctrl+→`, `Ctrl+W`, `Ctrl+U`/`Ctrl+K` | readline cursor / word / line motions + kills (word-back, to-line-start, to-line-end). |
| `Backspace` / `Delete` | erase the char **before** the cursor. (ink 7 reports the physical Backspace as `key.backspace` and the forward-Delete key as `key.delete`; both fold to a backward delete.) |

**Bracketed paste.** A multi-line paste is received on **ink 7's native `usePaste` channel** (2.6.F, [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)) and appended to the compose buffer as **one block** (embedded newlines kept, CRLF/CR → LF), so it never submits early. A paste is **dropped** while a turn / `!`-shell / submit is in flight or any keyboard-owning overlay/submode is open, and — the fail-closed floor ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — while a **per-tool approval is pending**, so a pasted approval token can never answer it (paste never reaches the approval key reducer). The gate is the shared `pasteIsEditable` predicate the [Home](home.md) also uses, so the two surfaces can never diverge.

Both data-moving affordances use a **pending-attachment (chip) model** (ADR-0061, refined in PR #64): instead of splicing framed bytes into the editor, `@`/`!` content is queued as a compact **chip** shown in a bar above the prompt, and expanded into the shared **UNTRUSTED, nonce-fenced** frame **only at submit** — so the model receives byte-identical framed context while your prompt stays clean. **`Esc` at an idle prompt discards all pending chips.**

**`@`-mention (file-context).** Typing `@` at a word boundary opens a **dir-navigable completion** overlay — arrow/type to filter, `Enter`/`Tab` to descend a directory or accept a file, `..` (or backspace past the filter) to ascend, `Esc` to cancel (restoring the literal keystrokes). Accepting a file inserts a compact **`@path` marker** at the cursor and queues the file as a chip; at submit the file expands into **UNTRUSTED, user-position context** (nonce-fenced `<file>` framing, byte+line bounded so a large file can't freeze the editor) **only if its `@path` marker is still present** — deleting the marker drops the file. The read goes through the **same** `FsCapability` the session's tools use — the workspace **jail**, the sensitive-read **confidentiality floor** (`.ssh` / `.env` / `.aws` / … are never listed nor read), the binary fail-close, and the size cap all apply; a user typing `@path` replaces the `confirmAction` prompt (a stronger consent signal), **never** the floor.

**`!`-shell (command escape).** A message starting with `!` runs the rest as a shell command instead of sending it to the model — through the **one** `run_command` boundary: the mode-aware `confirmAction`, which takes the `[chat].allowed_commands` allowlist as an input and not as a gate before it (each entry a command line split by one quote-aware tokenizer and compared with the argv **element by element**; [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §3) (a card in `ask`, refused in `plan`, a card in `accept-edits` — only workspace file edits skip it — and in `auto` a card unless a fresh remembered grant or an earlier session answer pre-approved the exact argv) → the hardened process arm (`spawn`, `shell:false` — no metachar/glob/`$var` expansion; the command is tokenized to literal argv by the same tokenizer; a line with an **open quote is refused** and left in the editor with a one-line notice, never run to the end of the line). While a command runs the busy indicator names it, with **`Esc` to cancel** (Esc, or the first `Ctrl+C`, aborts the command and keeps the session; a second `Ctrl+C` inside the window ends it). The allowlist **defaults empty**. *(ADR-0118: in an interactive chat a command outside the allowlist no longer fails — it reaches the mode logic under [the mode table](#chat-modes--per-tool-approval-25e-adr-0057), so `ask` and `accept-edits` show a card, `plan` refuses and `auto` shows a card because nothing pre-approved it. The old hint naming the `[chat].allowed_commands` line to add is retired: a dispatch with no approval regime says only `! <command>: not run — it is not allowed here.`, which an interactive chat never produces.)* The command's output is shown **read-only** as a bounded preview and queued as a chip carrying the **UNTRUSTED, nonce-fenced, doubly-bounded** output (the process-arm buffer cap + the injection bound) that rides your next message. The `<command … cmd="…" exit="N">` frame that carries the output to the model, and so into the session history, names the **scrubbed** command line (the line the approval card and the event preview show, [tool-registry.md](../shared-core/tool-registry.md#the-per-tool-approval-seam-confirmactionhook-adr-0057-ea3)), not the line as typed, so a credential typed into the line reaches neither the provider nor `history.db`; the process still runs the typed argv, and the local hint, the busy label and the chip show what you typed. See [config-spec.md](../contracts/config-spec.md) `[chat].allowed_commands` + [built-in-tools.md](../shared-core/built-in-tools.md).

## Streaming

In interactive mode the REPL renders the assistant turn live: streaming token output, tool-call/tool-result lines, and a per-turn cost/duration summary — the same `agent:token` / `agent:reasoning` / `agent:tool_call` / `agent:tool_result` / `cost:updated` event shapes a workflow run renders, carried on the session envelope (see [sse-event-schema.md](../contracts/sse-event-schema.md#session-event-namespace)).

### Reasoning & live-turn feedback (2.5.H)

A reasoning model streams its "thinking" over the `agent:reasoning` event (EA6, host-emit — the `@relavium/llm` seam already carries the reasoning chunks). The REPL renders it as a **collapsible "thinking" panel** (default **collapsed** — a dim `✻ Reasoning · Ctrl+T show` header; **`/thinking`** or **`Ctrl+T`** expands it, works mid-turn). While a turn is in flight the busy line shows **live-turn feedback** — `Thinking… {elapsed}s · Esc to stop` (or `Working…` when there is no reasoning, or while a tool call is still executing) — a whole-second timer + the abort affordance, so a running turn never reads as a frozen spinner. When the bounded live buffer's head scrolls out (the answer or the reasoning) a leading **`…` elision marker** makes the drop **visible**, not silent (the durable session record via the persister keeps the full text — only the live terminal echo is bounded). The completed-turn summary attributes the tokens to the **producing model** (`via {model}`) when a within-turn failover committed a different model than the bound one. The redacted-reasoning case (a provider-withheld block) streams no `agent:reasoning` and shows no panel content (there is nothing to render).

### Actionable error recovery (2.5.H)

A classified **failed** turn is not a session terminal, so the REPL remains live unless a separate infrastructure fault stops the invocation. Unexpected CLI and failed-output faults follow the [failure classification and remedies](commands.md#failure-classification-and-remedies), rather than the ordinary turn-recovery policy. Beyond showing the closed `ErrorCode`, the chat renders a **one-line, secret-free recovery hint** for each operational class that makes the next step + **"the session is still active"** explicit — extending the "say so plainly" philosophy from the 2.5.A capability gap to the transport / quota / limit classes:

- `provider_rate_limit` (429) / `provider_unavailable` — Relavium already retried with backoff + fallback-chain failover; resend.
- `provider_auth` — check the key or **unlock the OS keychain** if it locked mid-session, then resend.
- **context overflow** — a classified `context_overflow` displays the fixed engine facts (attempted model/window and whether tools ran) with one policy-aware remedy in its summary, without a second static hint. The same remedy serves the legacy keyword heuristic on an unclassified/custom-endpoint `validation` message. Under [`memory`](../contracts/agent-yaml-spec.md#conversational-memory) `none`, it suggests a shorter message or larger model, never `/compact` or `/trim`; `window` permits `/trim` and a smaller `window_size` for a **new** session, never `/compact`; `summary` or omitted memory permits both history commands. If tools ran, it tells the user to check their effects before continuing because resending can repeat them.
- `tool_failed` (incl. an **unreachable MCP server**) — the summary names the likely cause (a path / an unavailable target); fix it and resend (no blind retry — a side-effecting tool failure is fail-fast by design).
- `tool_denied` — read the reported reason, check the session's permissions or safety requirements and consult the [denial guidance](#denial-guidance-design--adr-0127); `tool_unavailable` — a host/config gap (the capability arm isn't wired for the session): rephrase to avoid the tool, or wire it and start a fresh session.
- `budget_exceeded` / `turn_limit` / `content_filter` / `internal` — each renders its own actionable one-liner. (`cancelled` settles as `aborted` with no error, and `sandbox_error` / `run_timeout` are WorkflowEngine-only, so none is chat-reachable and none carries a hint.)

The remedy is **always host-authored**; it never interpolates a provider message. The existing vetted provider-status summary is separate from that hint. The classified overflow remedy renders once with the summary; other hints render on the interactive TUI (a yellow line under the summary) and the plain chat driver (`drivePlain`, under `[turn failed: <code>]`); a **one-shot `relavium agent run`** suppresses the hint (its session ends immediately after, so a session-continuity hint would be false), and `--json` stays the structured stream (the consumer branches on `error.code`).

### Denial guidance design — ADR-0127

**Design and local source accepted 2026-11-15.** See the
[implementation checkpoint](../../roadmap/phases/phase-2.6-conversational-authoring.md#adr-0127-final-local-source-acceptance-2026-11-15)
for verification and remaining delivery gates.
[ADR-0127](../../decisions/0127-macos-write-metadata-has-distinct-parent-and-file-profiles.md)
replaces the old generic mode/policy recommendation. Current source includes the
neutral hint and the continuing plain driver's bounded denial explanation;
fresh source acceptance is recorded separately from design agreement.

The presentation boundary receives `error.code`, `error.message` and context;
it does not receive a typed approval-denial reason. `user_rejected` is a private
`ToolApprovalDenyReason` carried by `ToolDeniedByUserError`, whose public code is
also `tool_denied`. It is not a separate turn-error code. A single neutral hint
therefore serves mode, user, scope and host-safety refusals. This intentionally
removes the mode shortcut from the generic hint without changing the `/mode`
command or the actual mode/approval decisions. Do not parse message text to
infer a subtype or add a new public discriminator for this correction.

The exact fixed hint is:

> The tool was denied. Check the reported reason and the session's permissions or safety requirements. Help: https://github.com/HodeTech/Relavium/blob/main/docs/runbooks/troubleshoot-tool-denials.md. The session is still active.

The destination is a compile-time constant, not an error-, model- or
configuration-selected URL; rendering it performs no request or automatic open.
The tracked [troubleshooting guide](../../runbooks/troubleshoot-tool-denials.md)
must ship in the repository with the correction. Local development can use that
file before its `main` URL becomes available after merge.
Before a CLI artifact carrying this URL is published, the guide must exist on
`main` in that release's ancestry and the public URL must resolve to it. Keep
this a delivery check, not a runtime network dependency. A local checkout before
merge uses the tracked guide directly; an unmerged-branch 404 is not evidence
that the profile or a user's permissions are broken. This adds no release
authorization and does not bypass the existing publication guard.

#### Denial explanation trust and output policy

`tool_denied` does not prove that its message is a static host label. The CLI
supports an optional user-written rejection reason, and the registry currently
appends that text to `ToolDeniedByUserError.message`. Thus a denial message can
combine host framing and user-authored data. The present `sanitizeInline`
terminal cleanup by itself does not redact secrets or establish origin. The
corrected producer/display pipeline does not rely on the former static-label
assumption.

Retain the optional typed-rejection experience as user-owned diagnostic text.
In the CLI producer, apply the existing `sanitizeUntrustedInline` pipeline to
the original submitted reason **before** the existing 300-code-unit cap and
before handing it to `ToolApprovalDecision.reject.reason`. If the submitted
input exceeds 4096 UTF-16 code units, omit the entire explanation with the same
fixed too-long label used below. Raw tool-review capture retains one overflow
code point so its input boundary cannot silently truncate a credential before
this omission/redaction decision. This uses the
[finite diagnostic backstop](../shared-core/diagnostic-secret-backstop.md),
not a new detector or a promise that arbitrary personal text/secret fragments
can be recognized. Explain in the denial-entry UI that the submitted explanation
is diagnostic text that can appear in session output, including redirected
output; it is not a private note for the approval editor alone. Never inject a
managed secret, raw native failure or metadata fact into a reason.

Render the complete assembled denial explanation as untrusted text in Home,
standalone TUI and continuing plain chat, regardless of whether it contains a
fixed label or a user explanation. If incoming explanation text exceeds 4096
UTF-16 code units, omit it entirely with the fixed label
`denial explanation omitted (too long)`, rather than printing a truncated raw
prefix. Otherwise use `sanitizeUntrustedInline` on the complete original message
before display normalization/capping, then cap the resulting one-line text to
1024 UTF-16 code units without splitting a surrogate pair, with a fixed elision
mark when shortened. Do not classify message text, infer a trusted subtype,
or treat terminal stripping alone as redaction.

**Add the missing plain-driver explanation line.** Continuing `drivePlain`
must print the sanitized `tool_denied` explanation with its failure code before
the common hint, using that same projection as Home/TUI. A hint pointing at a
reported reason with no reason line is not acceptance. A fixed host mode or
metadata explanation stays understandable; a user explanation stays visibly
diagnostic data and may be redacted. Neither establishes authority to retry.
Do not broadly echo `tool_failed`, unknown error messages or provider text.
The native contract separately owns the
[fixed aggregate preparation explanation](native-filesystem-metadata.md#native-refusal-presentation).
Native details are still reduced to that fixed label at their host boundary;
the display scrubber is not permission to forward raw native errors.

The CLI producer's already-sanitized optional user reason can enter the existing
turn error/event `message` and therefore JSON or existing diagnostic copies.
That redacted-value change is deliberate; the machine stream gets no new field
or human hint. Other embedding hosts remain responsible for their own reason
content under the [approval contract](../shared-core/tool-registry.md#the-per-tool-approval-seam-confirmactionhook-adr-0057-ea3).
No failed-turn retention, return-to-model, retry or mode-authority change is
selected by this guidance work. (ADR-0117 has since been accepted and
implemented with MVP-3b; ADR-0119 is implemented as MVP-3c; its D64 rounds and security sittings are done and the maintainer's acceptance is owed.)

Pin the actual displayed code, sanitized explanation and exact hint in each continuing
driver, using native metadata refusal, an ask/plan restriction, user rejection
and an in-scope/protected-path refusal. Check that a mode restriction remains
understandable and that metadata/uncertain effects do not suggest `/mode` as a
repair. Post-publication proof failures keep the separate
`effect_needs_attention` presentation. One-shot `agent run` still suppresses the
continuing-session hint, and JSON still emits its existing structured stream;
no human hint is inserted into it. Test benign free user text, terminal/bidi/OSC
controls, recognized synthetic credential/header/query shapes, redaction before
the producer/display caps, oversize omission and redirected plain output. Check
the producer's JSON/error value as well as TUI/Home/plain projections; do not
claim complete detection of arbitrary secrets from a successful finite fixture.
No additional error family becomes displayable.

## The question card — MVP-3d ([ADR-0132](../../decisions/0132-the-model-can-ask-the-user-a-structured-question.md))

The model can ask the person a structured question mid-turn with the built-in `ask_user` tool; the tool contract (arguments, bounds,
key table, results) is canonical in [built-in-tools.md](../shared-core/built-in-tools.md#ask-the-user--mvp-3d). What this surface adds:

- **It is a docked card where the approval card sits**, below the live region, with the conversation still on screen above it. The
  rule reads `Question from the agent · not an approval`; the keys are the question keys, never `[Ctrl+Y]`/`[Ctrl+G]`/`[Ctrl+N]`. An open card is the
  person's time, not the turn's: the busy line reads `Waiting for your answer <time> · Esc stops the turn` and the turn's active time
  excludes the wait ([ADR-0129](../../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) §6).
- **It opens in every mode**, `auto` and `plan` included; no mode answers a question, and there is **no timeout**.
- **`Ctrl+C` at the card stops the turn** (and arms the interrupt keymap), as at an approval card; **`Esc` steps back one level**: with the own-answer field open it closes the field, the typed text discarded and the call still pending, and with no field open it stops the turn. `Ctrl+S` skips the call (no bare letter is a command — typing starts your own answer). A session-ending cancel (`/cancel`,
  a second `Ctrl+C` inside the window) ends the session as everywhere else.
- **It appears only on a surface with a person at it**: the standalone chat and the Home wire the delegate; a plain, `--json` or
  one-shot surface wires none, and the model is then never offered the tool.
- **The transcript keeps a record**, built from the answer the card holds: `› Asked: <header> — <question>` and `  └ <choice>` per
  question (the person's own text in quotes), or `› Skipped the agent's question: <header>` (`questions: <header> · <header>` for several; a skipped call stores and lists its headers only, never the question text, because the person may have skipped before reaching it).
  The host's rows start with `›` / `└`, glyphs the plain-text rules refuse in model text, so a long question cannot forge one at a wrap boundary. The
  question and the answer are **also stored with the session** ([ADR-0133](../../decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md)):
  a **resumed** session rebuilds the entry, in the same wording, from the stored record, right after the `ask_user` tool row and before the answer, and a
  later turn — live or after a resume — sees the question and the answer under the `ask_user` receipt
  ([built-in-tools.md](../shared-core/built-in-tools.md#ask-the-user--mvp-3d) owns the record, the session spec owns the request text). A
  resumed turn shows at most 16 such entries and counts the rest; each counts toward the restore budget.
- **Several questions are tabs** (`←`/`→`, Tab / Shift+Tab) ending in a **Review** tab that lists every answer and sends them; one question has
  neither. **Typing anywhere starts your own answer**; in a multi-select question `Enter` in the field *saves* the text and the question stays open
  until the next `Enter` confirms it. The key table is in the [contract](../shared-core/built-in-tools.md#ask-the-user--mvp-3d).
- **A paste goes into the own-answer field** — opening it if the list is showing (one line, cut nowhere: a paste that would pass 500 characters is
  refused whole) — and is ignored on the Review tab; it never reaches the composer.

## The interrupt keymap — MVP-4 ([ADR-0115](../../decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md))

One keymap applies to every raw-mode interactive surface: the standalone chat, the chat hosted by the Home, and the Home itself. **`Esc` steps back one level and never arms; `Ctrl+C` stops, and arms.** The pure reducer is `apps/cli/src/render/tui/interrupt-keymap.ts` (an injected monotonic clock; the arming window is one named constant, `INTERRUPT_ARM_WINDOW_MS`, 2 s), and every surface asks it, so no surface keeps its own copy of the table.

| State | First `Ctrl+C` | Second `Ctrl+C` while armed |
| --- | --- | --- |
| An **approval review** is open, on any screen (card, full view, call list) or with its reason or search box open | **Reject the call**, *then* interrupt the turn, then arm | End the session |
| An **`ask_user` question** card is open (own-answer field included) | Stop the turn (the call is recorded cancelled, [ADR-0132](../../decisions/0132-the-model-can-ask-the-user-a-structured-question.md) §5), then arm | End the session |
| A **continue checkpoint** is open ([below](#the-continue-checkpoint--mvp-4-adr-0136)) | Answer "stop" (the engine ends the turn itself), then arm | End the session |
| A turn is running, or a `!` command | Interrupt it — the same abort `Esc` performs — then arm; a running turn also shows `Interrupting · press Ctrl+C again to end the session`, so a turn that is slow to stop acknowledges the press | End the session |
| Idle, **text in the prompt** | Clear the text (pending `@` and `!` chips stay; `Esc` at an idle prompt is what discards them); **nothing is armed**, so one stray press cannot discard a draft *and* arm an exit. A pending `@` mention read is dropped with the text | — |
| Idle, empty prompt | Arm, and the hint line reads `Press Ctrl+C again to end the session` | End the session |
| A details view (`/details`, no approval pending) or any overlay (palette, picker, `@` mention, reverse search, confirmation) | Close it, as it always did; nothing is armed. A confirmation card treats `Ctrl+C` as cancel, never as confirm | — |
| The chat has not finished activating (the standalone chat, before its first frame is acknowledged) | End the session at once: nothing is on screen yet that could be lost | — |
| The Home, loaded (a draft stays where it is while armed) | Arm; the hint reads `Press Ctrl+C again to exit` | Exit the Home (code 0); **a draft in the Home prompt is lost with the process** |
| The Home, still loading | Exit at once: nothing is loaded and nothing can be lost | — |

- **Arming expires.** Two seconds on a monotonic clock, and any other key — one a card swallows included — ends it earlier. `Ctrl+C`, a key, `Ctrl+C` is two first presses.
- **Leaving a chat from a draft takes three presses**, by design: the first clears the draft and arms nothing, the second (now an empty prompt) arms, the third inside the window ends the session, so one stray press can never discard a draft *and* arm an exit.
- **Ending a session works as `/cancel` does**: the in-flight work is aborted, the session is persisted and resumable, and the exit code is 4. In the Home, the chat returns to a freshly read Home.
- **Reject first at an approval.** The pending call is settled as a **user rejection** synchronously, *before* the abort is signalled, so no abort, re-render or race can leave the decision open for another key to answer. The tool never runs and the call is recorded **rejected by the user** — never "cancelled, state unknown". `Esc` and `Ctrl+C` are matched before every answer chord and never approve: at the card they reject (the full view's `Esc` steps back instead, below); a bare letter answers nothing; the input guards gate affirmative answers only, so a rejection is never delayed.
- **`Esc` steps back.** In the reason box and the full view's search box it closes the box (the typed text discarded, the call still pending); in the question card's own-answer field it closes the field; on an approval's full view it returns to the card (the call still pending, nothing answered, no visible frame needed; [ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4); with nothing left to close it stops the turn (an approval is rejected first). A details view or a non-approval overlay closes. `Ctrl+C` inside a box is not "step back": it stops, as everywhere.
- **`Ctrl+D`** on an empty prompt exits the Home at once, except while a hosted workflow run executes (or is cancelling): then it opens the exit guard instead, as the second `Ctrl+C` on the landing does ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, [home.md](home.md)).

**Signals are not keystrokes.** A SIGINT from outside the process (`kill -INT`, or a terminal's `Ctrl-C` while raw mode is off) keeps its process-control meaning: the first one ends a chat session cooperatively (abort, persist, exit 4) and a second force-exits. That includes the plain and `--json` drivers, where the first SIGINT **reaches the turn in flight** — pinned by a test in `commands/chat.test.ts` — and not only the reader. A SIGINT during a `/scrollback` or `/edit` hatch is still dropped (raw mode is off there, so a keyboard `Ctrl-C` is a real SIGINT). The exit `4` is a standalone chat's (and the plain and `--json` drivers'); the **Home** (the invocation-backed host that owns the terminal and hosts the in-Home chat) takes an external SIGINT through its own signal lifecycle and ends with `130`, the chat's `4` being consumed by the Home's mode loop ([home.md](home.md#signal-lifecycle--exit-codes), [commands.md](commands.md#exit-codes)). On a Windows console raw mode may deliver `Ctrl-C` as a signal instead of a key; the manual recipe is [windows-interrupt-evidence.md](../../runbooks/windows-interrupt-evidence.md).

## The continue checkpoint — MVP-4 ([ADR-0136](../../decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md))

Where a person can answer — the standalone chat and the Home's chat, never the plain or `--json` drivers, `agent run` or a workflow node — a turn that has used `[chat].checkpoint_tool_turns` tool rounds **pauses before the next round and asks**, instead of dying at a ceiling. The limits, their defaults and bounds, and the engine's contract are canonical in [config-spec.md](../contracts/config-spec.md#chat-limits) and [agent-session-spec.md](../contracts/agent-session-spec.md#within-turn-limits-and-the-checkpoint); this section is the surface. Nothing happens while the card is open: no provider call, lease or admission is held, so an unanswered checkpoint is a stopped spend, and there is no timeout. The turn's elapsed time and the footer duration exclude the wait, and the busy line reads `Waiting for your answer <time> · Esc stops the turn` (the same line as at every card: it names the generic stop key, and a card's own legend says what `Esc` does in a box).

The card is docked where the approval card sits, a yellow rule labelled `Checkpoint`, one fact line (`This turn has used 32 tool rounds in 3m12s. Continue for 32 more?`) and the keys:

| Key | Does |
| --- | --- |
| `Ctrl+Y` | **Continue**: runs the held round and raises the allowance by one more interval (never past the engine's absolute backstop). It spends, so it clears the approval card's input guards, unchanged (dwell, quiet gap, typeahead window and lockout: [above](#mvp-3-interaction-contract)), against the checkpoint's own frame, and the card must be visible right now; a refused `Ctrl+Y` changes nothing and the card stays |
| `Ctrl+N`, `Esc` | **Stop here**: the hook answers "stop" and the turn ends with `turn_limit` (the held round never runs). Never delayed, valid on a card nobody has seen |
| `Ctrl+C` | The same "stop", and the interrupt keymap is armed |
| any other key | Consumed; typing at the card answers nothing |

A "stop" is an **answer**, not an abort: the turn ends the same way whichever key was pressed, and the live view says so, `stopped at a checkpoint after N tool rounds` on the summary line and `You stopped the turn at a checkpoint. The session is still active; send another message to continue.` as its hint, where a hard stop says `error: turn_limit` and the general limit hint. That wording lives only in the live view: the stored interruption, and so a resumed transcript and what the model reads on the next turn, says the general `turn_limit` sentence, because no history field is added. An abort while the card is open (the session is being ended, a second `Ctrl+C`, a signal) takes the usual cancellation path. The card carries only host-authored fixed text, two numbers and one elapsed time, so it is not a terminal sink for untrusted content. In the alt screen the wheel and mouse selection are not offered while it is open, as at the other cards, and a terminal below 80×24 draws a refusal row instead (`Ctrl+N`, `Esc` and `Ctrl+C` still stop).

Three things a "continue" does not do. It does not reset `max_tool_corrections`, and a checkpoint can fall on a round the model got wrong (an unknown tool, invalid arguments, a repeat of a declined call): a continue then spends at most one more correction round, and the correction budget still ends a failing streak. It does not buy money: a configured cost cap still governs every provider call, so a turn that continues into the cap ends with `budget_exceeded`, not a checkpoint stop. And it does not apply where nobody can answer, where `[chat].max_tool_turns` is the hard stop and holds the round the model asked for rather than running it.

## Tool availability

A chat session uses the **same** built-in `ToolRegistry` as a workflow agent ([built-in-tools.md](../shared-core/built-in-tools.md)): the same tools, the same filesystem **scope tiers**, and the same mandatory guardrails (`run_command` runs only a command the `allowedCommands` allowlist admits where no one can answer — empty/absent ⇒ disabled there — and in an interactive chat a command outside it is a card the person answers (or, in `plan`, a refusal), [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md); `git_commit` behind approval). Per [ADR-0029](../../decisions/0029-tool-policy-hardening.md), a session may only **narrow** the agent's `tools:`, never escalate; a `secret`-typed value is never interpolated into a prompt or tool text; and `http_request` / MCP egress is subject to the same SSRF policy as a workflow. The tool surface, FS tier, and command allowlist for chat all resolve from the `[chat]` block of [config-spec.md](../contracts/config-spec.md), which points back to those canonical homes.

## `--json` session-event stream

> **Implementation status (2.Q).** Live: `selectChatDriver` routes a `--json` invocation (`--json` wins
> over a TTY) to the headless `driveJson` driver, which emits the `SessionEvent` NDJSON stream on stdout —
> all diagnostics (the unknown-slash notice, the `/export` confirmation) go to stderr, so stdout is a pure
> `SessionEvent` stream. `/export` under `--json` emits a `session:exported` event on the stream (routed
> through the session bus, so its `sequenceNumber` stays monotonic with the surrounding events).

For scripting and non-interactive use, `--json` switches the REPL to a machine-readable [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace) stream — one JSON object per line (NDJSON), the chat analogue of `relavium run --json`. Messages are read from stdin (one user turn per line) and the `session:*` events (`session:started`, `session:turn_started`, `session:turn_completed`, `session:cancelled`, `session:exported`, and — ADR-0062 — `session:compacting` / `session:compacted` / `session:trimmed`) plus the per-turn `agent:*` / `cost:updated` events are emitted on stdout, each carrying the `sessionId`; an input-stream EOF ends the session with the `session:cancelled` terminal and exit code 4:

```bash
echo "summarize ./README.md" | relavium chat --agent code-reviewer --json
```

The session namespace is **disjoint** from the run namespace (keyed by `sessionId`, not `runId`); consumers route purely on the `type` discriminant (see [sse-event-schema.md](../contracts/sse-event-schema.md#session-event-namespace)).

## Exit code 4

A `relavium chat` REPL ends with code **`4`** — the canonical **chat-session-ended** code defined in [commands.md](commands.md#exit-codes) — on any of: `/exit`, `/cancel` (or a **second Ctrl+C** inside the arming window in TTY mode, or the first SIGINT from outside the process in the plain and `--json` drivers), or an **input-stream EOF** (the user closes stdin — in plain non-TTY mode, or under `--json`). This distinguishes deliberate session end from workflow and turn outcomes. Bad arguments retain exit `2`; an ordinary classified failed turn follows the recovery policy above. An unexpected CLI crash or failed output instead uses infrastructure exit **`9`**, with the [canonical classification, precedence and inspect-before-repeat remedy](commands.md#failure-classification-and-remedies). The one-shot `relavium agent run` is **not** a REPL: its ordinary turn outcome is `0`/`1`, never `4`, while infrastructure faults still use `9` and external signals retain their documented meanings.

## API keys

Provider keys are read from the **OS keychain** exactly as for `relavium run` — via `@napi-rs/keyring`, never plaintext, never in a session row, a message, or an event payload ([ADR-0019](../../decisions/0019-cli-node-keychain-library.md), [add-a-provider-key.md](../../runbooks/add-a-provider-key.md)). The user's own conversational content typed into a session is the user's data and is persisted in the CLI `history.db` (**unencrypted at rest**, guarded by `0600`/`0700` OS permissions per [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md); the desktop surface uses SQLCipher); it is not a managed secret (see [agent-session-spec.md](../contracts/agent-session-spec.md#tools-secrets-and-security-scope)). No key ever crosses the `@relavium/llm` seam into message history. _`read_media` input access (the in-chat media read tool, D12) is a separate, security-reviewed follow-up — it is not yet wired in 2.M._

## Export to workflow

`/export` (interactive) and `relavium chat-export <sessionId>` drive the **one** export contract: the session's assistant turns become a linear chain of `agent` nodes and the persisted text and content-free structural tool history are preserved as YAML metadata, for review before commit ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). The two differ in where they write — `/export` into the project's `workflows/` under the title slug (MVP-A3), `chat-export` into `<sessionId>.relavium.yaml` in cwd unless `--out` says otherwise — and in their provenance side-effect: `relavium chat-export` additionally marks the session row `status: exported` and records the written path (a durable provenance mark surfaced by `chat-list`); the in-REPL `/export` writes the scaffold but does **not** mark the row, since a later turn's persist would clobber the marker. The mapping is owned by [agent-session-spec.md](../contracts/agent-session-spec.md#export-to-workflow); it **produces** the format owned by [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md). Parallel / conditional / loop structure is not auto-inferred — the export is a **scaffold**.
