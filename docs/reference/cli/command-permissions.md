# Remembered command permissions

> Last updated: 2026-11-19

- **Status**: Reference — the grant store and `relavium permissions` are implemented on `development` (MVP-4 step 3). The card that asks and the chat's `/permissions` are step 4 and are marked below.
- **Surface**: CLI (`relavium permissions`, the chat's command card, `!`)
- **Scope**: A person's "Remember this command" answers, kept on one machine. Not the `[chat]` allowlist (config), not a workflow's allowlist, not MCP consent.
- **Related**: [ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md), [ADR-0084](../../decisions/0084-consent-before-a-local-mcp-spawn.md), [ADR-0006](../../decisions/0006-os-keychain-for-api-keys.md), [commands.md](commands.md), [chat-session.md](chat-session.md), [mcp-integration.md](../shared-core/mcp-integration.md#the-grant-store), [security-review.md](../../standards/security-review.md#sandbox-and-tool-policy-run_command-node-tools-secret-inputs)

A **remembered grant** lets one exact command — an exact argv under one project root — run in the chat
without the person being asked again. It exists because the alternative, listing every command in a
repository file, authorizes every future clone. This page is the canonical home for the store's format,
bounds and commands; the decision and its reasoning are
[ADR-0118](../../decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2, and the
card that offers *Remember* is specified with the approval-preview contract.

## What a grant is, and is not

- **Exact.** A grant matches one argv, compared element by element after hashing. `npm test` never
  authorizes `npm test -- --exec=…`, and `["cat","a b"]` is a different command from `["cat","a","b"]`.
- **Root-scoped.** The root is the directory holding the nearest `.relavium/`, else the working
  directory, resolved to its real path — so two paths to one tree share grants and a fresh clone
  elsewhere shares none. The chat and `relavium permissions` derive it with the same function, so a grant
  made in one is the grant the other lists.
- **Not a runtime guarantee.** A grant binds the argv, not what the program reads: `npm test` keeps being
  approved after `package.json`'s `test` script changes. ADR-0118 §2 records this as a decision, not a
  deferral.
- **Never the command.** The file holds keyed digests, so it cannot leak a credential typed in an argument
  and `relavium permissions list` has no command to print.

## The store

`~/.relavium/command-grants.ndjson`, mode `0600` in the `0700` directory, one JSON object per line,
**append-only with tombstones** — never rewritten, because an interrupted rewrite loses grants and losing a
*revocation* is the failure that matters. A symlink at the path is refused. There is **no lock**: two
processes appending the same grant is idempotent, and file order resolves a revoke racing a re-grant.

| Line | Shape |
|------|-------|
| grant | `{"v":1,"id":"<uuid>","root":"<hex64>","grant":"<hex64>","program":"<name>","args":<n>,"at":"<ISO-8601>"}` (`program` omitted when it could not be named) |
| revocation | `{"v":1,"revoked":"<id>","at":"<ISO-8601>"}` |

- `root` is HMAC-SHA256 over a version tag and the canonical root; `grant` is HMAC-SHA256 over a version
  tag, the `root` digest and the argv, **each element length-prefixed** (four bytes, big-endian). Binding
  the root digest means a record copied among another root's lines never validates. Comparison is
  constant-time.
- `program` is the label `relavium permissions list` shows. It is kept only when `argv[0]`, taken whole, is
  a bare name (`^[A-Za-z0-9._+-]{1,64}$`) that resolves through the `PATH` to an executable when the grant
  is written; anything else — a path, a command line, an assignment such as `PGPASSWORD=…` — is
  `(unnamed program)`. A free-text `argv[0]` can itself be a credential, so no part of it is kept.
- The **digest key** is 32 random bytes from `node:crypto`, generated on the first *write* and kept in the
  OS keychain under the account `relavium-internal:command-grants-digest-key`, beside the provider keys. A
  read never generates it. It never enters a file, a log or an event.

A reader folds the file in order, a revocation removing the grant it names. **Any unparseable line makes
the whole store read as "no grants"** for that invocation — never skip the line, because a truncated line
may be a tombstone and skipping it would resurrect a revoked grant — and the fold failure is reported once
with the recovery below.

### Bounds

| Bound | Value |
|-------|-------|
| live grants per root | 64 |
| live grants in total | 1,024 |
| lines (tombstones included) | 8,192 |
| file size | 2 MiB |

A write that would pass a bound is refused and *Remember* is not offered until grants are revoked. A file
that already passes one reads as "no grants". `relavium permissions revoke --all` always recovers.

### When the store cannot answer

| Condition | Matching | Remember | `permissions list` | `permissions revoke <number>` | `permissions revoke --all` |
|-----------|----------|----------|--------------------|-------------------------------|----------------------------|
| keychain locked, denied or absent | nothing matches | not offered | exit 2, names the keychain | exit 2, names the keychain | **works** (needs no key) |
| no key generated yet (no grant was ever made) | nothing matches | offered; the first write generates the key | empty list, exit 0 | exit 2, no such grant | reports nothing to remove |
| file unparseable or over a bound | nothing matches | not offered | exit 2 (`config_error`), names the file | same | **works** |
| file or directory not writable | unchanged | not offered | unchanged | exit 1 (`storage_unavailable`) | exit 1 (`storage_unavailable`), never "nothing to remove" |

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
stripped of terminal control sequences before it is printed, because the file is plain text a person could
edit. Another project's grants are never listed.

## `relavium permissions revoke`

```bash
relavium permissions revoke <number> [--json]
relavium permissions revoke --all [--json]
```

- `<number>` is the number `list` printed: a plain decimal from 1 (no sign, padding, fraction or
  exponent). It appends a tombstone for that grant. **The numbers close up afterwards**, so list again
  before a second revoke; the confirmation says so. A number that names no grant exits `2` and changes
  nothing.
- `--all` removes the **whole file**, which holds every project's grants, and says so. It needs neither the
  keychain nor a readable file, so it is the recovery from a locked keychain, an unreadable file or a full
  store. The digest key stays in the keychain: the next grant reuses it.
- Exactly one of `<number>` and `--all`; neither or both is an invalid invocation (`2`). The refusal never
  echoes what was typed.
- `--json` writes `{ "action": "revoke", "index", "id" }` or `{ "action": "revoke-all", "removed" }`.
- A revoke that succeeded but whose confirmation could not be delivered exits `9` (`output_unavailable`);
  the grant is already gone.

`list` is a `read` and `revoke` a `destructive` entry of the [command manifest](commands.md#command-manifest).
Neither is reachable by the model: the manifest is a CLI projection, not a tool.

## In the chat _(step 4)_

The command card offers *Remember* on `Ctrl+O` then Enter when the store reports it can write, the command
is not a code carrier and the card names no protected path, and the chat's `/permissions` lists and revokes
the same grants plus the session's own. Until the card lands **nothing writes a grant**: the store, the
mode logic that honours a grant (`ask` and `accept-edits` still show a card for it, `auto` runs it) and the
two commands above are in place and tested, and the surface that asks is not.
