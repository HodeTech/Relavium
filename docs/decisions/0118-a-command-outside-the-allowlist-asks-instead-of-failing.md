# ADR-0118: A command outside the allowlist asks instead of failing

- **Status**: Proposed — revised 2026-11-19 (see the revision note at the end). Awaiting the maintainer's acceptance.
- **Date**: 2026-11-05 (revised 2026-11-06 after the PR #97 review; revised again 2026-11-19)
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0029](0029-tool-policy-hardening.md) (a), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0084](0084-consent-before-a-local-mcp-spawn.md), [ADR-0112](0112-chat-network-grants-and-onboarding-state-are-operator-owned.md), [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md), [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md), [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md), [ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md), [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md), [D63](../roadmap/current.md#wave-gating-decisions), [MVP-A15](../roadmap/phases/phase-2.6-conversational-authoring.md#cli-mvp-additions--2026-11-04)
- **Amends**: [ADR-0029](0029-tool-policy-hardening.md) (a) (an exact allowlist entry is compared element by element), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) (the `!` escape's "allowlist before approval, refused otherwise"), [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) (`run_command` joins the default grant now), [ADR-0006](0006-os-keychain-for-api-keys.md) (the keychain holds one more secret).

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
- The refusal hint asks the user to edit a config file and restart.
- [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)
  gives the built-in agent `run_command` only when this card lands, and the default agent's
  prompt still says it has no command execution.

Three defects the first version of this ADR did not know:

- **The allowlist compares a string, not a command.** The policy target is
  `[command, ...args].join(' ')`, so the exact entry `cat a b` admits both `["cat","a b"]`
  and `["cat a","b"]`, and `./s/build.sh --release` admits a file literally named
  `build.sh --release`. An entry typed with quotes never matches the tokenised `!` line.
- **The session cache is per tool id** (`ApprovalCache`). An answer for `run_command`
  would approve every later command in the session. "Session like ADR-0057's `[a]`" is
  therefore unsafe for commands.
- **The global config writer is a read-modify-write with no lock** (ADR-0063). A concurrent
  `relavium` process can silently restore a revoked grant, and a malformed grants section
  would break every command's config load.
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
- **A workflow's `run_command` is unchanged.** A workflow's allowlist stays the only
  authority there, with no card and no remembered grants, and a miss still fails the node
  with `command_not_allowed`. A workflow runs unattended.

**How the allowlist miss reaches the host.** With an interactive approval regime present,
the registry's command check no longer throws on a miss. It builds the approval request
with the command's argv (in-process only, never on `agent:approval_requested`, whose
preview object is strict) and a flag saying whether the allowlist admitted it, and the
host's hook applies the table above. Without an approval regime the miss throws as today.
This is how [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) §1's "a command
outside the allowlist" returns to the model: as a card, or as the fixed mode or
*unavailable* text, and never as a new denial class that names the allowlist.

**The card shows the command exactly, masked secret spans aside.** It shows:

- the argv, **one argument per row**, each delimited so a leading or trailing space stays
  visible, and spaces and quotes are unambiguous;
- the working directory the command will run in (the jailed directory the host pins, never
  model-supplied);
- one **standing** row: `on your allowlist`, `remembered for this project`, or `not
  pre-approved`, so a person can see when a repository's allowlist already trusts it;
- a **shell warning** row when `argv[0]` is a shell (`sh`, `bash`, `zsh`, `dash`, `fish`,
  `ksh`, `pwsh`, `powershell`, `cmd`, compared by base name): "starts a shell — what it is
  given runs with your full authority". It is a warning only and never refuses a command.

Everything is terminal-safe text, under the approval escape of
[ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md): a control, a line
separator, or an invisible or blank code point that escape covers shows in an argument as a
visible escape. ADR-0120's rules are a starting set whose completeness the security sitting
confirms. The one thing the card does not show is a secret span, which ADR-0120 masks,
labels and counts, and which the person must reveal before approving when it holds anything
but credential characters. Masked spans aside, the card never offers an approving answer
for a command it does not show in full: each argument is drawn on its own line, so
right-to-left text in one cannot be drawn past another, and a command too long for the
screen must be expanded (`[v]`) before it can be approved, exactly as ADR-0129 notes 6, 7
and 10 require for a diff.

**The card's answers** (every answer is a chord typing cannot produce,
[ADR-0129](0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md) note 12,
behind the same input guards):

