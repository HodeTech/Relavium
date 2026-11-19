# Remembered command permissions

> Last updated: 2026-11-19

- **Status**: Reference — the grant store and `relavium permissions` are implemented on `development` (MVP-4 step 3). The card that asks, *Session* and *Remember* as answers, and the chat's `/permissions` are step 4 and are marked below; until then nothing writes a grant.
- **Surface**: CLI (`relavium permissions`, the chat's command card, `!`)
- **Scope**: A person's "Remember this command" answers, kept on one machine. Not the `[chat]` allowlist (config), not a workflow's allowlist, not MCP consent.
- **Related**: [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md), [ADR-0006](../../decisions/0006-os-keychain-for-api-keys.md), [commands.md](commands.md), [chat-session.md](chat-session.md), [keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [mcp-integration.md](../shared-core/mcp-integration.md#the-grant-store), [security-review.md](../../standards/security-review.md#sandbox-and-tool-policy-run_command-node-tools-secret-inputs)

A **remembered grant** marks one exact command — an exact argv under one project root — as
*pre-approved* on this machine. It exists because the alternative, listing every command in a repository
file, authorizes every future clone. Pre-approval matters only to the mode table in
[chat-session.md](chat-session.md#chat-modes--per-tool-approval-25e-adr-0057): `auto` runs a pre-approved
command without a card, while `ask` and `accept-edits` still show one, because a grant removes the
*unknown*, not the person's per-call consent. This page is the canonical home for the store's format,
bounds and commands; the decision and its reasoning are
[ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2, and the card
that offers *Remember* is specified by ADR-0118 §1 until step 4's reference lands.

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

## In the chat _(step 4)_

The command card offers *Session* (this exact argv, in memory), and *Remember* (`Ctrl+O` then Enter, proposed
in ADR-0118 §1) when the store reports it can write, the command is not a code carrier and the card names no
protected path; the chat's `/permissions` lists and revokes the same grants plus the session's own. Until
the card lands **nothing writes a grant and no session answer is offered**: the store, the mode logic that
honours a grant and the two commands above are in place and tested, and the surface that asks is not.
