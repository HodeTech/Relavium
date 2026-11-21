# ADR-0138: A file write the chat applied is remembered for the project, and it outdates the grants made before it

- **Status**: Accepted — 2026-11-21, by the maintainer, answering the PR #101 review (finding S2: the write marker is shorter than a session). Implementation: the MVP-4 review-fix increment (see the notes at the end).
- **Date**: 2026-11-21
- **Amends**: [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §2 (the rule "a remembered command asks once in `auto` after this session approved a file write": the write is no longer only this session's, and the asking is not "once").
- **Related**: [ADR-0118](0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1 and §2, [ADR-0130](0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md) (the modes), [ADR-0137](0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) (the sheet withdraws a grant), [command-permissions.md](../reference/cli/command-permissions.md) (the store and its failure table).

## Context

ADR-0118 §2 lets `auto` run a command the person remembered without a card, and then asks about it once after the session has approved a file write, because a write may have changed what the command does (`npm test` after `package.json`'s `test` script changed). The flag that carries that fact lives in the chat's in-memory approval cache. The review of PR #101 found what that costs:

- **It ends with the chat instance.** `/clear` ends the session; a model reseat (`/models`) rebuilds the session around the same conversation; a resume and a new process start a fresh cache. In `accept-edits` a model can edit `package.json` with no card, the person can `/clear` and switch to `auto`, and the remembered `npm test` then runs unasked.
- **The documents said "this session".** They did not say that the next chat forgets.

The rule is not a runtime guarantee (ADR-0118 §2: a grant binds the argv, not what the program reads), and it cannot see a write made by an editor or a shell. It is a mitigation for the writes the product itself applies, and a mitigation that a keystroke resets is not worth the sentence that describes it.

## Decision

**A file write that a chat of this machine applies is recorded against the project's root, and a remembered grant that is older than the latest such write asks again in `auto`.**

1. **The mark.** When the approval hook approves a file write (any mode that approves one, `ask`'s card included), it records the time against the project root, in `~/.relavium/command-write-marks.json`, beside the grants file. The in-memory flag stays: it is the same rule inside one chat and the fallback when the file cannot be written.
2. **The rule.** A grant is **fresh** when its latest record (a grant and its twins are one grant; a renewal is a twin dated later) is strictly newer than the root's mark, or when the root has no mark; otherwise it is **stale**. `auto` runs a fresh grant unasked and asks about a stale one. `ask` and `accept-edits` ask about every command either way, as ADR-0118 §1 says.
3. **Renewal.** *Remember* is offered for a stale grant (and for an unremembered one, a listed one included: the repository's allowlist pre-approves nothing in `auto`, so a grant is what the person adds). It appends a new record for the same argv, which folds into the one grant and dates it now. Nothing else renews a grant: a *Session* answer ends the asking for that chat only, and the next chat asks again until the grant is renewed.
4. **The file.** One small JSON file, replaced whole (a sibling written with the owner-only mode, then renamed over), because nothing in it is a revocation: losing it can only make a remembered command run unasked again, which is what the chat without the file did. Each entry is keyed by the root digest the grants use and authenticated by the installation key; an entry that does not verify is ignored. At most 256 roots (the oldest is dropped) and 64 KiB. The format and failure table are in [command-permissions.md](../reference/cli/command-permissions.md).
5. **It fails toward asking.** A mark file that cannot be read (a symbolic link, a directory, a bad shape, over the bound) makes every remembered command stale, is told once, and is **not** overwritten: replacing an unreadable file would give every other project a clean slate. `relavium permissions revoke --all` removes it with the grants and the key. A mark that cannot be written is told once and leaves the in-memory flag as the rule for this chat. A write applied while the keychain is unavailable (no key, so no root digest and no MAC) is recorded as one unauthenticated time, `unkeyed`, that outdates every grant older than it whatever its root: it can only make a grant stricter, and without it a chat over a locked keychain could edit `package.json` and a later chat would run the remembered command unasked.
6. **What does not count.** A command the person approved on a card (*Once* or *Session*) is not a write for this purpose, even when it is `sed -i`: the card showed the whole command and the person answered it. A write made outside the product is invisible to the mark, as it was to the flag. So is a file written by an MCP tool (an egress-class action), and a write by a chat rooted at a parent directory to a nested project whose root is its own: the mark is recorded against the root of the chat that applied the write. Both are recorded in the reference, not left implicit.

**Considered, and rejected:**

- *Keep the flag per chat and document it* — the cheapest, and a mitigation that `/clear` resets.
- *Carry the flag across a model reseat only* — fixes the one case where the conversation continues, and leaves the `/clear` and resume cases that the scenario above uses.
- *Record every write as a line of the grants file* — the file is append-only and fail-closed at 8,192 lines; a line per approved write would exhaust it.
- *Count every approved process command as a write* — it makes a *Once* for `ls` outdate every grant, and teaches people to answer *Remember* to stop being asked.
- *A timer instead of a mark* — a grant that expires on a clock asks again for no reason the person can see; a grant that a recorded write outdates asks for a reason the card states.

## Consequences

### Positive

- The mitigation lasts as long as the project does, across `/clear`, a reseat, a resume and a new process.
- A grant's age is a fact the card can state (*asks because files changed since*), and renewing it is the one answer the card already has.
- No new keychain entry and no new key: the marks use the grants' root digest and installation key.

### Negative

- **A project where files are written often keeps asking.** The person renews a grant with *Remember* after a write, or answers *Session*; `accept-edits` and `auto` sessions that edit files will outdate every older grant. This is the point of the rule, and it is the cost of it.
- **Two processes can lose a mark.** The file is replaced whole with no lock, so two chats of different projects that write in the same instant can drop one entry; a lost mark makes that project's grants fresh again, which is the behaviour before this ADR. Recorded, not engineered away.
- **The same-account limit stands.** A process running as the same operating-system user can delete the file or restore an older grants file; ADR-0118 §2 already records that the store does not defend against it.
- **One more file in `~/.relavium`** to describe, to remove with `revoke --all` and to test on three platforms.

## Implementation notes

### 2026-11-21 (the PR #101 review-fix increment)

`apps/cli/src/permissions/write-marks.ts` (the file), `file-state.ts` (the read discipline both permission files now share), the store's `standing` and `noteFileWrite`, the hook's use of both, the card's standing row (`asks because files changed since`) and the offers of *Remember*. The tests are `write-marks.test.ts` and the hook and card tests beside the code they pin.

### 2026-11-21 (the independent review round of the increment)

A security sitting (Opus) and a correctness review (Sonnet) of the increment found no blocker or high finding and one medium, which is fixed: **a write made while the keychain was unavailable was never recorded** (the first version said "nothing to protect", but the grants verify again when it answers); it is now the `unkeyed` mark of §5. Also fixed, each with a test that fails without it: `noteFileWrite` reads the key afresh and a rewrite keeps entries it cannot verify (a chat with a replaced key erased a newer key's marks); `revoke --all` removes the marks only after the grants file is gone; *Remember* is not offered, and a direct request is refused, while the marks cannot be read; the card's gate (`canRemember(argv)`) lets a grant at the per-root bound be renewed; the card says "asks because files changed since" only in `auto`, the one mode that consults a grant; the stored note for a carried `!` command is the scrubbed line; `list` counts the records it ignored even when the key is gone. Recorded, not fixed (the register has the entries): a clock set ahead keeps a grant fresh past a later write (the mark never moves back, and a renewal needs a strictly later time); a renewal in the same millisecond as the mark stays stale; the nested-root and MCP-write limits of §6.