- **Once** (`Ctrl+Y`). This invocation only.
- **Session** (`Ctrl+G`, then Enter). This exact argv, matched element by element, for the
  rest of this session instance. Held in memory, never persisted (§2).
- **Remember** (`Ctrl+O`, then Enter). Persist a grant for this exact argv and this project
  root (§2). Offered only when the grant store is usable (§2), and **not offered for a
  shell** (the shell warning's case), where Once and Session remain.
- **Deny** (`Ctrl+N`), and **Deny with a reason** (`Ctrl+R`). A denial returns to the model
  under [ADR-0117](0117-a-denied-tool-call-returns-to-the-model.md) with the person's
  words; an identical repeat in the same turn is refused without asking again.
- **`Esc` and `Ctrl+C`** reject the card, then stop the turn, as
  [ADR-0115](0115-one-interrupt-keymap-for-the-interactive-cli.md) defines.

`Ctrl+O` is the proposed Remember chord; a clash in VS Code's terminal, tmux or Windows
Terminal that the manual check finds changes the chord without a new ADR. The rule that
does not change: a chord typing cannot produce, confirmed by Enter, and a bare letter
answers nothing.

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
  the fold). It is not `config.toml`, not a project file and not `history.db`.
- **Keyed by the canonical project root.** The resolved real path, so two paths to one tree
  share grants and a fresh clone elsewhere shares none. The root is never written in clear:
  a record carries a root digest (below).
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
  generates and stores one if absent, and **reads it back** so two processes that raced
  adopt the same stored key. A grant made under a key that was then overwritten simply
  fails to match and the card asks again (fail-closed). `packages/core` does not import
  `node:crypto`: the digest, the store and the matching live in the CLI host.
- **Failure modes.** A keychain that is absent, locked or denied means **Remember is not
  offered** and the card offers Once, Session and Deny; existing grants cannot be verified
  and count as none. **Any unparseable line makes the whole store "no grants" for that
  invocation, and is reported once** (naming the file): skipping a bad line is the tempting
  answer and the wrong one, because a truncated line may be a tombstone, and dropping it
  would resurrect a revoked grant. This is the ADR-0084 rule; the first version's "a
  malformed grant file is a visible configuration error" is withdrawn, because a grants file
  must not be able to break every command's start.
- **Bounds.** At most 64 live grants per root and 1,024 in total, and a bounded line count
  and file size; a write that would exceed a bound is refused with a message and Remember
  is not offered until grants are revoked. `relavium permissions revoke --all` removes the
  file, so a full store always has a recovery that does not need a text editor.
- **What a grant does not bind.** It binds the argv, not what the program reads or which
  file `argv[0]` resolves to. "Remember `npm test`" keeps approving `npm test` after a
  model edits `package.json`'s `test` script, and in `auto` such an edit is itself approved
  (`package.json` is not a protected path,
  [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md)).
  A remembered grant therefore extends to whatever the files under the root make that
  program do. That is the same exposure a repository allowlist entry has today; the
  security sitting examines both, and whether a remembered grant should still ask once in
  `auto` after the session has written under the root.
- **Revocation and listing.** `relavium permissions list` shows the current project's
  remembered grants (an index, the label, the date) and `relavium permissions revoke
  <index>` appends a tombstone; the chat's `/permissions` shows the same list plus this
  session's grants and revokes either. Neither can show a command's arguments, only the
  program (or `(unnamed program)`), the argument count and the date. The Home's full screen
  for them is MVP-8's (workstream 2.6.G) and the phase document's `/permissions` bullet is
  amended to say so.

The exact keys, bounds and file layout live in
[config-spec.md](../reference/contracts/config-spec.md). The card's rendering contract
lives with the approval-preview contract (phase 2.6 ADR row 9).

### 3. What "exact" means: the allowlist grammar

An exact allowlist entry is compared to the call **element by element**, not as a string.

- The call's argv is `[command, ...args]`, as the model or the `!` line supplied it.
- An exact `allowed_commands` entry is split into tokens by one shared, quote-aware
  tokenizer: whitespace separates tokens; single and double quotes group (a quote's
  contents, spaces included, stay one token; adjacent quoted and unquoted spans join); there
  are no escapes and no expansion (`$x`, `*`, `;` and `|` are literal characters). The `!`
  escape's own tokenizer is this one, so a line the user types and an entry the user writes
  mean the same thing.
