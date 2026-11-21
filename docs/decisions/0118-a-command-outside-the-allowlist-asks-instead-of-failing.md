# ADR-0118: A command outside the allowlist asks instead of failing

- **Status**: Accepted — 2026-11-19, by the maintainer, after the revision recorded at the end and two independent document reviews. Implementation: MVP-4 steps 1, 3 and 4 are on `development` (step 4: the command card, *Session* and *Remember* as answers, `run_command` in the default grant, `/permissions`; both review rounds are fixed and recorded below). The D64 rigor tier and a separate security sitting apply (step 3's two review rounds are recorded in the phase register; the second round's verified findings are fixed).
- **Date**: 2026-11-05 (revised 2026-11-06 after the PR #97 review; revised again 2026-11-19)
- **Amends**: [ADR-0029](0029-tool-policy-hardening.md) (a) (an exact allowlist entry is compared element by element), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) (the `!` escape's "allowlist before approval, refused otherwise", and the security reasoning it gave, answered below), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (the session cache for `run_command` is keyed by argv, and an allowlist miss reaches the host as a request), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) (`run_command` joins the default grant now), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) (the allowlist-miss class is realized as a card or a fixed refusal), [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md) (its table gains the command row), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12 (the command card adds one answer chord, Remember), and [ADR-0006](0006-os-keychain-for-api-keys.md) (the keychain holds one more secret).
- **Related**: [ADR-0063](0063-cli-config-write-contract.md), [ADR-0084](0084-consent-before-a-local-mcp-spawn.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [D63](../roadmap/current.md#wave-gating-decisions), [MVP-A15](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)

## Context

In a chat session, `run_command`, both the model's tool and the user's `!` escape, passes
two gates in order. The facts below were read from the code on 2026-11-19.

1. **The allowlist.** `enforcePolicy` checks the `[chat]` allowlist: exact full-command
   strings ([ADR-0029](0029-tool-policy-hardening.md) (a)) plus opt-in globs. A miss is a
   fatal `ToolPolicyError('command_not_allowed')` that ends the turn.
2. **The mode.** If the allowlist admits the command, the mode-aware confirm hook applies
   ([ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md),
   [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md)): in `ask` and
   `accept-edits` a card for a command, in `plan` a refusal that returns to the model, in
   `auto` it runs.

The allowlist defaults to empty, which disables commands. That is a sound floor, and
`run_command` has no argument confidentiality floor, so `!cat .env` shows why. In practice
it is a wall:

- A command the user did not list in advance cannot run at all, even with the user watching
  and willing to approve it.
- The refusal hint asks the user to edit a config file.
- [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
  gives the built-in agent `run_command` only when this card lands, and the default agent's
  prompt still says it has no command execution.

Three defects the first version of this ADR did not know:

- **The allowlist compares a string, not a command.** The policy target is
  `[command, ...args].join(' ')` (`PolicyTarget.command` is one string), so the exact entry
  `cat a b` admits both `["cat","a b"]` and `["cat a","b"]`, and `./s/build.sh --release`
  admits a file literally named `build.sh --release`. An entry typed with quotes never
  matches the tokenised `!` line.
- **The session cache is per tool id** (`ApprovalCache`). An answer for `run_command`
  would approve every later command in the session. "Session like ADR-0057's `[a]`" is
  therefore unsafe for commands.
- **The global config writer is a read-modify-write with no lock**
  (`apps/cli/src/config/write.ts` records it: "last-writer-wins … no lock/CAS"). A
  concurrent `relavium` process can silently restore a revoked grant, and a malformed grants
  section would break every command's config load.
  [ADR-0084](0084-consent-before-a-local-mcp-spawn.md) §5 solved exactly this for MCP
  consent with an append-only NDJSON log, and rejected "a config layer".

The allowlist lives in project and workspace config. Those files arrive with a repository,
so anything persisted there authorizes every future clone. The critic of the 2026-11-04
reset flagged exactly this risk for a "remember this command" choice. A repository's
allowlist can already pre-approve commands for `auto` today; this ADR records that exposure
without widening it.

## Decision

**A command that is not pre-approved shows a typed command card instead of being refused.
"Remember" is stored in an operator-owned file keyed by the project root, never in
repository files, and holds a keyed digest, never the command. `auto` never runs a command
that is not pre-approved. The default chat agent gets `run_command` when this lands.**

### 1. Pre-approval, the mode table and the card

**A command is pre-approved** when any of these holds:

- it matches the effective `[chat]` allowlist, exactly (§3) or by glob, with today's
  layering;
- it matches a **remembered grant** for the current project root (§2);
- the person approved this exact argv earlier in this session ("Session", §2).

> Amended 2026-11-21 (the PR #101 review): the first bullet does **not** hold in `auto`, as the second review round of step 4 ruled (the maintainer, 2026-11-19; that round's note below, which this definition and the table were never rewritten for): a command the repository's `[chat]` allowlist admits is not pre-approved there, because the file is the repository's and not the person's. In `auto` only the **person's own word** pre-approves a command: a remembered grant that is *fresh* (no file write a chat applied has outdated it since, [ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)), or this exact argv approved for this session. A listed command asks, and its card says `Standing: on this project’s allowlist` (the shipped wording; the text below says "on your allowlist"). In `ask` and `accept-edits` the allowlist and a remembered grant change nothing, as the next bullets say. The allowlist keeps its full meaning in a workflow, where it is the only authority.

**What happens, by mode** (the columns are [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md)'s):

| | `ask` | `plan` | `accept-edits` | `auto` |
|---|---|---|---|---|
| Allowlisted or remembered | A card (the command is shown, and its standing says it is pre-approved) | Refused | A card, as `ask` | **Runs** |
| Approved earlier this session (exact argv) | Runs | Refused | Runs | Runs |
| Anything else | **The command card** | Refused | **The command card** | **The command card** |

- **`ask` and `accept-edits` keep asking for pre-approved commands.** An allowlist or a
  remembered grant removes the *unknown*, not the person's per-call consent: a
  repository's allowlist must not turn `ask` into silent execution. Only an explicit
  "Session" answer given in this session removes the card there. `accept-edits` accepts
  *file edits* and nothing else ([ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md) §3).
- **`auto` has a hard edge.** Only a pre-approved command runs there without a card.

> Amended 2026-11-21 (the PR #101 review): the table's first row is wrong for `auto`, and its "Runs" has more conditions than the row says. Read `auto` as: *allowlisted only* — **a card**; *remembered, fresh* — **runs**; *remembered, but outdated by a file write a chat applied since* — **a card** ([ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)); *approved earlier this session (exact argv)* — **runs**; *anything else* — a card. A remembered command whose arguments name a protected path from the chat's working directory also asks. The other three columns are as printed (`ask` and `accept-edits` ask for every command whatever its standing, and only a *Session* answer given in the current chat removes their card; `plan` refuses). The canonical mode table is [chat-session.md](../reference/cli/chat-session.md#chat-modes--per-tool-approval-25e-adr-0057), and the standing and the answers are in [command-permissions.md](../reference/cli/command-permissions.md#the-command-card).
- **`plan` hides `run_command`** like every governed tool, and a call that names it anyway
  gets the fixed mode refusal that returns to the model
  ([ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md)).
- **The `!` escape uses the same table and the same card.** The user typed the command, but
  a typo or a pasted line runs with the same authority. The card is cheap, and one rule for
  both paths is easier to reason about than two. The allowlist hint that told the user to
  edit a config file is retired.
- **Headless paths stay fail-closed.** A plain, `--json` or one-shot surface has no one who
  can press a chord, so `run_command` is hidden from the model there
  ([ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md) §4) and a call
  that names it anyway is refused with the fixed *unavailable* text, which returns to the
  model.
- **A workflow's `run_command` is unchanged in authority.** A workflow's allowlist stays
  the only authority there, with no card and no remembered grants, and a miss still fails
  the node with `command_not_allowed`. A workflow runs unattended. (Its exact entries are
  compared element by element too, §3.)

**How the allowlist miss reaches the host.** With an interactive approval regime present,
the registry's command check no longer throws on a miss. `PolicyTarget` gains the call's
`argv` (`readonly string[]`, beside the string `command` that globs still read), and the
approval request carries that argv (in-process only, never on `agent:approval_requested`,
whose preview object is strict) and a flag saying whether the allowlist admitted it. The
host's hook applies the table above. Without an approval regime the miss throws as today.
This is how [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) §1's "a command
outside the allowlist" returns to the model: as a card, or as the fixed mode or
*unavailable* text, and never as a new denial class that names the allowlist.

**The card shows the command exactly, masked secret spans aside.** It shows:

- the argv, **one argument per row**, each delimited so a leading or trailing space stays
  visible, and spaces and quotes are unambiguous;
- the working directory the command will run in (the directory the host pins, never
  model-supplied);
- one **standing** row: `on your allowlist`, `remembered for this project`, or `not
  pre-approved`, so a person can see when a repository's allowlist already trusts it;
- when they apply, **two warning rows**, each worded as a fact and neither ever refusing a
  command:
  - **runs code** — the command is a *code carrier* (below);
  - **names a protected path** — an argument, resolved lexically against the pinned working
    directory, is a path the file tools' read floor would refuse (`isSensitiveReadPath`:
    `.env`, `.ssh`, `.aws`, `.docker/config.json`, credential dotfiles, `.relavium`) or the
    write floor protects (`isProtectedPath`). The card says so, and the command can then be
    answered **Once only**.

**Code carriers.** A closed table, applied to the argv, a speed bump for the card's honesty
and **not a security boundary** (the boundary is the full argv on the card, exact-argv
matching and `auto`'s hard edge). Names are compared by base name, case-folded, with a
trailing `.exe` removed:

- *shells*: `sh`, `bash`, `zsh`, `dash`, `fish`, `ksh`, `csh`, `tcsh`, `pwsh`, `powershell`,
  `cmd`, in any invocation;
- *interpreters given inline code*: `python`, `python3`, `node`, `deno`, `bun`, `perl`,
  `ruby`, `php`, `lua`, `osascript`, when an argument is exactly `-c`, `-e`, `-E`, `-p`,
  `-r`, `--eval`, `--command` or `--print` (`node build.js` and `python -m pytest` are not
  flagged);
- *wrappers that run another command*: `env`, `sudo`, `doas`, `xargs`, `nohup`, `nice`,
  `timeout`, `time`, `stdbuf`, `exec`, `command`, `ssh`, `watch`, and `find` with `-exec`,
  `-execdir`, `-ok` or `-okdir`. The wrapped command is not parsed; the wrapper itself is
  flagged.

A code carrier is answered **Once or Session only**: **Remember is not offered**. The table
does not catch everything (`make`, `npm run`, a `git` alias, `awk`, `vim -c` or an interpreter
not listed carry code too); it exists so that the common ways of hiding a script in one
argument are named on the card, and the list lives in one place so it can grow.

Everything is terminal-safe text, under the approval escape of
[ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md): a control, a line
separator, or an invisible or blank code point that escape covers shows in an argument as a
visible escape. ADR-0120's rules are a starting set whose completeness the security sitting
confirms. The one thing the card does not show is a secret span, which ADR-0120 masks,
labels and counts, and which the person must reveal before approving when it holds anything
but credential characters. Masked spans aside, the card never offers an approving answer
for a command it does not show in full: each argument is drawn on its own line, so
right-to-left text in one cannot be drawn past another, and a command too long for the
screen must be expanded (`[v]`) before **any** approving answer is accepted. That is
stricter than [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)
notes 6 and 10, which withhold only the session-wide answer for a partial view, and it
follows note 7, which locks `[y]` for a shortened target.

**The card's answers** (every approving answer is a chord typing cannot produce,
[ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12,
behind the same input guards; this ADR adds exactly one chord to that note's four):

- **Once** (`Ctrl+Y`). This invocation only.
- **Session** (`Ctrl+G`, then Enter). This exact argv, matched element by element, for the
  rest of this session instance. Held in memory, never persisted (§2). Not offered when the
  card names a protected path.
- **Remember** (`Ctrl+O`, then Enter). Persist a grant for this exact argv and this project
  root (§2). Offered only when the grant store is usable (§2), when the command is not a
  code carrier and when the card names no protected path.
- **Deny** (`Ctrl+N`), and **Deny with a reason** (`Ctrl+R`). A denial returns to the model
  under [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) with the person's
  words; an identical repeat in the same turn is refused without asking again.
- **`Esc` and `Ctrl+C`**, at the card and outside a text box of it, reject the card and
  stop the turn; inside a reason box `Esc` only closes the box
  ([ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) §2 and §3).

`Ctrl+O` is the proposed Remember chord; a clash in VS Code's terminal, tmux or Windows
Terminal that the manual check finds changes the chord without a new ADR. The rule that
does not change: a chord typing cannot produce, confirmed by Enter, and a bare letter
answers nothing. The question card's refusal of chord tokens in model text covers it.

**Why this changes ADR-0061's rule.** [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md)
refused a runtime-approvable `run_command` for two reasons: it dissolves the `empty ⇒
disabled` floor, and it brings back the `@`/`!` inconsistency, where `!cat .env` is approved
once while `@.env` is refused outright because human consent alone is not trusted for
credentials. This ADR keeps the first reason where it matters and answers the second
openly.

- *The floor.* What runs **without a person** keeps the allowlist as its only authority:
  `auto`, headless and workflow runs are unchanged. Where a person is present the card
  replaces the wall, because a wall nobody can open is the problem users met, and the card
  shows the whole argv, so the consent is informed.
- *The inconsistency.* It is **not** closed. A person who reads a card that names a
  protected path can still approve `cat .env` once, and the credential then reaches the
  provider as tool output. The card makes that a one-call, eyes-open decision with no
  session or remembered grant, but it is a relaxation of what the `@` floor does, and this
  ADR accepts it knowingly. The security sitting this ADR requires may overturn it by making
  the card refuse such a command instead of warning.

### 2. Grants

**A session grant** is an in-memory set of the exact argv (a length-prefixed canonical
encoding, so `["cat a b"]` and `["cat","a b"]` differ). It replaces, for `run_command`,
the per-tool "allow all calls this session" answer: the card for a command never offers
the blanket answer, and the session cache for that tool is keyed by argv.

**A remembered grant is operator-owned and machine-local.**

- **Where.** `~/.relavium/command-grants.ndjson`, mode `0600`, inside the existing `0700`
  directory, with exactly the write protocol of
  [ADR-0084](0084-consent-before-a-local-mcp-spawn.md) §5: creation with `openSync(path,
  'wx', 0o600)`, one bounded record per `appendFileSync` framed with a leading newline and
  the safe line serializer, the mode self-healed on every touch, a symlink refused, **no
  lock** (concurrent appends of the same grant are idempotent), **append-only with
  tombstones** (a later `revoked` line cancels an earlier grant and the effective set is
  the fold). It is not `config.toml`, not a project file and not `history.db`. A concurrent
  revocation and re-grant of the same argv resolve by file order, the later line winning in
  the fold (the residual ADR-0084 records for its own log).

> Amended 2026-11-21 (the PR #101 review): two sentences above describe a design the code does not have. (1) The write protocol is not `openSync(path, 'wx', 0o600)` plus `appendFileSync`: `appendLine` in `apps/cli/src/permissions/command-grants.ts` opens with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK` (the last two where the platform has them) and the owner-only mode on the creating call, checks the descriptor to be a regular file, writes one record framed with a leading newline through `writeSync` in a loop, and re-asserts the mode with `fchmod` on every write; a symbolic link is refused (an `lstat` first) on every platform. ADR-0084's protocol is the pattern it reuses, not what it runs. (2) A revocation names a grant `id` and holds **wherever it sits in the file**: a replayed or reordered grant line stays revoked, and two live records for one argv are one grant that one revoke withdraws. "File order, the later line winning" is ADR-0084's log, not how this store folds. [command-permissions.md](../reference/cli/command-permissions.md#the-store) is the canonical statement.
- **Keyed by the canonical project root.** The resolved real path, so two paths to one tree
  share grants and a fresh clone elsewhere shares none. The root is never written in clear:
  a record carries a root digest (below). A grant is **root-scoped**: it does not bind the
  working directory (the host pins it and the model cannot choose it) or the environment, so
  the card's working-directory row is information, not part of the grant.
- **What a record contains: never the command.** A command can carry a password or a
  token, and the
  [credential masking](../reference/shared-core/built-in-tools.md#finite-diagnostic-credential-masking)
  recognizes only a finite set of shapes, so a masked copy could still hold a credential in
  plaintext. A record holds instead:
  - an `id` (random, for revocation);
  - a root digest: HMAC-SHA256 over a version tag and the canonical root, under the
    per-installation key;
  - a grant digest: HMAC-SHA256 over a version tag, the root digest and the argv, each
    element length-prefixed so `["cat a b"]` and `["cat", "a b"]` differ. Binding the root
    digest means a record copied to another root's lines never validates;
  - a label for the revocation view: the program, the argument count and the date. The
    program is named only when `argv[0]`, taken whole, is a bare name
    (`^[A-Za-z0-9._+-]{1,64}$`, so no `/`, `\`, `=`, `:`, `@` or whitespace) that resolves
    through the `PATH`, as the spawn would resolve it, to an existing executable file when
    the grant is written. Anything else — a path, a whole command line, an assignment such
    as `PGPASSWORD=…`, a name that resolves to nothing — is labelled `(unnamed program)`.
    No part of `argv[0]` is taken before the check: a base name or a last segment of free
    text is never kept. `argv[0]` is free text (the model's `command` string, or the first
    token of `!PGPASSWORD=… psql`) and can itself be a credential; the one credential the
    rule cannot tell apart is one that is also the name of an executable on the `PATH`,
    which is then already on the disk.
- **Matching.** Compute the grant digest of the candidate argv under the current root and
  compare it in constant time (`timingSafeEqual`) against the effective grants of that
  root. A grant matches one exact argv, never a glob: "Remember `npm test`" never
  authorizes `npm test -- --exec=…`.
- **The key.** 32 random bytes from `node:crypto`, generated on first use and kept in the OS
  keychain beside the provider keys ([ADR-0006](0006-os-keychain-for-api-keys.md)) under
  its own account; it never enters a file, a log or an event. First use reads the entry,
  and if it is absent generates one, stores it and reads it back. Two processes that race
  there can each store a key and the later store wins, so a grant written under the
  overwritten key never matches again: the card asks again, which is the fail-closed
  outcome, and nothing else is lost. `packages/core` does not import `node:crypto`: the
  digest, the store and the matching live in the CLI host.
- **Failure modes.** A keychain that is absent, locked or denied means **Remember is not
  offered** and the card offers Once, Session and Deny; existing grants cannot be verified
  and count as none. **Any unparseable line makes the whole store "no grants" for that
  invocation, and is reported once** (one line naming the file and the revoke-all
  recovery): skipping a bad line is the tempting answer and the wrong one, because a
  truncated line may be a tombstone, and dropping it would resurrect a revoked grant. This
  is the ADR-0084 rule; the first version's "a malformed grant file is a visible
  configuration error" is withdrawn, because a grants file is machine state that must not
  be able to break every command's start. (An authored allowlist entry is different: it is
  authored text, and §3 treats it as strict config.)
- **Bounds.** At most 64 live grants per root and 1,024 live grants in total, and a file of
  at most 8,192 lines and 2 MiB (tombstones included). A write that would exceed a bound is
  refused with a message and Remember is not offered until grants are revoked; a file that
  already exceeds one is read as "no grants" and reported. `relavium permissions revoke
  --all` removes the file, so a full store always has a recovery that does not need a text
  editor.
- **What a grant does not bind.** It binds the argv, not what the program reads or which
  file `argv[0]` resolves to, and **this is a decision of this ADR, not a deferral**. "Remember
  `npm test`" keeps approving `npm test` after a model edits `package.json`'s `test` script,
  and in `auto` such an edit is itself approved (`package.json` is not a protected path,
  [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)).
  A bare name resolves through the user's own `PATH`, whose directories the file tools'
  jail does not let a model write into by default, so binding the resolved path would add a prompt
  every time the user switches a runtime without closing a hole the model can reach. A
  remembered grant therefore extends to whatever the files under the root make that program
  do. That is the same exposure a repository allowlist entry has today; the approval-path
  security sitting examines both, and may overturn this by making a remembered grant ask
  once in `auto` after the session has written under the root.

> Amended 2026-11-21 (the PR #101 review): the possibility this sentence leaves to the sitting became the rule in two steps, and its first form was too weak. Step 4's second round made a remembered command ask in `auto` after **this session** approved a file write (below); [ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md) records the write per project, so `/clear`, a reseat, a resume and a later chat keep asking until the grant is renewed with *Remember*. "Root-scoped, not bound to the working directory" stands (the host pins the directory and the model cannot choose it), with one consequence the person sees: in `auto` a grant does not skip the card for a command whose arguments name a protected path from where the chat runs (`cat id_rsa` started inside `~/.ssh`).
- **Revocation and listing.** `relavium permissions list` shows the current project's
  remembered grants (an index, the label, the date) and `relavium permissions revoke
  <index>` appends a tombstone; the chat's `/permissions` shows the same list plus this
  session's grants and revokes either. Neither can show a command's arguments, only the
  program (or `(unnamed program)`), the argument count and the date. The Home's full screen
  for them is MVP-8's (workstream 2.6.G) and the phase document's `/permissions` bullet is
  amended to say so.

> Amended 2026-11-20 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md): the chat's `/permissions` is a keyboard-owning sheet, not a transcript notice; the typed `--revoke` forms are removed; the bare Home and a bare `relavium permissions` on a TTY open the same sheet with the project's remembered commands only. Only the Home's tab bar and the pane that composes the sheet with the allowlist, domain and MCP sections stay MVP-8's. *(Implemented: the chat's sheet in MVP-4 step 5; the bare Home and the bare command in step 7, 2026-11-21.)*

> Amended 2026-11-21 (the PR #101 review): "neither can show a command's arguments" is true of a **remembered** grant (a keyed digest and a label) and of `relavium permissions list`. The chat's sheet shows a **session** approval's command, because the session holds the exact argv in memory: quoted and scrubbed by the same function the card's title uses (`scrubbedCommandDisplay`), cut to 400 characters, every control or invisible character drawn as a visible escape ([command-permissions.md](../reference/cli/command-permissions.md#in-the-chat-permissions-a-sheet)).

The grant store's format, bounds and commands live in one new reference,
`docs/reference/cli/command-permissions.md`, modelled on the MCP grant store section of
[mcp-integration.md](../reference/shared-core/mcp-integration.md); [config-spec.md](../reference/contracts/config-spec.md)
holds only the config keys. The card's rendering contract lives with the approval-preview
contract (phase 2.6 ADR row 9).

### 3. What "exact" means: the allowlist grammar

An exact allowlist entry is compared to the call **element by element**, not as a string.

- The call's argv is `[command, ...args]`, as the model or the `!` line supplied it.
- An exact `allowed_commands` entry is split into tokens by one shared, quote-aware
  tokenizer: whitespace separates tokens; single and double quotes group (a quote's
  contents, spaces included, stay one token; adjacent quoted and unquoted spans join); there
  are no escapes and no expansion (`$x`, `*`, `;` and `|` are literal characters). The
  tokenizer reports whether a quote was left open.
- The entry matches when its tokens equal the argv, element for element. `cat a b` therefore
  matches `["cat","a","b"]` and no longer matches `["cat","a b"]`, and `./s/build.sh
  --release` no longer matches the file named `build.sh --release`.
- **An open quote is refused everywhere, never tolerated.** The tokenizer's old behaviour
  (an open quote runs to the end of the line) is dropped: a `!` line with an open quote is
  not run and says why, and an `allowed_commands` entry with one, or an empty entry, is a
  configuration error at load in the strict-config style
  ([ADR-0033](0033-strict-config-files-amends-0023.md)). A config entry is authored text
  that a person can fix and that fails loudly the way every other config value does; a grants
  file is machine state and degrades to "no grants" instead (§2).
- **Globs stay string-level, and opt-in.** `allowed_command_globs` are matched against the
  space-joined argv, so a glob cannot tell one argument with a space from two. That is the
  reason globs are the riskier field and stay so; the documentation says it.
- The same `ToolPolicy.allowedCommands` is the workflow `run_command`'s allowlist, so the
  workflow path gets the same element-wise comparison. An entry containing no quote
  character that matched exactly one argv still matches exactly that one; an entry that
  matched two different argvs now matches one; and an entry with quote characters, which
  could not match a tokenised line before, now can. The product has no deployed users to
  migrate (maintainer, 2026-11-19), so there is no transition period.
- The tokenizer and its inverse (a quoter that emits a line that parses back to the same
  argv, used wherever the product shows a command line a person could paste) live in
  `packages/core/src/tools/command-line.ts`, pure and platform-free; the CLI imports them.

> Amended 2026-11-21: the tokenizer, the quoter and `argvMatchesCommandLine` live in `packages/shared/src/command-line.ts`, not in `packages/core/src/tools/`; the 2026-11-19 implementation note (MVP-4 step 1) says why (the config and workflow schemas validate allowlist entries with the same function, and `@relavium/shared` is the one package all three depend on). Pure and platform-free, as stated; `packages/core` and the CLI import it from there.

### 4. The default agent's `run_command`

`run_command` joins `DEFAULT_CHAT_TOOLS` in the increment that lands the card and nothing
earlier, and the default agent's prompt is rewritten with it: commands run **without a
shell**, so pipes, redirects, globs and `&&` are literal characters; the model supplies one
program and its arguments; a command needs the person's decision unless it is pre-approved;
and a refusal is final for that call. The mode's refusal texts are the existing fixed ones
([ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md)); nothing in them names the
allowlist or a grant.

The model has no file rename, move or delete tool and none is planned: the route is an
approved `run_command` (`mv`, `rm`), and the acceptance tests cover a rename through the
approved path and a refusal when the card is declined.

### 5. What this amends

- **ADR-0061.** The `!` escape's "allowlist before approval, refused otherwise" becomes §1's
  table, for the reasons given in §1. Hardened spawn (`shell: false`, literal argv), the
  command jail, the busy and abort affordances and the injected-output rules are unchanged.
- **ADR-0029 (a).** Exact entries are compared element by element (§3). Globs are unchanged.
- **ADR-0057.** The once/always cache is keyed by argv for `run_command`; an allowlist miss
  reaches the host's hook as a request instead of a thrown error when a regime is present.
- **ADR-0063.** Unchanged. Remembered grants are **not** a second write target of the config
  primitive: they use ADR-0084's append-only protocol, for the reasons in Context.
- **ADR-0006.** The keychain holds one more secret: the grant digest key.
- **ADR-0116.** `run_command` joins the default grant here (§4).
- **ADR-0117.** The allowlist-miss class is realized as §1 describes.
- **ADR-0129 note 12.** The command card has one more answer chord, `Ctrl+O`.
- **ADR-0130.** Its table gains the command row of §1; nothing else in it changes.

Each amended ADR gets a dated amendment note pointing here when this is accepted.

### Alternatives considered

- **Keep the allowlist wall and add an `/allow <command>` writer** (D63 option 2).
  Rejected. The user still cannot approve a command in the moment, and the natural place for
  such a writer is the repository file this ADR must avoid.
- **Store "remember" in the project's `[chat]` allowlist.** Rejected. Every clone would
  inherit the grant: one user's consent would become every visitor's authority.
- **Store it in the global `config.toml` through the ADR-0063 primitive** (the first version
  of this ADR). Rejected after the PR #97 review and again on 2026-11-19: the primitive is
  last-writer-wins without a lock, so a concurrent process can resurrect a revoked grant,
  and a malformed section would break the config load of every command.
- **Store the command, masked, in operator config.** Rejected after the PR #97 review. The
  masking is finite (built-in-tools.md lists flags it does not read), so a credential it does
  not recognize would be written in plaintext.
- **Store a plain hash of the command.** Rejected. A short password is recoverable from an
  unkeyed digest by trying candidates; the keychain key makes that require the key.
- **Bind the resolved executable path into the grant.** Rejected (§2, "What a grant does not
  bind"): it prompts on every runtime switch and closes nothing a model can reach.
- **Let `auto` approve any command.** Rejected. `run_command` has no argument
  confidentiality floor, so an approval-free arbitrary command is an approval-free
  exfiltration path for a prompt-injected model.
- **Keep the card out of `!`.** Rejected. Two command paths with different consent rules are
  harder to reason about. The cost of one card is small.
- **Offer Remember for a code carrier.** Rejected. A remembered `bash -c "<script>"` runs
  silently in `auto` in every later session; the person loses nothing important by
  answering Once or Session. The table is a speed bump, not a boundary, and says so.
- **Refuse code carriers, or commands naming a protected path, outright.** Not taken: a
  person may legitimately want one, the card shows the whole argv, and a refusal heuristic
  with known bypasses would promise more than it delivers. The warning rows and the Once-only
  rule are proportionate; the security sitting may tighten them.

## Consequences

### Positive

- A command the user is willing to run can run, with the exact argv on screen, masked secret
  spans aside. The config edit is no longer needed.
- The allowlist compares commands, not strings: the `["cat a","b"]` collision is closed for
  the workflow path too.
- A remembered grant serves one operator on one tree and never travels with the repository,
  survives concurrent processes without losing a line, and holds no command text beyond the
  name of an executable found on the `PATH`.
- `auto` keeps a hard edge: only pre-approved commands run without a prompt.
- A headless path still never runs anything it was not configured to run.
- The default agent can rename, move and delete through a reviewed card instead of saying it
  cannot.

### Negative

- More cards in `ask` and `accept-edits`, by design. A user who trusts a command for the
  session answers "Session" once.
- A repository's own allowlist still pre-approves commands for `auto`, as it does today. This
  ADR does not widen that, but it does not remove it either. The security sitting has to
  examine it, and closing it would be a separate decision.
- A person can approve `cat .env` once and send a credential to the provider (§1). The card
  names the path and withholds every grant, and the sitting may turn the warning into a
  refusal.
- The code-carrier table is incomplete by construction and will need maintenance.
- Remember needs the OS keychain; without it the card offers Once, Session and Deny only, and
  a first macOS access may show a keychain prompt.
- The revocation view cannot show a remembered command's arguments, only its program (or
  `(unnamed program)`), argument count and date.
- A grant binds the argv, not the files the program interprets nor the binary `argv[0]`
  resolves to, so in `auto` a model that can edit those files can change what a remembered
  command does (§2, a decision, not a deferral).
- The card is a new approval surface. It needs the approval-path security sitting D63
  requires: exact rendering, no hidden affirmative key, no truncated approval, and a
  grant store that cannot be forged or resurrected.
- An allowlist entry with an unbalanced quote now stops the config load instead of silently
  matching nothing, and a `!` line with an open quote is refused instead of run.

### Landing obligations

- New reference `docs/reference/cli/command-permissions.md`: the grant store (file, protocol,
  record, digest, key, bounds, failure modes), the code-carrier table and the
  `relavium permissions` commands.
- [config-spec.md](../reference/contracts/config-spec.md): `allowed_commands` is compared
  element by element and its tokenizer; the strict error for an open quote; the sentence that
  `[chat]` does not define its own allowlist and the "`!`-shell allowlist" wording, which now
  also gates the model's `run_command`.
- [chat-session.md](../reference/cli/chat-session.md): the mode table's command row, the
  card, the answers and the standing row; the `!` section. [tool-registry.md](../reference/shared-core/tool-registry.md):
  `PolicyTarget.argv`, the request's argv and flag, the per-tool approval seam.
  [built-in-tools.md](../reference/shared-core/built-in-tools.md): `run_command`.
  [commands.md](../reference/cli/commands.md): `relavium permissions` and `/permissions`.
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md): the element-wise
  match. [security-review.md](../standards/security-review.md): the grant store joins the
  mandatory-review triggers.
- Dated amendment notes on ADR-0006, 0029, 0057, 0061, 0063 (not a write target), 0084
  (pattern reused), 0116, 0117, 0129 and 0130.
- The phase document's 2.6.G "Permission management" bullet, the D63 row, MVP-A15 and the
  MVP-4 entry of [current.md](../roadmap/current.md): grants are not written to
  `project.toml` or `config.toml`, and the Home's screen is MVP-8's.

### Revision note — 2026-11-19

The ADR was Proposed on 2026-11-05 and revised on 2026-11-06; it had not been accepted when
the modes, the chord keys and the refusal return landed (ADR-0129 to ADR-0132). Revised in
place, not superseded, because it was never accepted. What changed: the mode table follows
ADR-0130 (a card in `ask`, a refusal in `plan`, headless hides the tool); "only unmodified
keys answer" is replaced by the chord rule; "Session like ADR-0057's `[a]`" is replaced by an
exact-argv session grant, because that cache is per tool id; remembered grants moved from the
global config to an ADR-0084-style append-only file, with the root also digested and bound
into the grant digest, numbered bounds, a recovery command and a read-back of the key; the
allowlist grammar (§3, with `PolicyTarget.argv` and the open-quote rule), the code-carrier
table and the protected-path warning, the no-Remember rule for code carriers, the standing
row, the `permissions` commands and the default agent's prompt were added; the answer to
ADR-0061's security reasoning and the decision not to bind the executable path were written
down; and the decision that an allowlist miss reaches the host as a request rather than a
thrown error was recorded, so ADR-0117's allowlist class needs no denial of its own. A
review on the same day tightened the code-carrier rule (it had named shells only, which
`env sh -c` and `python -c` bypass), completed the Amends list and corrected two citations.

### Implementation note — 2026-11-19 (MVP-4 step 1)

Where the pieces landed: the tokenizer, its inverse quoter and `argvMatchesCommandLine` are in `packages/shared/src/command-line.ts`, **not** `packages/core/src/tools/command-line.ts` as §3 says, because the config and workflow schemas validate allowlist entries with the same function and `@relavium/shared` is the one package all three depend on. `PolicyTarget.argv` is in core. An entry is refused at load when it has an open quote, no token or an empty program token; the loader prints a fixed message for exactly that issue and never echoes the entry. The `!` escape refuses an open quote and leaves the line in the editor. The interim deny hint (retired when the card lands) shows its suggested entry as a TOML basic string so a pasted line parses back to the typed argv.

### Implementation note — 2026-11-19 (MVP-4 step 3)

The grant store, the engine seam, the mode table's command rows and `relavium permissions` are in; the card that asks, `Session` and `Remember` as answers, `run_command` in the default grant and `/permissions` are step 4. Where the pieces landed and what the code settled that §2 left open:

- **Seam.** With an approval regime present the registry's command check no longer throws on an allowlist miss; the request carries `argv` (frozen, in-process only) and `commandAdmitted` (whether the allowlist admitted it). Without a regime a miss still throws `command_not_allowed`. The store, the digests and the matching are in `apps/cli/src/permissions/command-grants.ts`, because `packages/core` does not import `node:crypto`.
- **Mode table.** `ask` and `accept-edits` ask for every command, pre-approved or not, and a Session answer given in this session removes the card; `plan` refuses with the fixed mode text; `auto` runs a command only when the allowlist admitted it, a remembered grant covers its exact argv, or this session approved that argv. The session cache is keyed by the exact argv, never by tool id. Headless paths open no store.
- **The key is generated on the first write, never on a read.** `permissions list` and the matcher on a machine that has never remembered anything see "no key yet", which is an empty store, not a keychain fault; a locked or denied keychain is the fault (`no-key`), and matching then says nothing matches.
- **A record the grant list shows is a label only.** `program` is kept only for a bare name that resolves on the `PATH`; the root digest is also stored so a record cannot be moved between roots.
- **`revoke` takes a number.** §2 spells `revoke <index>`; the command and its messages say `<number>`, the number `list` prints, because that is what a person sees. The numbers close up after a revoke and the confirmation says so. `revoke --all` removes the file for every project and works with a locked keychain and an unreadable file, which is what makes it a recovery; a file that cannot be removed is `storage_unavailable`, never "nothing to remove". A revoke whose confirmation cannot be delivered exits `9` and the grant is already gone.
- **What the two review rounds changed (same day).** Revocation is by id and holds wherever the tombstone sits, so a replayed or reordered grant line stays revoked, and two records for one argv (two processes remembering it at the same moment) are one grant that one revoke withdraws. **A grant record carries a MAC over all of its fields under the installation key**, so a record cannot be forged, relabelled, or copied under a new `id` to bring a revoked grant back; one that fails it is ignored without making the store unreadable. The file is read and written as a regular file only (a symlink is refused on every platform, and a FIFO, device or directory reads as unreadable; the open does not follow a link and does not block where the platform has the flags, and the descriptor is checked, so a path swapped after the read is neither written through nor waited on). The per-root and total bounds apply on read as well as on write; a time that is not an ISO instant invalidates its line; `revoke` is refused (`full`) rather than pushing the file past the line or size bound, and its confirmation names what it withdrew; `canRemember` also checks, best effort, that the file can be written; a path that cannot be inspected is never read as an empty store; the key is generated only after the file was read; and `permissions revoke --all` deletes the digest key as well as the file (best effort), so an older copy restored from a backup stops validating. It needs no project root and no readable file. The store defends against forgery, relabelling and replay (the MAC and by-id revocation) and torn writes (the fail-closed fold). It does **not** defend against a process running as the same user: tombstones are not authenticated, so deleting a revocation line brings its grant back, and that process can read the keychain key.
- **One root function.** The chat session and the command derive the project root with the same function (`commandGrantRoot`), so a grant made in one is the grant the other lists. The OS keychain is opened lazily, so building a session that never asks about a command never touches it.

The format, bounds and failure table are [command-permissions.md](../reference/cli/command-permissions.md); the binding review items are in [security-review.md](../standards/security-review.md#sandbox-and-tool-policy-run_command-node-tools-secret-inputs). The separate security sitting this ADR requires covers the store and the seam in step 3's review rounds and the card in step 4's.

### Implementation note — 2026-11-19 (MVP-4 step 4)

The command card, its answers, the default grant and `/permissions` are in; the card contract is [command-permissions.md](../reference/cli/command-permissions.md#the-command-card). Where the pieces landed and what the code settled that §1 left open:

- **One card, not two.** The command card is the existing approval card with a real `run_command` preview (`target` = the whole command as one quoted line, `fields` = one row per argument) and the host's facts: a lock, a mask and a shortened target already worked for a path, so a command too long for the title rows locks every approving answer behind the full view with no new mechanism. The standing, the directory and the two warnings are rows of the card's warnings and of its full view. The event preview (`agent:approval_requested`) and the in-process copy carry the same quoted line, so `["cat","a b"]` and `["cat","a","b"]` no longer read alike.
- **The answers.** `Ctrl+O`, then Enter, remembers; `Ctrl+G`, then Enter, is the session answer worded for this exact command. Both are the two-step answer behind the same guards. The hook computes the facts (the code-carrier table in `apps/cli/src/chat/command-facts.ts`, a lexical protected-path check over each argument and a `--flag=value`'s value, anchored at the session workspace) and the offers, and narrows an answer the card did not offer to Once.
- **Remember writes at the moment of the answer and then behaves as Session.** The grant is the person's consent to the command, not to its outcome, so it is not undone when the call fails; the session memory (keyed by exact argv) is filled after a successful dispatch like any Session. A grant that cannot be written approves this call only and says why in fixed words that never contain the command. In `ask` and `accept-edits` a remembered command still shows a card in a later session, as §1 decides; Remember's effect there is that it stops asking for the rest of this one, and in `auto` it is what lets the command run unasked.
- **Bounds the card inherits.** The review document holds at most 64 fields and 4,096 characters a value or target, so a command of more than 63 arguments, or with an argument or a quoted line over 4,096 characters, cannot be shown and its card is blocked (Deny and Esc only). §1's "a command too long for the screen must be expanded" applies below that bound; above it the command is simply not approvable.
- **`run_command` is in the default grant** with a prompt that says there is no shell and that every command is the person's decision; it is hidden wherever no one can answer. **The `!` escape's allowlist hint is retired**: the only sentence left names no config key. **`/permissions`** lists the project's remembered commands and the session's approvals and withdraws one by number (`--revoke`, `--session`), chat-only.

> Amended 2026-11-21 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md): the typed `--revoke` and `--session` forms are gone. `/permissions` takes no argument and opens a sheet that withdraws a row by identity (`d`, then `Enter`).
- **Still the security sitting's question:** whether a remembered command should ask once in `auto` after the session has written under the root (§2) is unchanged by step 4; the card words *Remember* for the exact command and project and nothing more.

After step 4's first review round (2026-11-19; the findings were verified against the code before any was fixed), the contract above reads:

- **A command's rows are bare values**, the program first, with no `program` / `argument N` labels: the labels spent a row each and pushed a realistic command off the card. About five elements fit at 80×24 with all three answers; a longer command shows *Once* on the card and says so, and offers every answer in the full view, where the whole command is on screen. A command the document cannot hold is a blocked card that **says why** (Deny and Esc still answer, and the denial tells the model, in fixed words, to run smaller commands).
- **Every masked span of a command must be revealed** before an approving answer counts (a file card keeps its narrower rule). A masked argument is the place a command can hide what it does, and the card says how many to inspect.
- **The protected-path check reads the text after the first `=` of any argument**, not only `--flag=value`, and the program name is compared without a Windows alternate-stream suffix or trailing dots and spaces. *Remember* is not offered for a command already pre-approved (on the allowlist or remembered): there is nothing to remember.

> Amended 2026-11-21 (the PR #101 review, finding B1): withdrawn for a **listed** command and for an **outdated** grant. Once the allowlist pre-approves nothing in `auto` (the second-round ruling below), a listed command has something to remember: *Remember* is offered for it, and for a remembered grant that a later file write outdated (it renews the grant, [ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)). It is still not offered for a code carrier, a command that names a protected path, a grant that stands, or when the store cannot write. On the card's standing row the person's grant outranks the allowlist when both hold. [command-permissions.md](../reference/cli/command-permissions.md#the-command-card).
- **A Remember's session approval is linked to its grant**: withdrawing the grant in the chat withdraws it, and a chat open elsewhere keeps its own until `/permissions --revoke --session`, which the revoke's message says.

> Amended 2026-11-21 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md): a chat that is already open keeps its own session approval of a command revoked elsewhere until the person withdraws that row in its sheet (the row then no longer says `(also remembered)`); there is no `--session` form.
- **`/permissions` reports what it did not understand** (an unknown flag, `--session` or a number without `--revoke`, a second number) with its usage line instead of listing or revoking something else.

> Amended 2026-11-21 by [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md): `/permissions` takes no argument now; a typed form is the dispatch's own rejection of an unknown argument plus the hint `Open /permissions and press d on a row to withdraw it.`, and the usage line named here was never part of the sheet.
- **Declined, with reasons:** a "who is asking" label on a `!` card (the person typed it, and the card already names the command); a separate below-floor wording for a command card (the wording is shared by every card on purpose); a session export is not given the allowlist or the grants (an export carries no authority, as for the network tools).
- **Equivalent mutants accepted:** the blocked card's approving answers are refused by three independent layers (no acknowledged frame, an invalid page, the document's validity), so removing any one leaves the behaviour unchanged; the host tests pin the behaviour, not the layer.

After step 4's second review round (2026-11-19; a security sitting on Opus, correctness, test-adequacy, documentation-truth and UX reviews, each finding verified against the code before it was fixed), the contract reads:

- **The repository's allowlist no longer pre-approves a command in `auto`** (the maintainer's ruling on the sitting's high finding, which this ADR had left as "a separate decision"). With `run_command` in the zero-config agent, a cloned repository's `allowed_command_globs = ["*"]` would have let a prompt-injected agent run `npm install` or `npx` unasked in an operator's `auto`. In `auto` only the operator's own pre-approval skips the card: a remembered grant, or a session approval. A command the allowlist admits shows its card, with the standing `on this project's allowlist` (the file is the project's, not the person's). The allowlist keeps its meaning in a workflow, where it is the only authority. This supersedes the Negative consequence above that "a repository's own allowlist still pre-approves commands for `auto`".
- **A remembered command asks once in `auto` after the session has approved a file write** (the question §2 and the step 4 note left to the sitting, ruled by the maintainer). The write may have changed what the command does (`package.json`'s `test` script, a Makefile). The card says `remembered for this project; asks because files changed this session`; a Session answer ends the asking; a session approval given knowingly is not affected. The write is noted when the hook approves an `fs_write`, whether or not it later succeeds.

> Amended 2026-11-21 by [ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md): "once" and "this session" are replaced. A file write a chat of this machine applies is recorded against the project root (`~/.relavium/command-write-marks.json`), and a remembered grant older than the latest mark asks again in `auto`, in this chat and in every later one, until *Remember* renews it. A *Session* answer ends the asking for that chat only. A *Remember* also approves the command for the chat it is made in, so that chat does not ask after a write either. The card's reason reads `asks because files changed this session` for a write of this chat and `asks because files changed since` for one recorded earlier. [command-permissions.md](../reference/cli/command-permissions.md#the-write-marks).
- **The card gives its rows to the command.** A command card has no tool-identity row, shows the standing and the directory on one row while the directory keeps room, puts each warning on one row, keeps the row a refusal note needs free from its first frame, and names the not-shown rows only with the answers they really withhold. Six elements fit at 80×24 with every answer; a longer command is answered *Once* on the card, and *This session* and *Remember* are offered in the full view only while the whole command fits its first page (about eight elements at 80×24). A wrapped title continues under the command, an empty argument reads `(empty)`, and the open question is the card's plainest text.
- **Wording.** The answers read `Allow once`, `Allow this session`, `Allow + remember`; the Remember question says it allows the command now and remembers it; a question that ends without an answer says nothing was allowed (an Enter outside its window says so in a note); the success notice says that `auto` will run it without asking and `ask` still asks; the transcript row of a command is its program and an argument count; `/permissions` marks a session entry a Remember made, and withdrawing it says the project grant still covers the command.
- **The model hears the host's limit as the host's.** A command too large to show, and a command card with no preview, reach the model as a `mode` refusal with a fixed label, not as "the user's reason".
- **Redaction.** The event preview of a command is scrubbed element by element and checked against the joined line (the display copy before quoting), because quoting an embedded quote broke the `key='value'` context the detector reads; a form the joined line masks is masked, or every argument after the program is.
- **Tables.** The code-carrier table reads interpreter versions (`python3.12`, `node22`), `nodejs`, `pypy`, `py`, `deno eval`, short option clusters (`-Ic`, `-pe`), `--eval=…`, a flag anywhere among the interpreter's own options, `busybox`/`toybox`/`wsl`, and a drive-relative name (`C:cmd.exe`). The protected-path check reads values hidden after a `:` (`HEAD:.env`), after a leading `@` and after an attached one-letter option, and does not treat the program's own name or a flag as a path.
- **A revoke withdraws every twin record's session approvals**, and a Remember whose call is cancelled while it is being written says the grant stands.
- **Deferred, with reasons** (in [deferred-tasks.md](../roadmap/deferred-tasks.md)): strong right-to-left letters in an argument can be reordered within the one-line title by a terminal that applies bidi (plausible, terminal-dependent; the rows below show each argument whole, and the cure — require every row on screen for *Once* when one is present — is a new rule); `/permissions` does not show when a session approval was given; the card says nothing about why a remembered command still asks in `ask`.


### Amendment note — 2026-11-21 (PR #101 review)

Dated blockquotes were added beneath the sentences of this ADR that the code and the later rulings made false; no original sentence was rewritten. The review (three reports, each claim checked against the code before a note was written) found:

- **§1, the definition of pre-approved and the mode table**: the repository's allowlist does not pre-approve a command in `auto` (the step 4 round 2 ruling was recorded as a note but never carried into §1). Corrected beneath "A command is pre-approved" and beneath "`auto` has a hard edge".
- **§2, "Where"**: the write protocol is `O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK` plus `writeSync` and `fchmod`, not `wx` plus `appendFileSync`; a revocation holds by `id`, wherever it sits in the file, not by file order.
- **§2, "What a grant does not bind"**: the "ask once" possibility is the rule, in the form of [ADR-0138](0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md) (per project, not per session, not once). **Step 4, round 2**: the same pointer beneath the "asks once" bullet.
- **§2, "Revocation and listing"**: the sheet shows a session approval's scrubbed command.
- **§3**: the tokenizer lives in `packages/shared`, not `packages/core`.
- **Step 4**: the typed `--revoke` and `--session` forms are gone ([ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)); *Remember* is offered for a listed command and for an outdated grant (finding B1).
