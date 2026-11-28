# `relavium chat` — Agent Session REPL

> Last updated: 2026-11-27

- **Status**: Reference — the whole chat family is live: the interactive REPL + `--agent`, `/exit`/`/cancel`, exit code 4, durable persistence (**2.M**); `chat-resume` (**2.N**); `chat-list` (**2.O**); `chat-export` + the in-REPL `/export` (**2.P**); `chat --json` + `agent run` (+ `--fixture`) (**2.Q**); the chat modes + fail-closed per-tool approval (**2.5.E**); and the mid-chat **`/models` reseat** + per-message `modelId` attribution + the `/effort` control (**2.5.G**) — this page is the reseat's behaviour home
- **Surface**: CLI (`relavium chat`)
- **Scope**: Phase 1 design, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [commands.md](commands.md), [home.md](home.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0026-session-export-to-workflow.md](../../decisions/0026-session-export-to-workflow.md), [../../decisions/0057-cli-chat-modes-and-per-tool-approval.md](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md), [../../decisions/0059-cli-mid-session-model-reseat.md](../../decisions/0059-cli-mid-session-model-reseat.md), [../../decisions/0063-cli-config-write-contract.md](../../decisions/0063-cli-config-write-contract.md), [../../decisions/0064-live-model-catalog.md](../../decisions/0064-live-model-catalog.md), [../../decisions/0066-normalized-reasoning-effort-control.md](../../decisions/0066-normalized-reasoning-effort-control.md)

`relavium chat` is the CLI's **agent-first entry point** — a multi-turn conversational REPL with a single agent, sitting beside `relavium run` on the **same** engine. Both are entry points into `@relavium/core`: `run` drives a workflow DAG, `chat` drives an [agent session](../contracts/agent-session-spec.md), and they reuse the same `ToolRegistry`, the `@relavium/llm` seam, and the event bus (see [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). This document is the command-surface reference for the chat REPL; it **cites** the session contract rather than restating it.