- The entry matches when its tokens equal the argv, element for element. `cat a b` therefore
  matches `["cat","a","b"]` and no longer matches `["cat","a b"]`, and `./s/build.sh
  --release` no longer matches the file named `build.sh --release`.
- **An entry the tokenizer cannot split** (an unterminated quote, or an empty entry) is a
  configuration error at load, in the strict-config style
  ([ADR-0033](0033-strict-config-files-amends-0023.md)), not a silent non-match.
- **Globs stay string-level, and opt-in.** `allowed_command_globs` are matched against the
  space-joined argv, so a glob cannot tell one argument with a space from two. That is the
  reason globs are the riskier field and stay so; the documentation says it.
- The same `ToolPolicy.allowedCommands` is the workflow `run_command`'s allowlist, so the
  workflow path gets the same element-wise comparison. An entry that matched two different
  argvs before now matches one; no entry that matched exactly one argv changes.
- The tokenizer and its inverse (a quoter that emits a line that parses back to the same
  argv, used wherever the product shows a command line a person could paste) live in
  `packages/core/src/tools/command-line.ts`, pure and platform-free; the CLI imports them.

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
  table. Hardened spawn (`shell: false`, literal argv), the command jail, the busy and abort
  affordances and the injected-output rules are unchanged.
- **ADR-0029 (a).** Exact entries are compared element by element (§3). Globs are unchanged.
- **ADR-0063.** Unchanged. Remembered grants are **not** a second write target of the config
  primitive: they use ADR-0084's append-only protocol, for the reasons in Context.
- **ADR-0006.** The keychain holds one more secret: the grant digest key.
- **ADR-0116.** `run_command` joins the default grant here (§4).
- **ADR-0117.** The allowlist-miss class is realized as §1 describes.
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
- **Let `auto` approve any command.** Rejected. `run_command` has no argument
  confidentiality floor, so an approval-free arbitrary command is an approval-free
  exfiltration path for a prompt-injected model.
- **Keep the card out of `!`.** Rejected. Two command paths with different consent rules are
  harder to reason about. The cost of one card is small.
- **Offer Remember for a shell command.** Rejected. A remembered `bash -c "<script>"` runs
  silently in `auto` in every later session; the person loses nothing important by
  answering Once or Session.
- **Refuse shell commands outright.** Rejected. A person may legitimately want one, and the
  card shows the whole script; the warning row and the missing Remember are proportionate.

## Consequences

### Positive

- A command the user is willing to run can run, with the exact argv on screen, masked secret
  spans aside. The config edit and restart are no longer needed.
- The allowlist compares commands, not strings: the `["cat a","b"]` collision is closed for
  the workflow path too.
- A remembered grant serves one operator on one tree and never travels with the repository,
  survives concurrent processes, and holds no command text beyond the name of an executable
  found on the `PATH`.
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
- Remember needs the OS keychain; without it the card offers Once, Session and Deny only, and
  a first macOS access may show a keychain prompt.
- The revocation view cannot show a remembered command's arguments, only its program (or
  `(unnamed program)`), argument count and date.
- A grant binds the argv, not the files the program interprets nor the binary `argv[0]`
  resolves to, so in `auto` a model that can edit those files can change what a remembered
  command does.
- The card is a new approval surface. It needs the approval-path security sitting D63
  requires: exact rendering, no hidden affirmative key, no truncated approval, and a
  grant store that cannot be forged or resurrected.
- An allowlist entry with an unbalanced quote now stops the config load instead of silently
  matching nothing.

### Revision note — 2026-11-19

The ADR was Proposed on 2026-11-05 and revised on 2026-11-06; it had not been accepted when
the modes, the chord keys and the refusal return landed (ADR-0129 to ADR-0132). Revised in
place, not superseded, because it was never accepted. What changed: the mode table follows
ADR-0130 (a card in `ask`, a refusal in `plan`, headless hides the tool); "only unmodified
keys answer" is replaced by the chord rule; "Session like ADR-0057's `[a]`" is replaced by an
exact-argv session grant, because that cache is per tool id; remembered grants moved from the
global config to an ADR-0084-style append-only file, with the root also digested and bound
into the grant digest, a bounded file, a recovery command and a read-back of the key; the
allowlist grammar (§3), the shell warning and the no-Remember-for-shells rule, the
standing row, the `permissions` commands and the default agent's prompt were added; and the
decision that an allowlist miss reaches the host as a request rather than a thrown error was
recorded, so ADR-0117's allowlist class needs no denial of its own.
