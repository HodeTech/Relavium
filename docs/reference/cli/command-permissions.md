# Remembered command permissions

> Last updated: 2026-11-19

- **Status**: Reference — the grant store, `relavium permissions`, the command card with its *This session* and *Remember* answers, and the chat's `/permissions` are implemented on `development` (MVP-4 steps 3 and 4).
- **Surface**: CLI (`relavium permissions`, the chat's command card, `!`)
- **Scope**: A person's "Remember this command" answers, kept on one machine. Not the `[chat]` allowlist (config), not a workflow's allowlist, not MCP consent.
- **Related**: [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md), [ADR-0006](../../decisions/0006-os-keychain-for-api-keys.md), [commands.md](commands.md), [chat-session.md](chat-session.md), [keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [mcp-integration.md](../shared-core/mcp-integration.md#the-grant-store), [security-review.md](../../standards/security-review.md#sandbox-and-tool-policy-run_command-node-tools-secret-inputs)

A **remembered grant** marks one exact command — an exact argv under one project root — as
*pre-approved* on this machine. It exists because the alternative, listing every command in a repository
file, authorizes every future clone. Pre-approval matters only to the mode table in
[chat-session.md](chat-session.md#chat-modes--per-tool-approval-25e-adr-0057): `auto` runs a remembered
command without a card, until the session has approved a file write (then it asks once), while `ask` and
`accept-edits` still show one, because a grant removes the *unknown*, not the person's per-call consent. A
repository's own `[chat]` allowlist is not a pre-approval in `auto`: it is a file the person did not write, and the
command card says so in its standing row. This page is the canonical home for the store's format,
bounds and commands; the decision and its reasoning are
[ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2, and the card
that offers *Remember* is [the command card](#the-command-card) below.

## What a grant is, and is not

- **Exact.** A grant matches one argv. One keyed digest covers the whole argv with every element
  length-prefixed, so `npm test` never authorizes `npm test -- --exec=…`, and `["cat","a b"]` is a different
  command from `["cat","a","b"]`.
- **Root-scoped.** The root is the directory holding the nearest `.relavium/`, else the working
  directory, resolved to its real path (`realpath.native`, so case-insensitive spellings share one root) —
  so two paths to one tree share grants and a fresh clone elsewhere shares none. The chat and
  `relavium permissions` derive it with the same function, so a grant made in one is the grant the other
  lists.
- **Not a runtime guarantee.** A grant binds the argv, not what the program reads: `npm test` keeps being
  approved after `package.json`'s `test` script changes. ADR-0118 §2 records this as a decision, not a
  deferral.
- **Never the command.** The file holds keyed digests, so it cannot leak a credential typed in an argument
  and `relavium permissions list` has no command to print.

## The store

`~/.relavium/command-grants.ndjson`, mode `0600` in the `0700` directory, one JSON object per line,
**append-only with tombstones** — never rewritten, because an interrupted rewrite loses grants and losing a
*revocation* is the failure that matters. There is **no lock**. The path is read and written as a **regular
file only**: a symlink there is refused on every platform (an `lstat`), the open does not follow one and does
not block (`O_NOFOLLOW` and `O_NONBLOCK`, on the platforms that have them), and the descriptor is checked, so a
FIFO, a device or a directory reads as unreadable and a path swapped for a link or a FIFO between the read and
the write is neither written through nor waited on. The mode is set when the file is created and healed on
every write.

| Line | Shape |
|------|-------|
| grant | `{"v":1,"id":"<uuid>","root":"<hex64>","grant":"<hex64>","program":"<name>","args":<n>,"at":"<ISO-8601>","mac":"<hex64>"}` (`program` omitted when it could not be named) |
| revocation | `{"v":1,"revoked":"<id>","at":"<ISO-8601>"}` |

- `root` is HMAC-SHA256 over a version tag and the canonical root. `grant` is HMAC-SHA256 over a version tag,
  the `root` digest, a four-byte big-endian argument count and then **each element length-prefixed** (four
  bytes, big-endian), with NUL separators between the parts. Binding the root digest means a record copied among
  another root's lines never validates. Comparison is constant-time.
- `mac` is HMAC-SHA256 under the same key over a version tag and every other field (`id`, `root`, `grant`,
  `program`, `args`, `at`), NUL-joined. A record that was minted without the key, relabelled, or **copied
  under a new `id`** fails it and is ignored (reported once, without making the store unreadable).
- `at` must match `YYYY-MM-DDTHH:MM:SS[.fraction]Z`; any other value makes the line invalid, so a hand-edited
  time cannot carry a newline or an escape into a listing. `args` is an integer from 0 to 100,000 and `id` is
  1 to 64 of `[0-9A-Za-z-]`.
- `program` is the label `relavium permissions list` shows. It is kept only when `argv[0]`, taken whole, is
  a bare name (`^[A-Za-z0-9._+-]{1,64}$`) that resolves through the `PATH` to an executable when the grant
  is written; anything else — a path, a command line, an assignment such as `PGPASSWORD=…` — is
  `(unnamed program)`. A free-text `argv[0]` can itself be a credential, so no part of it is kept.
- The **digest key** is 32 random bytes from `node:crypto`, generated on the first *write* (after the file was
  read, so an unreadable file never leaves a key behind) and kept in the OS keychain under the account
  `relavium-internal:command-grants-digest-key`, beside the provider keys. A read never generates it. It never
  enters a file, a log or an event. An entry shorter than 32 bytes is not a key (it reads as unusable, and
  nothing is regenerated over it); `relavium permissions revoke --all` clears it. A running chat holds the key it
  read for its whole life.

**Folding.** A reader folds the whole file. A revocation names a grant `id` and holds **wherever it sits in
the file**, so a replayed or reordered grant line stays revoked. Two live records for one argv (two
processes that remembered it at the same moment) are **one** grant: `list` shows it once and `revoke`
withdraws both. The first record with an `id` wins. **A line that is not exactly a grant or a revocation —
it does not parse, has an extra or mistyped field, or an `id`, `program` or time of the wrong shape — makes
the whole store read as "no grants"** for that invocation: never skip the line, because a truncated line may
be a tombstone and skipping it would resurrect a revoked grant. The failure is reported once, with its
recovery. Each *different* failure is reported once.

**What the store defends against, and what it does not.** Forging, relabelling or minting a grant needs the
keychain key. A torn write, a replayed grant line and a reordered tombstone cannot bring a revoked grant
back. It does **not** defend against a process running as the same OS user: that process can delete a
*revocation* line (tombstones are not authenticated) and so bring its grant back, can restore an older copy of
the file, and can read the keychain key. `revoke --all` deletes the key as well as the file, so a restored
older copy stops validating once a new key is generated; deleting a grant line or the whole file only
removes trust.

### Bounds

| Bound | Value | Applied |
|-------|-------|---------|
| live grants per root | 64 | on write (the 65th is refused) and on read (a file with more reads as "no grants") |
| live grants in total | 1,024 | on write and on read |
| lines (blank lines are free; tombstones count) | 8,192 | on read; on write a grant needs two free lines, so one is always left for its tombstone |
| file size | 2 MiB | on read; on write a grant needs 1,024 bytes for its record and 256 for its tombstone |

A write that would pass a bound is refused and *Remember* is not offered. A `revoke <number>` is a tombstone
per record of the grant (one, or two when a grant has a twin) and is refused (`full`) when those lines or
256 bytes each would pass the line or size bound, rather than pushing the file past it, where every grant would
read as "no grants". Revoking a grant frees a per-root or total slot but never a line, so a store at the
line or size bound is recovered by `relavium permissions revoke --all`.

### When the store cannot answer

| Condition | Matching | Remember | `permissions list` | `permissions revoke <number>` | `permissions revoke --all` |
|-----------|----------|----------|--------------------|-------------------------------|----------------------------|
| keychain locked, denied, or holding an unusable entry | nothing matches | not offered | exit 2, names the keychain | exit 2, names the keychain | **works**; the key is not cleared (the failure is ignored) |
| no key generated yet (no grant was ever made) | nothing matches | offered; the first write generates the key | empty list, exit 0 | exit 2, no such grant | reports nothing to remove |
| file unparseable, a symlink or other non-regular file, or over a bound | nothing matches | not offered | exit 2 (`config_error`), names the file | same | **works** for a file, FIFO or symlink; a directory at the path is exit 1 (remove it by hand) |
| the file or its directory cannot be inspected (a permission) | nothing matches | not offered | exit 2 (`config_error`) | exit 2 | exit 1 (`storage_unavailable`): it tries to remove the file and reports a failure, never "nothing to remove" |
| the file cannot be written (a best-effort check in advance; the write re-checks) | unchanged | not offered | unchanged | exit 1 (`storage_unavailable`) | **works** if its directory can be written (removing a file needs the directory, not the file) |
| the directory cannot be written but the file can | unchanged | offered (appending needs the file, not the directory) | unchanged | works | exit 1 (`storage_unavailable`): removing a file needs the directory |
| a revoke would pass the line or size bound | unchanged | not offered | unchanged | exit 2 (`config_error`), names `revoke --all` | **works** |

## `relavium permissions list`

```bash
relavium permissions list [--json]
```

Lists this project's live grants, in file order, numbered from 1:

```text
Remembered commands for this project (2):
  1. npm  (1 argument)  remembered 2026-11-19T12:00:00.000Z
  2. (unnamed program)  (3 arguments)  remembered 2026-11-19T12:05:41.000Z
Revoke one with `relavium permissions revoke <number>`, or all of them with `relavium permissions revoke --all`.
```

`--json` writes one record per grant — `{ "index", "id", "program", "args", "grantedAt" }` — and nothing for
an empty list; the human form says *No remembered commands for this project.* Both exit `0`. Every label is
sanitized to one line before it is printed. Another project's grants are never listed.

## `relavium permissions revoke`

```bash
relavium permissions revoke <number> [--json]
relavium permissions revoke --all [--json]
```

- `<number>` is the number `list` printed: a plain decimal from 1 of at most six digits (no sign, padding,
  fraction or exponent). It appends a tombstone for that grant and the confirmation **names what was
  withdrawn** (`Revoked remembered command 2: npm, 1 argument. …`), because a number taken from an older listing
  can name a different grant once another process has revoked an earlier one. **The numbers close up
  afterwards**, so list again before a second revoke. A number that names no grant exits `2` and changes
  nothing.
- `--all` removes the **whole file**, which holds every project's grants, and says so, and deletes the digest key
  from the keychain (best effort: a locked keychain is ignored). It needs no project root and no readable
  file, so it is the recovery from a locked keychain, an unreadable file, an unusable key entry or a full
  store (a symlink at the path is removed, not what it points at). The next grant generates a new key.
- Exactly one of `<number>` and `--all`; neither or both is an invalid invocation (`2`). The refusal never
  echoes what was typed.
- `--json` writes `{ "action": "revoke", "index", "id", "program", "args" }` or
  `{ "action": "revoke-all", "removed" }`.
- A revoke that succeeded but whose confirmation could not be delivered exits `9` (`output_unavailable`);
  the grant is already gone.

`list` is a `read` and `revoke` a `destructive` entry of the [command manifest](commands.md#command-manifest).
Neither is reachable by the model: the manifest is a CLI projection, not a tool.

## The command card

A command reaches the person as the approval card the chat already has
([chat-session.md](chat-session.md#chat-modes--per-tool-approval-25e-adr-0057): docked, bounded, every affirmative
chord behind the dwell, quiet, typeahead and lockout guards) — in `ask` and `accept-edits` every command, even an allowlisted
or remembered one, and in `auto` every command except one the person remembered (while this session has approved no file
write) or approved for this session; the repository's allowlist does not skip the card there — with the additions of
[ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1. The `!` escape and a model's
`run_command` reach the same card; the `!` escape no longer sends anyone to a config file.

**What the card shows.**

- The title `Run <the whole command as one quoted line>`: the argv joined by the shared quoter, so `["cat","a b"]`
  (`cat 'a b'`) and `["cat","a","b"]` (`cat a b`) never read alike, a leading or trailing space and an empty argument are
  visible, and a line too long for the title rows is a **shortened target**, which keeps **every approving answer locked**
  until the person has read it all in the full view (`[v]`).
- One bare row per argument, the program first (the rows carry no labels; an empty argument reads `(empty)`), so each is
  delimited on its own line. A title that wraps continues under the command (indented by the verb), never at the margin of the
  argument rows. A command whose rows do not all fit the card (six elements fit at 80×24, with every answer, and a refusal note
  does not take a row from them) says `⚠ N rows of this command are not shown — press [v]` and offers only *Once* there, because
  *This session* and *Remember* are offered only while every row is on screen. That holds in the full view too: it lists every
  row and offers them while the whole command fits on its first page (about eight elements at 80×24, more on a taller terminal);
  a longer command can be answered *Once* only.
- `Standing: on this project’s allowlist | remembered for this project | not pre-approved` (the allowlist is the project’s
  file, not the person’s; a remembered command in `auto` after a file write says `remembered for this project; asks because
  files changed this session`), and `Runs in: <directory>` (the session workspace the host pins; never model-supplied; the two
  share one row while the directory keeps room to say where it is), then the warnings that apply, one row each, each worded as a
  fact and neither ever refusing a command: `⚠ Runs code: a shell, an inline script or a wrapper. Remember is not offered.` (a *code
  carrier*, below) and `⚠ Names a protected path (its output goes to the model). Allow once only.` A command card has no
  tool-identity row: its title already says `Run`, and the rows that are not shown are named in the warnings.
- Secret-shaped spans are masked, labelled (`N masked values in this command`) and counted by the existing masking. On a command card **every** masked span must be
  revealed and displayed before an approving answer counts (a file card requires only the flagged ones), because a masked
  argument is exactly where a command could hide what it does. Control characters, line separators and invisible code points
  show as visible escapes (`<U+001B>`), never as terminal controls.
- The same rows head the command's **full view**, which ends on `Approving runs exactly this command; file-tool path rules do
  not limit it.` (not on the file cards' sentence that approval cannot override protected paths).
- The transcript row of a command names the program and how many arguments it had (`npm (4 arguments)`), never an argument; `/details`
  shows the command.
- A command with more than 63 arguments, or any argument or the quoted line over 4,096 characters, cannot be shown in full;
  its card is **blocked**: it says `A command is waiting, but it is too large for this card to show …`, no approving answer
  counts, `Ctrl+N` (and `Esc`) still answer, and the refusal reaches the model as a `mode` refusal with a fixed label (the host's
  limit, never the person's words) telling it to run smaller commands. A command card the host cannot build a preview for is
  refused the same way instead of being drawn empty.

**The answers** (each affirmative one is a Ctrl chord typing cannot produce):

| Answer | Key | Offered when |
|--------|-----|--------------|
| Once | `Ctrl+Y` | a card that can be shown; locked until every requirement to read it is met (a shortened target, a masked span) |
| Allow this session | `Ctrl+G`, then Enter | the command names no protected path, and the page shows the whole command (the card, or the full view) |
| Allow + remember | `Ctrl+O`, then Enter | the store can write one (key usable, file readable and writable, room under the bounds), the command is not a code carrier, names no protected path, is not already pre-approved (on the allowlist or remembered), and the page shows the whole command |
| Deny | `Ctrl+N` | always, even on a blocked card; a denial returns to the model |
| Deny with a reason | `Ctrl+R` | on a card that can be shown; the denial returns to the model with the person's words |
| Stop | `Esc` or `Ctrl+C` | at the card and outside a text box (in the reason box or a search box `Esc` only closes the box); rejects the call and stops the turn (only `Ctrl+C` also starts the exit window) |

*This session* approves this **exact argv** for the rest of this session instance (in memory, gone on `/exit`, and it asks
again after a resume). *Remember* writes the grant at the moment of the answer — it is consent to the command, not to its
outcome — and then behaves as *This session* too, so the same command does not ask again in this chat. A Remember that
cannot be written approves this call only and the chat says why, in fixed words that never contain the command. An answer
the card did not offer is narrowed to *Once* by the hook, whatever the prompt returned. The questions read `Press Enter to allow this
exact command for this session` and `Press Enter to allow this exact command now and remember it for this project`, both with
`Enter confirms · any other key cancels, allowing nothing`; an Enter that comes too early or too late says `Too early or too late
for Enter — nothing was allowed.` A Remember written as the call is cancelled leaves the grant, and says so.

The session approval a *Remember* leaves is **linked to its grant**: withdrawing the grant from this chat's `/permissions` sheet
withdraws it too. A chat that is already open keeps its own session approval of a command revoked elsewhere (from
`relavium permissions revoke`, or another chat) until the person withdraws that row in its sheet, and the sheet's answer says so.

A session export (`/export`) carries no authority: a session that used `run_command` exports `tools: [run_command]` and no
allowlist, neither the remembered commands nor this session's approvals. A workflow has no one to ask, so the scaffolded node
cannot run a command until the person writes the allowlist, as it is for the network tools and their allowed domains.

**Code carriers.** A closed table over the argv, a speed bump that names the common ways of hiding a script in one argument
and **not a security boundary** (the boundary is the full command on the card, exact-argv matching and `auto`'s hard edge).
Names are compared by base name, case-folded, with a Windows drive designator without a separator (`C:cmd.exe`), a trailing
`.exe`, a Windows alternate-stream suffix (`:…`) and trailing dots or spaces removed (`cmd.exe.` is `cmd`), and an interpreter's
version digits ignored (`python3.12` and `node22` are `python` and `node`). The table lives in
`apps/cli/src/chat/command-facts.ts`:

- *shells* — `sh`, `bash`, `zsh`, `dash`, `fish`, `ksh`, `csh`, `tcsh`, `pwsh`, `powershell`, `cmd` — in any invocation;
- *interpreters given inline code* — `python`, `python3`, `pypy`, `py`, `node`, `nodejs`, `deno`, `bun`, `perl`, `ruby`, `php`,
  `lua`, `osascript` — when any argument is exactly `-c`, `-e`, `-E`, `-p`, `-r`, `--eval`, `--command` or `--print`, or, among
  the interpreter's own leading options, is `--eval=…`, `--command=…`, `--print=…` or a short cluster holding one of those letters
  (`-Ic`, `-pe`, `-ne`); `deno eval` is one too (`node build.js` and `python -m pytest -rA` are not flagged);
- *wrappers that run another command* — `env`, `sudo`, `doas`, `xargs`, `nohup`, `nice`, `timeout`, `time`, `stdbuf`,
  `exec`, `command`, `ssh`, `watch`, `busybox`, `toybox`, `wsl`, and `find` with `-exec`, `-execdir`, `-ok` or `-okdir`; the wrapped command is not
  parsed, the wrapper is flagged.

A code carrier is answered Once or This session: Remember is not offered, and its card says so. The table does not catch everything (`make`,
`npm run`, a `git` alias, `awk`, `vim -c` carry code too).

**A protected path.** An argument — and the text after the first `=` or `:` of any argument (`--flag=value`, `KEY=value`,
`git show HEAD:.env`, `host:.ssh/id_rsa`), after a leading `@` (`curl -d @.env`) or after an attached one-letter option (`-d@.env`) —
resolved lexically against the working directory is a path the file tools' read floor would refuse (`.env`, `.ssh`, `.aws`, `.docker/config.json`, credential dotfiles,
`.relavium`) or the write floor protects (`.git`, startup files). The program's own name and a flag are not paths (a workspace that itself sits under a credential directory would otherwise put the
warning on every command). The card says so (`⚠ Names a protected path (its output goes to the model). Allow once only.`) and the only
answer that approves is *Once*. Nothing is resolved on disk and no shell expansion is imagined: the command is spawned without a shell.

**In the chat: `/permissions`, a sheet.** ([ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2.) The bare `/permissions` opens a docked, keyboard-owning sheet under the
conversation, where `/models` and `/effort` open, with the transcript still above it. The command takes **no argument**: the typed
`--revoke <number>` forms are gone, because a typed number is a position and the sheet names a row. On a plain, `--json` or one-shot
chat, which has no store and no one to ask, `/permissions` says `Remembered commands are not available in this chat.`

```text
Permissions · ask mode
This project · remembered (2)
› npm, 1 argument                            remembered 2026-11-19 12:00Z
  node, 1 argument                           remembered 2026-11-18 09:30Z
This session · approved (1)
  git status                                 (also remembered)
Remembered commands still ask here; only auto mode runs one unasked.
<message row: a withdrawal's question, or its answer>
↑/↓ select · d withdraw · Esc close
```

- **Rows.** A remembered row shows the label the store can give (a program's name only where it could be named without risking a
  credential, and the argument count: `npm, 1 argument`) and when it was remembered, to the minute (UTC) so two grants of one
  program can be told apart — never an argument. A session row shows the approved command, quoted and **scrubbed by the same
  function the command card's title uses**, with every control, invisible or `<` character shown as a visible `<U+…>` token; it is
  marked `(also remembered)` when a *Remember* made it or a remembered grant covers the command now. There are no row numbers: the
  cursor is the selection.
- **Surfaces.** A chat's title is `Permissions · <mode> mode` and it shows both sections; the bare Home and a bare
  `relavium permissions` on a TTY (MVP-4 step 7; until it lands only a chat opens the sheet) show `Permissions · this project` and the project's section only. The note row says what a grant
  is worth in the mode (only `auto` runs a remembered command unasked, and asks once after a file write; `plan` refuses every
  command). An empty list says what to do (`Press Ctrl+O on a command card to remember one.`).
- **Keys.** `↑`/`↓` move and clamp (`PgUp`, `PgDn`, `Home`, `End` too). `d`, `Delete` or `Backspace` **arms** the selected row: the
  message row asks `Withdraw <row>? Enter withdraws · Esc keeps it` and the legend becomes `Enter withdraw · Esc keep`. `Enter`
  withdraws; any other key, a paste and `Esc` keep the row. `Esc` closes an idle sheet; `Ctrl+C` closes it from either state. Neither
  closing key ever withdraws, and nothing is added or edited here: a grant is a digest of an exact argv, and one can only be made on
  a command card.
- **Withdrawing is by identity.** A remembered row is held by its grant `id` and a session row by its exact argv. The store is read
  again before a project withdrawal; a row that is gone says `That row was already withdrawn.` and the sheet reloads. Two records of
  one argv are one grant and both are withdrawn. Withdrawing a remembered row also takes this chat's linked session approval; a
  session row withdrawn while a remembered grant covers the command says `Still remembered: auto mode runs it unasked.` The answers say
  what was withdrawn and name only `auto` as the mode that asks again, because no other mode ran a remembered command unasked.
- **Failures.** A store that cannot be read shows its fixed sentence (`The OS keychain is not available…`, `The remembered-commands
  file could not be read…`) in place of the rows, and the session section still works; a withdrawal that cannot be written leaves the
  row and says so in one short row.
- **Bounds.** At most three fifths of the terminal and at least eight transcript rows stay above (the card's rule), at most eight body
  lines with `▲ n more` / `▼ n more` markers; the title, the message row and the legend are always drawn and the note is the first row
  to go. Below 80×24 the sheet says `Enlarge the terminal to use this screen — Esc closes.` and `d` arms nothing.
- **Inline renderer and colour off.** It works in the inline renderer (it is docked like the other overlays) and reads the same with
  colour off: the `›` marker, the headings and the markers carry the meaning.

The Home's tab bar and its pane that composes this sheet with the domain allowlists, MCP servers and egress endpoints are MVP-8's;
add and remove belong to those sections, not to command grants.