Interactive assistant answers use the [Markdown display pipeline](markdown-rendering.md)
in both renderers. The person's own turn (bold, with no markdown), notices, reasoning
and tool rows stay plain and sanitized. Color-disabled output retains Markdown source
markers. Tabs expand to eight-cell stops and prose wraps at word boundaries with
whole-grapheme fallback. A tool row shows `…` while the call is pending, then `✓ completed`,
`✗ failed`, `⊘ denied` or `? outcome unknown`. Every row of the transcript stands on
[the transcript grid](#the-transcript-grid-mvp-11-unit-9-2026-11-27): a margin that
holds the speaker marker and a content column that holds the words.

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

Since Step 4b-3 the REPL **defaults on a TTY to the full-screen alternate-screen** mode, with **inline** as the opt-out — **`--no-alt-screen`** (one invocation) or **`[preferences].alt_screen = false`** (durable) ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e; the resolution is shared verbatim with the [Home](home.md)). A non-TTY / `--json` path is always inline (byte-identical). The alt screen renders the transcript through a resize-tracked **viewport** with **scroll-back + auto-follow** — **PgUp/PgDn** page, **Ctrl+Home/Ctrl+End** jump to top/tail, an upward scroll pauses the tail-follow and reaching the bottom resumes it (gated behind any keyboard-owning overlay); a `/clear` or `/models` swap holds the alt buffer across sessions, so it no longer flickers (Step 4b-3). Mouse reporting captures click-drag, so the alt screen runs **its own selection** (ADR-0068 §e, Step 6): drag to select, release to copy over **OSC 52**; the highlight shows exactly what is copied, and that is the content a person sees (the margin's mark and the text form's `> ` are not part of it: [the grid](#selection-copy-and-the-documents)), a brief **`Sent to terminal clipboard` toast** above the footer confirms the copy was emitted (OSC 52 has no acknowledgement — see [accessibility.md](accessibility.md)), dragging at the viewport's top or bottom row auto-scrolls to extend it, a plain click clears it, `Esc` dismisses it while idle, and `[preferences].copy_on_select = false` keeps the highlight without touching the clipboard. Because the alt buffer also has no scrollback, three **copy-and-search hatches** (Step 5d, Step 6e) give the transcript back to the tools you already have: **`/scrollback`** dumps it into the terminal's native scrollback (scroll, search, select, copy — then press Enter to return), **`/edit`** opens it read-only in `$EDITOR` (edits are never read back), and **`/copy`** sends the whole unwrapped transcript to the system clipboard; all three carry the transcript's text form, not the screen's rows ([the documents](#selection-copy-and-the-documents)). The first two suspend the renderer and restore every terminal mode on exit; `/copy` suspends nothing. None is available before the first turn. The full-screen mode is inherently inaccessible to screen readers; [accessibility.md](accessibility.md) documents the trade-off + the inline-renderer escape hatch.

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
- **the default model follows the stored key (MVP-A4).** With no `default_model` at any layer, the default agent's provider is the first of `anthropic`, `openai`, `gemini`, `deepseek` that has a key (keychain or `RELAVIUM_<PROVIDER>_API_KEY`). Every provider gets its **starter model** from the one starter table the first-run setup also uses (`KNOWN_PROVIDERS[id].starterModel`, [ADR-0146](../../decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §6: Anthropic is `claude-haiku-5-5`), so a first chat starts on the model a first setup would choose, and a user with only an OpenAI key reaches a working chat. A `default_provider` set without a `default_model` is ignored, as [config-spec.md](../contracts/config-spec.md) resolves it. The check is a yes/no question to the key resolver and never reads a key into the session; one session build asks it at most once per provider.
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
- the **rendered (on-screen)** transcript **carries too** (2.6.C). The reseated view opens with the conversation you were having, and the switch **notice** — `model changed <old> → <new> …`, with the host's `⇄` in the margin (`<->` without colour; the inline renderer's word `note`, [the grid](#the-transcript-grid-mvp-11-unit-9-2026-11-27)) — lands *beneath* it, so the switch reads as an interruption of a conversation you can still see. This matters most on the **full-screen alt screen**, the TTY default ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e), where the viewport windows the store's in-memory transcript and the alt buffer has **no native scrollback** to fall back on: before 2.6.C the reseated view opened empty and the whole chat vanished from the screen. The **inline** renderer deliberately carries nothing — its lines were already printed by ink's `<Static>` and survive the swap in the terminal's own scrollback; re-seeding them would print the conversation **twice**. (`/clear` carries nothing on either renderer — a fresh start is its entire contract.)

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
| `/help` | List the available slash commands (**2.5.C**). On an interactive chat it opens a scrollable **report popup** (`↑/↓ scroll · [c] copy · Esc close`; [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10); a plain or `--json` chat prints the list as a notice. Typing `/` at an idle prompt instead opens the interactive, filterable **`/` palette** over these commands (in both the chat and the bare Home). |
| `/exit` | End the session cleanly and quit the REPL (**exit code 4**, below). |
| `/cancel` | End the session **terminally** (aborting any in-flight turn). **Ctrl+C** reaches it only as the *second* press inside the arming window ([the interrupt keymap](#the-interrupt-keymap--mvp-4-adr-0115) below), so one stray press never ends a session. The session is **persisted and resumable** via `relavium chat-resume <sessionId>` (2.N). Exits with code 4. For a mid-turn abort that KEEPS the session alive, press **Esc** (2.5.E, below) or the first **Ctrl+C** — that is distinct from `/cancel`. |
| `/export` | Export the session-so-far to a `.relavium.yaml` scaffold (same ADR-0026 contract as `relavium chat-export`). Writes the file where workflows live — `<project>/.relavium/workflows/<id>.relavium.yaml`, where `<project>/.relavium/` is the nearest actual project directory found walking up from the working directory (global `~/.relavium/` and its aliases are excluded by the [project-location contract](commands.md#relavium-init)), or `<cwd>/.relavium/workflows/` when there is no project — with the session title's slug as the id (written into the file as `workflow.id`) (MVP-A3). **On the interactive chat and the Home's chat it opens a confirmation popup first** ([ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6, §10; MVP-11 unit 6): the question `Write this chat to a workflow file in the project?`, the file (project-relative), whether it is a new file or this session's own earlier export rewritten in place, and the review notice's sentence; **only `Ctrl+Y` writes** (through the popup host's chord guard), while `[Ctrl+N] Write nothing` and `Esc` write nothing; a persistent Done step then names the file written, or says that nothing was and why (`Enter` or `Esc` closes it). A turn in flight when `Ctrl+Y` arrives, or a target that moved since the popup drew it, writes nothing and says so. **Nothing goes into the transcript or a notice.** On the plain driver it writes at once and prints the path and the command that runs it (``run it with `relavium run <id>` ``) on stderr. Under `--json` no path line or run hint is printed: the path is the `session:exported` event's `workflowPath`. A refusal (`export failed: …`) on the plain and `--json` drivers goes to stderr. It never overwrites another workflow: the id is the first of `<slug>`, `<slug>-2`, … that no catalog file or `workflow.id` already holds. The one file it rewrites is the session's own earlier export, recognized from the file itself — a regular file, never a link, at one of those names whose `metadata.relaviumExport` names this session — so a later `/export` of the same session updates it in place, atomically, across a `/models` reseat, a `chat-resume` or a Home reopen, while a workflow put where an old export used to be is left alone. The rewrite re-checks the file just before it replaces it, so a file changed or replaced after it was recognized is left alone too and the export moves on through the same names: another of this session's own exports there is rewritten instead, otherwise the next free id is taken; the check compares the file's bytes as well as its stat, so a same-length rewrite is caught too; a swap in the moment between that check and the replace is not detected. Under `--json` it emits a `session:exported` event on the stream. It does **not** mark the session row `exported` (a later turn's persist would clobber that) — use `relavium chat-export` for the durable provenance mark. **Live (2.P / 2.Q).** |
| `/permissions` | Open the **permissions popup**: the commands **remembered for this project** and the ones **approved for this session**. `d` (or `Delete`) then `Enter` withdraws the highlighted row, `Esc` or `Ctrl+C` closes; it takes no argument ([ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2; [ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2; [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10; [command-permissions.md](command-permissions.md#in-the-chat-permissions-a-popup)). In a chat it lists both; the bare Home's `/permissions` opens the same popup with the project's list and the repository's allowlist only ([home.md](home.md#permissions-on-the-bare-home-mvp-4-step-7-2026-11-21-a-popup-since-mvp-11-unit-8-2026-11-27)). On a plain, `--json` or one-shot chat it says remembered commands are not available. |
| `/agent` | Show the **agent this chat is bound to**, read-only ([ADR-0140](../../decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3): its id and name (and that it is the built-in chat agent, when it is), the **provider and model the session runs on now** (a `/models` reseat builds a new session, so it shows the new pair), the temperature, the **session's current reasoning effort** (the tier the footer shows, which `/effort` and the `/models` effort step change on the session and never in the definition; where the definition declares another the row adds `(declared: …)`, as in `high (declared: medium)`, and `not set` means no tier), the tool grant as the definition declares it and the first 240 characters of the system prompt (scrubbed whole before the cut, as the `/agents` page does). **Two facts come from the host, not from the definition.** A declared tool this chat's host does not wire (the model is never offered it: a question tool where no one can answer a card, a delegate wired nowhere) is **marked `(not available in this chat)` after its name**, and the list then leads with how many are offered (`7 of 9 offered: read_file, …`); a grant the host wires whole shows no mark and no count, and the grant itself is never changed, only marked. In the popup the list wraps between names and nothing is left out; the plain chat's notice, which must fit its lines, cuts *offered* names (one `…` for each run) before it leaves out a mark, and never splits a name from its mark over two lines. The marks describe the host's wiring, not the chat mode, which hides governed tools per turn. A **`File` row** (after the name) gives the label of the file the agent was read from, **relative to the working directory and never absolute**, cut from the front when it is long so the file's name stays; it is shown for a chat started with `relavium chat --agent <ref>` or from the Home's `c` on an agent's page, and not for the built-in agent, a resumed session, or a chat after `/clear` or a `/models` reseat, which hold the definition and not the file. Nothing else of the definition is shown: no absolute path, no full prompt, no key. An interactive chat (standalone or in the Home) opens it as a **report popup** ([ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §10; MVP-11 unit 4, which replaced the docked sheet; unit 8 removed the sheet's slot): one scrollable page with one field to a row, nothing cut (a long tool list or prompt head wraps where the sheet cut with `…`), `[c]` copies the page, `Esc` or `Ctrl+C` closes it, and every other key and a paste are dropped; below 80×24 a note replaces it. The view is made afresh each time the popup opens. A plain, `--json` or one-shot chat has no popup and prints the same fields as a notice on stderr, never on the `--json` stream. It takes no argument and reads and writes nothing. |
| `/workflows` | List the project's discovered workflows + agents (the disk catalog) (**2.5.C S4**): on an interactive chat as a scrollable **report popup** (an invalid entry is flagged and never dropped; `[c]` copies, `Esc` closes; [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10), on a plain, `--json` or one-shot chat as a **notice**. A project-less cwd is reported, not an error. This is the chat's own command: the bare Home's `/workflows` is the [catalogue popup](home.md#workflows-the-workflows-popup-mvp-11-unit-8-2026-11-27) with a detail step. |
| `/cost` | Show the session's spend as a **report popup** on an interactive chat (a **notice** on a plain, `--json` or one-shot chat) — the total, then a **per-model breakdown** (**2.5.C S4**; the breakdown is **2.6.C**, [ADR-0070](../../decisions/0070-durable-per-model-session-cost-attribution.md)). Read from `history.db`, not from memory, so a **resumed** session shows the whole session's models and not just this process's. A `$0` row with real tokens is flagged *price unknown* — an unpriced model is not a free one. A model carrying a **conservative budget commitment** ([ADR-0074](../../decisions/0074-durable-conservative-budget-commitments.md) §1/§4 — money a provider may already have billed for an attempt that returned no trustworthy usage) shows it as *estimated, possibly billed*, **never added into the spend figure or the share**; a commitment made before any completed call on that model reads `(no completed call)` rather than claiming `0 calls`. That is what explains a `$0.0000` session whose next turn the cap refuses. In the popup `[r]` is offered only while something is held and goes to a confirmation line answered by `Ctrl+Y` (a typed `/cost --release` opens on that line); a persistent step then names what was released. Chat-only. |
| `/mode [name]` | Switch the chat **mode** — `ask` / `plan` / `accept-edits` / `auto` (**2.5.E**, below); bare interactive `/mode` opens the [mode popup](#the-mode-popup-mvp-11-unit-8-2026-11-27): one list, where `Enter` uses a mode in this chat and `[s]` saves it as the startup default. In idle Home it configures startup only ([home.md](home.md#mode-on-the-bare-home-mvp-11-unit-8-2026-11-27)). `Shift+Tab` cycles current modes without saving. |
| `/thinking` | Show / hide the collapsible **reasoning ("thinking") panel** (**2.5.H**; also `Ctrl+T`). A pure UI-view toggle (no session/engine effect); the panel is only rendered while the model is actually streaming reasoning. Default collapsed. Chat-only. |
| `/doctor` | Run a setup health check (**2.5.C S5**). On an interactive chat or the bare Home it is a **report popup** ([ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §8): a heading with the dominant outcome and one row per check (a glyph, a name, a status word and a short detail); a plain or `--json` chat prints the same checks as a text **notice**. Fast tier: OS keychain reachable · config valid · wired tool capabilities · provider keys (a presence check that warns at zero; it displays no key and sends nothing). `↑/↓` select a row, `Enter` shows its detail and what to do, `[r]` runs the fast checks again, `[c]` copies, `Esc` closes. The **deep** tier is `[d]` (or a typed `/doctor --deep`, which opens the consent line directly): it adds provider-key validation (a bounded, **redacted** live ping per configured key — the key never reaches the output) + the live session's MCP status (the bound agent's connected servers + any tools the manager dropped). It leaves the machine, so it is a **consent line** that names the origins that would receive each key and is answered only by `Ctrl+Y`, after the line was drawn and measured; `Esc` aborts a run in flight. The `--deep` MCP tier is **read-only** — it reports the already-connected session, never a fresh connect/spawn (a security-review decision). Available in **both** the chat and the bare Home (pre-chat diagnostics; the Home's popup offers the deep tier as well). |
| `/compact` | **Model-summarise** the conversation so far to reclaim context — an LLM call ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md), **2.5.F**; see § Context compaction below). Reports context-token estimates, known summary-token observations (qualified when incomplete), and a summary preview as a **notice**. Acknowledged summariser money remains in the session's qualified totals and `/cost`. Checks the bound agent's [memory policy](../contracts/agent-yaml-spec.md#conversational-memory) before showing progress; a policy refusal names why without starting a call. Effect `write` (spends tokens). Chat-only. |
| `/trim [n]` | **Deterministically** drop older messages down to the last `n` (default `[chat].max_messages`), **no LLM call** (ADR-0062, 2.5.F); keep a user boundary even if that retains an extra message. Checks the [memory policy](../contracts/agent-yaml-spec.md#conversational-memory) before missing/invalid-bound notices. When permitted, a bare `/trim` with no config bound prints an actionable notice; a bound larger than the history is a reported no-op. Chat-only. |
| `/models` | Open the live catalog **picker** ([ADR-0064](../../decisions/0064-live-model-catalog.md)) — **interactive-only**. In a **chat**, picking a *different* model **reseats** the live session onto it; re-picking the model you are already on only sets its effort tier (a per-turn override, **no reseat**). In the **bare Home** it writes the next session's defaults instead. Both paths — and what a reseat does and does not carry — are in § [Model reseat](#model-reseat-models) (**2.5.G**). Opening the picker changes nothing — the effect lands only on an explicit selection. Under `--json` / a plain non-TTY there is no overlay: nothing is reseated and an actionable hint is printed. |
| `/effort [tier]` | Set the **reasoning-effort** tier — `off` / `low` / `medium` / `high` / `max` ([ADR-0066](../../decisions/0066-normalized-reasoning-effort-control.md)); bare `/effort` shows the current tier + the options. A **per-turn session override** on the live session — **no reseat** (unlike `/models`), and it does **not** survive one. Always available in a chat: on a model with no controllable reasoning tier the command says so and the tier is stored but **inert** (gated off at send) — it is the picker's effort sub-step and the footer indicator that are capability-gated, not this command. Chat-only. |
| `/details` | **MVP-3 Step 2 accepted on development:** inspect bounded live tool-call details using the [shared interaction contract](#proposed-mvp-3-interaction-contract). Interactive chat-only; a plain/JSON session prints a fixed remedy. It executes no tool, sends no model message and reconstructs no historical preview. |
| `/scrollback` | Dump the transcript, in its text form ([the documents](#selection-copy-and-the-documents)), into the terminal's **native scrollback** (to scroll, search, select, copy — Enter returns). One of the three copy-and-search **hatches** described under § [Entry](#entry) — the alt screen has no scrollback of its own. Not available before the first turn. Chat-only. |
| `/edit` | Open the transcript **read-only** in `$EDITOR` (to search or copy), in its text form ([the documents](#selection-copy-and-the-documents)). See the hatches under § [Entry](#entry). Not available before the first turn. Chat-only. |
| `/copy` | Copy the **whole unwrapped transcript** to the system clipboard over **OSC 52**, in its text form: the person's turn starts with `> `, and there is no margin and no blank row between turns ([the documents](#selection-copy-and-the-documents)); a mouse selection copies the content a person sees instead. See the hatches under § [Entry](#entry). Not available before the first turn. Chat-only. |
| `/clear` | Start a **fresh conversation** — end the current session (**persisted + resumable** via `relavium chat-resume <sessionId>`) and swap in a new one under a new `sessionId` ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §7, **2.5.F**). Effect `destructive`; the fresh session resolves the configured starting mode, preserves its bound agent grant and resets budget/turn/cost totals to zero (the old totals stay on the resumable row). Its notice names the prior session + the exact resume command. **Interactive-only** — rejected under `--json` / plain non-TTY, where one machine stream is one session lifecycle ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Works in `relavium chat`, `chat-resume`, and the in-Home chat (swap in place, staying in chat); in the **bare** Home (no live session) it is an honest "nothing to clear" notice. |

An unrecognized `/…` command — or an **undeclared argument** on a known one (`/exit now`) — prints a one-line, secret-free notice and the prompt returns. A command may accept flags (`/doctor --deep`) or a single positional value (`/mode plan`); the `/` palette runs the bare form, so a flag/value is opt-in by typing it. The idle footer surfaces `/ for commands` at an empty prompt (2.5.C S6). In a TTY, **Ctrl+C** is the interrupt keymap's, not `/cancel`'s: the `ink` REPL runs in raw mode, so the kernel does not raise SIGINT and the REPL handles the key itself — the first press interrupts, clears or arms, and only a second press inside the arming window ends the session ([the interrupt keymap](#the-interrupt-keymap--mvp-4-adr-0115)).

## The transcript grid (MVP-11 unit 9, 2026-11-27)

([ADR-0145](../../decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker) §6, [ADR-0146](../../decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4; the plan is [MVP-11 §4.8](../../roadmap/phases/mvp-11.md#48-the-chat).) The interactive chat, the stand-alone one and the one the Home hosts, draws on **the grid the Home's landing uses**: a **margin** on the left that belongs to the host, and a **content column** that holds every word a person or a model wrote ([glossary](../../glossary.md#core-concepts): *Margin*, *Content column*, *Speaker marker*, *Grid*). Both renderers use it. The plain (non-TTY) driver and `--json` have no grid.

### The margin and the content column

| Terminal columns | Margin | Content column | Text (`columns − margin`) |
| --- | --- | --- | --- |
| 80 | 6 | 68 | 74 |
| 99 | 6 | 87 | 93 |
| 100 | 8 | 84 | 92 |
| 112 | 8 | 96 | 104 |
| 200 | 8 | 96 | 192 |

The margin is the Home's: 6 columns from 80 to 99 columns and 8 from 100. The content column starts where the Home's wordmark starts and is as wide as the Home's rail, `min(96, columns − 2 × margin)`; it is left-hung, so a wider terminal leaves its room on the right. **The row budgets do not move** (16 transcript rows at rest at 80×24, nine beside a sheet): the grid changes the width of the text, not the number of rows.

A terminal too narrow for a margin and sixteen columns of text gives the margin up first: it is `floor((columns − 16) / 2)` below 28 columns (5 at 26 and 27, 4 at 24 and 25, 3 at 22 and 23, 2 at 20 and 21, 1 at 18 and 19, none at 17 and below). A mark or a word is drawn only where the margin has room for it (`›` and `>` from 22 columns, the longest inline word from 28); otherwise the margin is blank. A width that is not a usable number (a suspended terminal reports 0) has no grid: the transcript draws no rows until the terminal reports a width, and the chrome keeps an 80-column grid meanwhile.

### The speaker marker

Who spoke is told in the margin, and **a row's mark is data the host sets, never a character of the row's text**: each row carries a role from a closed set (your turn, a tool call, a model switch, a reply, a notice), the host sets it from what the entry is, and the margin cell is drawn from the role alone. No string a model or a person wrote can stand where a mark does; a reply row that begins with `›` is text in the content column.

- **The person's turn** has `›` in the margin on its first row only, bold and in the accent colour (a bold `>` without colour); its words are bold on every row of the turn (bold is not colour). The mark ends three columns before the text: the glyph, two blank columns, then the text (the fourth column at 80 columns, the sixth from 100).
- **A reply** is plain and unmarked: its margin is blank (the inline renderer's word is below).
- **A tool call** is one row per call. The `▸` (`->` without colour) is in the margin, dim, and the words are in the content column: `<tool id> ✓ completed`, `✗ failed`, `⊘ denied`, `? outcome unknown` or `…` while it is pending, then ` → <target>` and ` · +N -M` where the call has them. A call longer than the column wraps and hangs. A tail `N omitted calls` is a dim row of its own with no mark. The live region draws a running call's row the same way, in amber.
- **A notice** is dim and has no mark. Two notices the host builds have one, named by the host when it builds them and never read from the text: the question record's `›` (dim, not bold) and the model switch's `⇄` (`<->` without colour), each on the first row of every line of the notice that starts with it.

### Wrapping and blank rows

- Every entry is laid out at the content column's width, markdown included. The finished reply, the streamed answer and a reply without colour wrap alike, so a reply does not reflow when its turn completes.
- A wrapped row **hangs**: it starts at the text, with a blank margin, and never begins with the space the line broke at. A line after a newline keeps its own leading spaces, and so do the rows of a code block.
- One blank row stands before each turn of the person and each reply, except the first entry. A tool entry and a notice hug the entry above, and an entry that draws no row (a reply with neither words nor a summary) draws no separator. A reply with no words of its own (a turn that stopped before its first token) has no body row: its summary is its first row.
- A reply's summary line and its recovery hint are drawn at the content column, without the leading space the documents keep.

### The chrome on the grid

The rest of the frame stands on the same grid in both hosts:

- **The header**: the wordmark at the content column and the session title ending at the content column's last column. Inline, the header is written once, before the chat mounts, at the margin; so is the intro of a resume, a `/clear` or a model switch, wrapped at the content column.
- **The prompt**: the editor is a box exactly the content column wide, so its own wrap and Ink's are one wrap; its `›` is the prompt's own, in the content column's first column, not the speaker marker. The thin rule is the content column wide, and the attachment bar is fitted to it.
- **The status line, the hint, the leading row (the copy confirmation and the warnings) and the notification** are at `columns − margin`, the Home's budget: the status line is fitted to what the terminal leaves right of the margin, because the narrower content column would make it drop more of its fields.
- **The `/` palette**: its list, its query line and its rule are in the content column; its legend row is at `columns − margin`.
- **The live region**: a running call's row has its `▸` in the margin; the streamed answer, the reasoning panel, the busy line and the interrupt note are the content column's, with a blank margin. The history search and the `@` completion list below the prompt are in the content column too.
- **The turn above a docked sheet** stands the same way, its rows cut at the content column, and its row budget does not move.

A sheet's rule and key rows and a popup keep their own geometry ([ADR-0147](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md), [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)); in the full-screen renderer a standard popup is as wide as the content column up to 76 columns, so at 80×24 its box stands exactly over the content column.

### The inline renderer's words

The inline renderer, the accessible mode, draws the same rows with the margin in its **word** form: `you` on the first row of the person's turn (and of the question record), `agent` on the first row of a reply, `tool` on each call's row and `note` on the model-switch notice; an ordinary notice has none. The words are a closed set of plain ASCII, so they read the same in every terminal and locale (nothing in the CLI detects the locale); they stand at the margin's first column with at least one blank column before the content, and `you` is bold in the accent as the glyph is. A wrapped row hangs under the text.

```text
you   Add the VAT to total() and keep the rounding as it is
tool  read_file ✓ completed

agent total() now multiplies the net amount by the rate and adds the
      result to the amount, rounded as before.
```

**A row that begins with a role word gets its entry's word.** A screen reader does not announce indentation, so a wrapped row of a reply that begins `you …` would be heard as the person's turn. A row of a reply, a tool call or a notice whose text begins with one of the four words (any case, a whole word, after white space, zero-width or format characters, combining marks or box-drawing gutters) carries its own entry's word instead: `agent` for a reply or a tool row, `note` for a notice, so the row reads `agent you should rerun …`. The person's own turn is excluded: its words are theirs. In the full-screen renderer these two roles have no glyph, so the margin of such a row is blank. [accessibility.md](accessibility.md#the-escape-hatch--the-inline-renderer) says what this reads like.

### What the screen does with the words of a person and a model

The margin guarantee is exact in the layout, but a terminal can draw a character wider than the layout measured it, and then the end of a row wraps into the margin where only the host's mark belongs. So the text of a person and a model is changed on its way to the screen, **before** it is laid out (a width that changes after the layout breaks the layout), in these ways ([ADR-0145](../../decisions/0145-the-cli-has-one-surface-language.md) §6 and its notes; the widths were measured on tmux 3.7b, one code point at a time and as sequences):

- **Fillers and orphan marks are dropped.** The default-ignorable code points (the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the soft hyphen, U+034F and their kin) measure 0 columns in the layout and a terminal may draw one or two; a combining mark that starts a row, a lone surrogate, the other format characters and four zero-counted code points (U+302E, U+302F, U+16FF0, U+16FF1) go too. Tabs are expanded to spaces.
- **Some ordinary text is drawn differently so that it is never wider than counted.** Every skin tone is not drawn (a terminal joins a tone to only about half of the modifier bases); the nine text-default emoji bases (☝ ⛹ ✌ ✍ 🏋 🏌 🕴 🕵 🖐) are written with U+FE0F; Thai and Lao are drawn decomposed (a drag selection copies that form); U+0600 and U+06DD are dropped; a lone regional indicator carries a zero-width non-joiner and a flag never does; a joiner sequence stays joined only if it is a recommended emoji sequence once untoned. **The documents keep every byte.**
- **The measure counts what a terminal draws, by default.** The width library counts a grapheme cluster by its first code point (a Hindi conjunct `क्ष`, a flag with a half-width mark after it, a Kirat Rai vowel chain are each one cluster to it) while a terminal draws every spacing code point (`राष्ट्रीय स्वास्थ्य मिशन` is 10 to the library and 15 on tmux). The layout therefore counts a cluster of more than one code point as the larger of the library's width and the sum over its code points, except a short list of joins that tmux was shown, exhaustively, to draw in the library's width (an emoji sequence from the standard list without a skin tone, a Hangul syllable block); a mark that a terminal draws in no column adds nothing. The measure is never less than Ink's, so a row measured to fit is never re-wrapped; on tmux natural text is counted exactly (measured over 72 sentences in 35 scripts: no script is counted wider than drawn except Sinhala, by 4.5 %). Text that Ink would fit itself (the `@` picker, the history search, the native prompt, the palette query, the draft, the denial reason, the run screen) is fitted by this measure first, and every cut keeps whole clusters only, drawing `?` for a cluster wider than the whole row.
- **The host's three glyphs are shown as a space.** `›`, `▸` and `⇄` in text that is not the host's (a reply, a tool's id or target, the person's own words) are drawn as a space, one column for one: a reply line `› next` reads as `  next`. A `✓`, a `●`, a rule and the plain `>` are left alone.
- **A full-screen cell clips to one row** instead of wrapping, so no display line can become two physical rows.
- **The consent surfaces escape instead of dropping.** The approval card writes a width-risk code point (a tone, a regional indicator, a Thai or Lao AM, a combining mark after a narrow emoji base) as `<U+XXXX>`, so a path can never be shown as a different one; the question card writes all labels of a set that would otherwise draw alike (including after the host's glyphs are blanked) as escaped, one-to-one.

### Selection, copy and the documents

- **A drag selection** (full-screen) copies **the content a person sees**: no margin mark and no `> `, because the rows' text is content only. The highlight covers the text and never the margin; a press in the margin starts at the first column of the text. A separator row copies as an empty line.
- **The documents** (`/copy`, `/edit`, `/scrollback`) are the transcript's **text form**: the person's turn starts with `> `, a reply is its words and then its summary line with its leading space, tool calls come up to four to a row joined by ` · `, and there is no margin, no blank row between turns and no wrap. None of these changes touches them, so the words of a person and a model keep every byte (a tool id or target that holds a marker glyph is blanked where the call's words are built, in the documents too). A model line that starts with `> ` looks like the person's turn there; it is the accepted residual of flat text ([ADR-0145](../../decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker) §6).

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

**Mode popup.** In a live interactive chat, bare `/mode` opens the
[mode popup](#the-mode-popup-mvp-11-unit-8-2026-11-27): one list that uses a mode in
this chat at once, with a separate `[s]` action that saves a startup default. Direct
`/mode <name>` and Shift+Tab change the mode for the next turn without saving. The engine takes the turn policy once, when a
turn starts, so while a turn is running Shift+Tab changes nothing and shows `Mode changes apply between turns — Esc stops the running
turn.`; the status line never names a mode the running turn is not under.
In idle Home, `/mode` opens only startup-default settings, with no imaginary
active session; `/mode <name>` there does not silently save. The saving
confirmation shows the effective start and any project/workspace override before
saving globally, confirms `auto` explicitly, explains approval-free ordinary
writes, and preserves hard path floors. Cancel saves nothing. The hint names Shift+Tab, `/mode` and the configurable
start; persist its acknowledgement only after visible delivery. Fresh/resumed/
cleared/reseated interactive instances bind the configured start and first-frame
status line together, with a fresh approval cache. Preserve frozen agent grants;
older read-only sessions require a new built-in conversation to gain new tools.
The [config contract](../contracts/config-spec.md#proposed-starting-chat-mode--mvp-3)
owns authority and publication outcomes. Non-TTY/JSON never open this picker and remain
effective `ask`; direct mode commands cannot create a headless approver.

**The docked card ([ADR-0129](../../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)).**
While an approval waits, its card sits in the live region below the conversation, which stays
on screen (while it is open the prompt, the status line and the hint are not drawn: the card is the
legend); the full view (`[v]`) and the call list (`/details`) are the **inspection popup** the approval
owns ([below](#the-full-view-and-the-tool-details)). The card takes at most three fifths of the rows (twelve at 80×24) and never
leaves fewer than eight for the transcript (nine at 80×24, the busy row having gone). It shows, in order: the heavy rule `━━ Approval needed ━━━ waiting 0:41 ━━`
([the frame](#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27)); the **title line**, the effect and
target (`Create merhaba.md`, `Edit src/app.ts`, `Overwrite notes.txt`) and, when the row has room, the counts `+3 -1 · 214 bytes` flush right; the **diff body**
(`+n` additions, `-n` removals, context dimmed, coloured when colour is on) sized to the
height; one summary row — the tool's id, the counts when the title line had no room for them, and, when the body is
cut, `… N more lines (M bytes hidden)`; **only the warnings that apply** (a shortened target, masked
values that require inspection, a non-LF or changed line-ending convention or a final newline added or removed, a lock with no
other stated cause), each wrapped to the card's width; and two key rows —
`[Ctrl+Y] Allow · [Ctrl+G] Allow all <file writes|file edits|<tool> calls> this session` and
`[Ctrl+N] Deny · [Ctrl+R] Deny + reason · [v] full diff · Esc stops the turn`. While Allow is locked behind an
inspection the first key row says so (`(Allow is locked until you inspect the change)`) and the second still offers `[Ctrl+N] Deny`. The card's body opens on the first changed line with up to three lines of unchanged context above it, not on the top of the file;
if any changed line is not drawn it adds `⚠ N changed lines not shown — press [v] for the full diff.` and withholds `[Ctrl+G]`. A session-wide
grant is never offered on a partial view, on the card or in the full view: `[Ctrl+G]` appears only while the page drawn shows every changed line, and a call
without a diff whose content is clipped shows `⚠ N lines of this call are not shown — press [v] for the full view.` and offers no `[Ctrl+G]` either
(`[Ctrl+Y]` and `[Ctrl+N]` stay). **Every answer key is a Ctrl chord, never a bare letter** — a letter typed while a turn runs is typing, and "yes do it" would otherwise approve a write with its first character; the question card's `Ctrl+S` skip follows the same rule ([ADR-0132](../../decisions/0132-the-model-can-ask-the-user-a-structured-question.md)), and `Ctrl+A` is deliberately not an answer (the line-start key of every readline habit and the prefix of GNU screen). A bare `y`, `a`, `n` or `c` answers nothing and counts as typed text. An affirmative chord (`Ctrl+Y`, or the first `Ctrl+G` or `Ctrl+O`) counts only when it is a deliberate answer: the card has been on screen for at least 400 ms,
the previous key of any kind is at least 300 ms old, no key that is not a card action (text typed into the composer while the turn ran, a key the card
ignores, text typed into a search, a reason box or a question card's own answer) arrived in the previous 1.5 s, and no card was resolved by a key in the previous 2 s (a held
key keeps extending that window). The session-wide `[Ctrl+G]` takes two steps: the first `Ctrl+G` shows
`Press Enter to allow all … this session · any other key cancels` and Enter 0.8–5 s later with no other key between grants; a second `Ctrl+G`, typed text or a held key never does. `[Ctrl+O]` (Remember, on a command card only) is the same two steps with its own question, `Press Enter to allow this exact command now and remember it for this project` (and `[Ctrl+G]` on a command asks `Press Enter to allow this exact command for this session`), and the same guards. A refused chord is ignored
without effect and the card says why, once. `[Ctrl+N]`, `[Ctrl+R]`, `[v]`, `Esc` and Ctrl+C are never delayed (`Ctrl+N` needs no visible frame, so a card that cannot be read can still be refused); all timing uses a monotonic clock. Typed text can never resolve a card; the one stray source left is a held chord, whose repeats the 2 s lockout refuses. A chord is not an answer inside the reason box, the full view's search box or the call list. The card opens with the amber heavy rule labelled `Approval needed`, which carries the wait clock,
its answer keys are coloured, and the busy line `Waiting for your answer …` is gone (the rule says how long, the key row what `Esc` does);
the wait is excluded from the turn's elapsed time and from the footer's duration, which shows `<active> · <wait> waiting for you`. `[Ctrl+N]` and `[Ctrl+R]` deny and
**continue**; `Esc` (at the card) and Ctrl+C (from anywhere) **stop** the turn and **reject the pending call first** (below); `Esc` inside the reason box or the full view's search box only closes the box, and `Esc` on the full view returns to the card with the call still pending. A clean change shows no zero counts. An ending
token (`<LF>`, `<CRLF>`) is printed only where a line's ending differs from the rest of its side or
from the other side; `<EOF:NO_NEWLINE>` always prints. Everything below about inspection,
masks, exact-frame acknowledgement and resource limits applies to the card and the full view alike.

### The sheet frame and the wait clock (MVP-11 unit 8, 2026-11-27)

([ADR-0147](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md) §1 and §2 and its implementation note.) A question the system asks is a **sheet**: docked where the prompt is, with the conversation above it. Six of the seven wear **one frame**: the approval card (a file edit and a command), the agent's question, the continue checkpoint and, on the Home, the run gate, the budget gate and the exit guard ([home.md](home.md#deciding-a-parked-run-from-the-home-mvp-8-step-3-increments-7a-and-7b-2026-11-23)). The MCP consent card of a hosted leg keeps the native chord card's own frame and its unit-6 `(wait)`. A sheet takes the prompt block's place: while one is open the prompt, its rule, the status line and the hint are not drawn (its two key lines are the legend, its rule the label), and the turn's earlier tool lines, its warnings and its interrupt note stay above it in the transcript rows the sheet leaves (nine at 80×24 beside a 12-row sheet, the newest kept; the host's rows come first, the reasoning panel gets only what is left: its header and at most three indented body rows, even when expanded, so that no model-written row can stand where the sheet's own rule starts). The busy line `Waiting for your answer …` is gone.

- **The rule** is a heavy `━━ <label> ━━━━ waiting 0:41 ━━`, amber for a decision and cyan for the agent's question. Its sides are open (a tray, not a box). Without colour the heavy glyph is `=` and the thin rule `-`, so a sheet's rule and a thin rule stay apart. The labels are fixed host text: `Approval needed`, `Question from the agent · not an approval` (with the `│ ` gutter on every row of model-written text, unchanged), `Checkpoint`, and on the Home `Waiting for you` and `Leaving the Home`. Under the rule come the title line (what it is on the left, the numbers on the right), the body and two key lines whose `Esc` effect is always written.
- **The wait clock** is how long the sheet has waited for the person, and it is **display state that nothing reads**: it is in no snapshot, so the measured-frame acknowledgement and its dwell are untouched by a tick, and no guard counts from it (every guard keeps its own origin: a gate parked an hour ago shows `waiting 1h 07m` and still waits out its dwell). In the alternate screen it shows seconds for the first minute (`waiting 0:41`), then minutes (`waiting 2m`), then `1h 07m`, `1d 03h` and `99d+`. The store's tick is gated, so a pending sheet repaints nothing by itself (apart from a `Ctrl+G` or `Ctrl+O` confirmation on screen, which lapses after five seconds), and one `unref`'d timer owned by the sheet's host repaints the rule when the text changes (once a second, then once a minute). **Inline** the rule carries a static `waiting since 14:05` (with the day, `Nov 25 14:05`, when the wait began on an earlier day, and the year when it is not this one) and **nothing repaints on a timer**. The turn's time still excludes the wait.
- **`(wait)`** marks the keys that are locked. While the answer lockout holds (2 s after the last key that answered a card, so a card that opens right after another one waits it out) the approval's and the command card's `Ctrl+Y`, `Ctrl+G` and `Ctrl+O`, and the checkpoint's `Ctrl+Y`, read dim with `(wait)`, and the row is whole again when it opens; when the marks make the row too wide, the wider grants are dropped from its end, never `Allow`. The question card has none: it has a 250 ms settle and no lockout.
- **Unchanged:** every answer is a Ctrl chord; `Esc` and `Ctrl+C` never approve; the guards and their constants; the measured-frame acknowledgement, now over the new frame; the locks (a partial view earns no session-wide grant); the question's label and gutter.

### The mode popup (MVP-11 unit 8, 2026-11-27)

([ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3 and its 2026-11-27 notes, the maintainer's ruling OD-25.) The principle is that **a popup never asks for a decision that changes nothing**, and that friction is proportional to risk: this chat's mode takes one key, the persistent startup default one confirmation. Bare `/mode` opens **one list and no step rail**. Each row is a mode with its effect in a few words and, at the row's end and never cut, the state words `this chat` (the mode in force) and `startup` (the saved startup default), both on one row when both are true. The list opens on the mode in force, and the highlighted mode's whole effect is stated under it **before** any key is pressed (amber for `accept-edits` and `auto`, which approve without a card, and led by `! ` where colour is off). The keys follow the row:

| Highlighted | `Enter` | `[s]` | Legend |
| --- | --- | --- | --- |
| a mode other than this chat's | uses it in this chat now: the popup closes and one notification states the mode and, for `accept-edits` and `auto`, its one-line effect (a widening leaves its content-free session note and is refused when that note cannot be written; `auto` applies in this one key, which is why its effect is read first) | saves it as the startup default | `↑/↓ select · Enter use in this chat · [s] startup · Esc close` |
| this chat's mode | `keep`: the popup closes, nothing changes and the one-line mode notification is said | saves it as the startup default | `↑/↓ select · Enter keep · [s] startup default · Esc close` |
| the startup default | as above | absent | `↑/↓ select · Enter use in this chat · Esc close` (or `Enter keep`) |

`[s]` is written `[s] startup default` where the whole legend fits and `[s] startup` where it does not; the `Enter` verb and `Esc close` never drop, and `↑/↓ select` goes first when the row is short. `[s]` opens the **only second screen**: the confirmation of the persistent write, the startup-default writer's own flow framed as `Mode · Confirm · Done` (the writer, its disclosure, `auto`'s extra admission and the `startup-writer-*` controls are unchanged). It states what is written (`Writes default_mode = <mode> for new chats.`), the file, whether saving rewrites it (`Saving rewrites the file: its comments and ordering are not kept.`) or creates it, for `auto` the risk sentence before the question and `New chats in a terminal then start in auto mode.` (unless a project or workspace setting overrides it, which the card then names), and `This chat stays in <mode> mode.` It is answered by `Ctrl+Y` (`Save it`) and by nothing else: `Ctrl+N`, `Ctrl+C` and every other key save nothing, the lockout runs from the card's appearance so a held key never confirms, and `Esc` steps back to the list on the mode **in force** (never on the mode that was being saved). A write ends in a persistent *Done* step that names the file and closes with `Enter` or `Esc`; a declined or refused save is one notification. The *Apply to* screen and its "New chats" choice are gone: "startup default" is the one word. A typed argument (`/mode plan`) applies directly, as before. The same rule closes a step in which nothing changed: `/models` with `Already on <model>.` (or, for the default of new chats, `Already the default: <model>`), and `/effort` on the tier in force with `Already at reasoning effort <tier>.` The Home's variant of the list is [home.md](home.md#mode-on-the-bare-home-mvp-11-unit-8-2026-11-27)'s.

### The full view and the tool details

([ADR-0134](../../decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md), drawn as the **inspection popup** by [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §7, MVP-11 unit 8.)
`[v]` on the card and Enter on a `/details` call open **one** page, in **one popup that belongs to the sheet**. The card, its answer keys and its guard are unchanged.

- **The popup.** A large box, `columns − 2` wide and `rows − 1` tall (78 × 23 at 80×24), whose top edge names the page on the left (`Full diff` or `Full view` for an approval, `/details` for the call list and its calls) and where it came from on the right (`from the approval`, `from chat`), and whose bottom edge closes it; the page is drawn across its whole width and has **12 body rows at 80×24** (the target row and the message row of ADR-0134 stay, so the 14 the ADR hoped for are out of reach). It is drawn **in the flow, in the body's place** (the chat is hidden while it is open), in the alternate screen and inline alike, so nothing can be drawn over it. The approval is **not suspended**: it stays pending underneath with its guards running from their existing origins, its answer keys are inactive while the popup holds the keyboard, and an answer can only be given from the popup's own answer rows, on the popup's own acknowledged frame. One geometry function feeds the frame, the page, the required target, the identity and the copy, and the measured-frame acknowledgement measures the popup's **content**: a row one column too wide, or one row too many, makes it taller than the box and is refused, and Allow stays locked.

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
  grants row, and a second row with `[Ctrl+N] Deny · [b] back to the card · [Ctrl+C] stops the turn · Esc back`) and one closing note: the protected-path sentence on an approval,
  `[b] back to the list · viewing never executes a tool · Esc back` on details. One row stays empty.
- **Keys** (none answers anything; one that acts is not typing evidence): `↑`/`↓` or `k`/`j` one listed line · `PgUp`/`PgDn` or
  `Space` a page (a page cut inside a long line continues there) · `Home`/`End` · `Tab`/`Shift+Tab` the next/previous change (a
  run of changed lines; runs six unchanged lines or fewer apart are one, and a change is about 40 listed lines at most; inside a
  change longer than a page `Tab` lands on the next page that shows a changed line not yet seen and `Shift+Tab` on the page that ends on the nearest one above, so none is stepped over) · `/` search · `r` reveal (only where something is
  masked) · `p` every non-ASCII character as its code point (`<U+0131>`; ASCII stays readable) · `c` copy the masked page · `b` back to the card on an approval (back to the list on details) · `Esc` one level back: it closes an open search box, then returns an approval's full view to its card (the call stays pending, **nothing is rejected**, nothing is answered, and no visible frame is needed), and on the card it rejects the call and stops the turn; on details it steps back from a call to the list, and on the list it closes · `Ctrl+C` stops the turn from anywhere on an approval (the legend says `[Ctrl+C] stops the turn`; the exit window it arms is announced once the popup has closed) and closes details. **A mashed `Esc` does not reject by accident**: an `Esc` that arrives within 400 ms of the one that stepped back to the card is ignored (it neither rejects nor stops the turn), and one after that rejects as it does on the card; the guard only ever suppresses a rejection, never an approval, and `Ctrl+C` is never held back. While a session-wide or remember question waits on the full view `Esc` cancels it and steps back too (the legend says `any other key cancels · [Ctrl+C] stops the turn · Esc back`); a screen too small to read says `Terminal too small: enlarge to 80×24 · [Ctrl+N] Deny · [Ctrl+C] stops the turn · Esc back` on the full view and `Terminal too small: enlarge to 80×24 · [Ctrl+N] Deny · Esc stops the turn` on the card. An approval never shows the call list: it opens only for details, which has no approval pending and so no answer rows.
  Scrolling down stops at the last page that begins on a line (the screen ends on the document's last row). A row is measured as the whole string the renderer
  (`string-width`) measures and is never cut by it: a row wider than its page would wrap — one wrapped row uses the spare row and is drawn
  whole, a second makes the frame too tall and it is refused — and a row holds at most three tokens per column, so a run of zero-width
  characters goes on in the next row.
- **The call list**: oldest first, opening on the **newest**; a row is a mark (`✓`, `✗ failed`, `⊘ denied`, `? outcome unknown`,
  `… running`), the tool, what it touched, `+a −r`; never a result (read it in the details view, through the masks). `↑`/`↓`,
  `PgUp`/`PgDn` (ten), `Home`/`End` select; Enter opens a call (in the same popup); Esc closes the list, and on an opened call steps back to the list first.

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

The session's `ToolHost` is bound **full-capability** for its lifetime (fs read+write, process, egress, os); a **mode** is a policy layer on that one instance — **no reseat**, so switching never loses tool context. `Shift+Tab` cycles **`ask → plan → accept-edits → auto`** and `/mode <name>` jumps directly; the active mode is always on the status line (`ask mode`). Absent a configured start, the default is **`ask`**; [starting-mode authority](../contracts/config-spec.md#proposed-starting-chat-mode--mvp-3) governs every new instance. Two layers enforce it: a best-effort per-turn **advertise-filter** (a governed tool is not offered to the model) and the **authoritative, fail-closed `confirmAction` hook**. The names say what the modes do ([ADR-0130](../../decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md)):

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
  Last-turn input usage on the status line (`ctx 18% used`) is observability, not this trigger.

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

The status line's fullness indicator (`ctx <p>% used`) remains last-turn input usage divided by the bound provider's
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

**`@`-mention (file-context).** Typing `@` at a word boundary opens a **dir-navigable completion** overlay — arrow/type to filter, `Enter`/`Tab` to descend a directory or accept a file, `..` (or backspace past the filter) to ascend, `Esc` to cancel (restoring the literal keystrokes). Accepting a file inserts a compact **`@path` marker** at the cursor and queues the file as a chip; at submit the file expands into **UNTRUSTED, user-position context** (nonce-fenced `<file>` framing, byte+line bounded so a large file can't freeze the editor) **only if its `@path` marker is still present** — deleting the marker drops the file. That is one rule, applied after every edit of the draft on both surfaces (the Home's prompts, which draw no chip bar, and the chat): a file stays only while its `@path` marker is a whitespace-bounded token of the draft, so an attachment whose marker was deleted, cleared or replaced is gone for good and a marker typed later is plain text. A held `Enter` that chose a file never sends the message: an `Enter` that would send within 2 s of a pick is ignored and restarts that window, unless another key or a paste came first. The read goes through the **same** `FsCapability` the session's tools use — the workspace **jail**, the sensitive-read **confidentiality floor** (`.ssh` / `.env` / `.aws` / … are never listed nor read), the binary fail-close, and the size cap all apply; a user typing `@path` replaces the `confirmAction` prompt (a stronger consent signal), **never** the floor.

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
  heavy rule (cyan) reads `Question from the agent · not an approval` and carries the wait clock ([the frame](#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27)); the keys are the question keys, never `[Ctrl+Y]`/`[Ctrl+G]`/`[Ctrl+N]`. An open card is the
  person's time, not the turn's: the clock in the rule says how long, and the turn's active time
  excludes the wait ([ADR-0129](../../decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) §6).
- **It opens in every mode**, `auto` and `plan` included; no mode answers a question, and there is **no timeout**.
- **`Ctrl+C` at the card stops the turn** (and arms the interrupt keymap), as at an approval card; **`Esc` steps back one level**: with the own-answer field open it closes the field, the typed text discarded and the call still pending, and with no field open it stops the turn. `Ctrl+S` skips the call (no bare letter is a command — typing starts your own answer). A session-ending cancel (`/cancel`,
  a second `Ctrl+C` inside the window) ends the session as everywhere else.
- **It appears only on a surface with a person at it**: the standalone chat and the Home wire the delegate; a plain, `--json` or
  one-shot surface wires none, and the model is then never offered the tool.
- **The transcript keeps a record**, built from the answer the card holds: `Asked: <header> — <question>` and `  └ <choice>` per
  question (the person's own text in quotes), or `Skipped the agent's question: <header>` (`questions: <header> · <header>` for several; a skipped call stores and lists its headers only, never the question text, because the person may have skipped before reaching it).
  The host's `›` leads each `Asked:` and `Skipped` row: on the screen it is in the margin, dim (the inline renderer's word is `you`), while the entry's own text, and so
  the documents, start the row with `› ` (`> ` when it was built without colour; [the grid](#the-transcript-grid-mvp-11-unit-9-2026-11-27)). The `└` is a glyph the plain-text rules refuse in model text, so a long question cannot
  forge an answer row at a wrap boundary, and the margin is the host's alone, so it cannot forge the `›`. The
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
- **`Esc` steps back.** In the reason box and the full view's search box it closes the box (the typed text discarded, the call still pending); in the question card's own-answer field it closes the field; on an approval's full view it returns to the card (the call still pending, nothing answered, no visible frame needed; [ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4); with nothing left to close it stops the turn (an approval is rejected first). On `/details` it steps back from a call to the list and closes the list; a popup or other overlay closes at its first step. `Ctrl+C` inside a box is not "step back": it stops, as everywhere.
- **`Ctrl+D`** on an empty prompt exits the Home at once, except while a hosted workflow run executes (or is cancelling): then it opens the exit guard instead, as the second `Ctrl+C` on the landing does ([ADR-0139](../../decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, [home.md](home.md)).

**Signals are not keystrokes.** A SIGINT from outside the process (`kill -INT`, or a terminal's `Ctrl-C` while raw mode is off) keeps its process-control meaning: the first one ends a chat session cooperatively (abort, persist, exit 4) and a second force-exits. That includes the plain and `--json` drivers, where the first SIGINT **reaches the turn in flight** — pinned by a test in `commands/chat.test.ts` — and not only the reader. A SIGINT during a `/scrollback` or `/edit` hatch is still dropped (raw mode is off there, so a keyboard `Ctrl-C` is a real SIGINT). The exit `4` is a standalone chat's (and the plain and `--json` drivers'); the **Home** (the invocation-backed host that owns the terminal and hosts the in-Home chat) takes an external SIGINT through its own signal lifecycle and ends with `130`, the chat's `4` being consumed by the Home's mode loop ([home.md](home.md#signal-lifecycle--exit-codes), [commands.md](commands.md#exit-codes)). On a Windows console raw mode may deliver `Ctrl-C` as a signal instead of a key; the manual recipe is [windows-interrupt-evidence.md](../../runbooks/windows-interrupt-evidence.md).

## The continue checkpoint — MVP-4 ([ADR-0136](../../decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md))

Where a person can answer — the standalone chat and the Home's chat, never the plain or `--json` drivers, `agent run` or a workflow node — a turn that has used `[chat].checkpoint_tool_turns` tool rounds **pauses before the next round and asks**, instead of dying at a ceiling. The limits, their defaults and bounds, and the engine's contract are canonical in [config-spec.md](../contracts/config-spec.md#chat-limits) and [agent-session-spec.md](../contracts/agent-session-spec.md#within-turn-limits-and-the-checkpoint); this section is the surface. Nothing happens while the card is open: no provider call, lease or admission is held, so an unanswered checkpoint is a stopped spend, and there is no timeout. The turn's elapsed time and the footer duration exclude the wait, which the card's rule shows as its clock ([the frame](#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27)); a card's own legend says what `Esc` does in a box.

The card is docked where the approval card sits, wearing the [sheet frame](#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27) (an amber heavy rule labelled `Checkpoint`), one fact line (`This turn has used 32 tool rounds in 3m12s. Continue for 32 more?`) and the keys:

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
