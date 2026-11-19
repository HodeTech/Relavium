# Troubleshoot tool denials

- **Status**: Operational guidance for locally implemented/reviewed ADR-0127; public-guide release delivery remains a separate check.
- **Date**: 2026-11-15
- **Related**: [chat failure guidance](../reference/cli/chat-session.md#denial-guidance-design--adr-0127), [native metadata contract](../reference/cli/native-filesystem-metadata.md), [chat modes](../decisions/0057-cli-chat-modes-and-per-tool-approval.md)

A `tool_denied` result means the attempted tool call was refused. It does not
identify mode as the cause. Read the displayed reason first. The session can
remain active even though that turn did not complete; that alone does not
guarantee the failed request remains in model history.

An optional rejection explanation is diagnostic text, not a private note for
the approval editor. Under the accepted correction, known secret shapes and
terminal controls are sanitized before submission and display, and the text
may appear in TUI, plain or redirected session output and existing event/error
messages. That finite protection cannot recognize every personal detail or
secret fragment. Do not enter credentials or information you do not intend to
include in diagnostics. Use a build containing the corrected producer/display
pipeline; terminal stripping alone does not redact a typed explanation.

## Identify the refusal

| Reported reason or situation | Next action |
|---|---|
| The session is in `plan` mode, or no one can answer (a plain, `--json` or one-shot run) | The write was not applied and the model was told so; it should explain what it would do. Inspect `/mode`. `plan` is read-only by design: choose `ask` (a card for each write), `accept-edits` (file edits applied without a card) or `auto` deliberately. Mode changes do not override filesystem or confidentiality checks. A run with no terminal cannot be answered at all. |
| You declined a card (`Ctrl+N`, or `Ctrl+R` with a reason) | The model was told, with your words if you gave any, and the turn continues; it will not repeat the identical call this turn. Give a revised instruction if you want different work. `Esc` or Ctrl-C instead stops the whole turn. |
| The turn ended with `tool_failed` | The footer names the tools whose calls failed and how often. The model gets three corrections: the fourth consecutive round in which no call succeeded ends the turn (ADR-0131). Check the named tools' targets, then resend or narrow the request; an engaged turn that ended in an error keeps your message, the calls that ran and a fixed note in the session (ADR-0119), so the model can answer "what failed?" — except when the provider returned nothing before the turn ended (a refusal under any code, a timeout, or an Esc before the first chunk), which is dropped as before and leaves your message out of the next request. |
| The target is outside the session's granted workspace, protected or confidential | Confirm the actual tool target and the session's selected project/workspace. Use the intended authorized target; project files cannot enlarge invocation grants. A write to a protected directory (`.git`, `.ssh`, `.relavium`) or a shell startup file is refused with one fixed text that **returns to the model** (the turn continues and the model picks another path); a write to a credential store (`.env`, `.npmrc`, `.aws`, …) or through a link into a protected directory ends the turn with `tool_denied`. |
| Filesystem metadata preparation was refused | Follow the read-only checks below. The filesystem, supported metadata, access policy or changed evidence may prevent the write; the aggregate message does not diagnose a specific attribute or OS error. |
| An effect needs attention or write/cleanup could not be confirmed | Inspect the actual target before deciding what to do next. Content may already have changed. Keep the audit/recovery evidence; do not blindly resend or treat the problem as a mode denial. |

The exact supported filesystem profiles and failure states belong to the
[native metadata contract](../reference/cli/native-filesystem-metadata.md), not
to a universal OS permission recipe.

## Inspect a metadata refusal safely

1. Confirm the target from the tool details/approval and the session's pinned
   project/workspace. A later terminal `pwd` does not prove the root of an
   already-running session. A new file depends on its destination parent;
   an existing-file edit also depends on the source's own policy and metadata.
2. On macOS, inspect names and permissions locally without changing them:

   ```bash
   /usr/bin/xattr "/absolute/path/to/destination-parent"
   /usr/bin/xattr "/absolute/path/to/existing-file"
   /bin/ls -lde "/absolute/path/to/destination-parent" "/absolute/path/to/existing-file"
   ```

   Omit the existing-file commands when creating a file that does not exist.
   `xattr` with no modifying option lists names; do not add `-l`, `-p`, `-d`,
   `-c` or `-w` to this inspection. ACL output and paths can contain personal
   information: inspect them locally and redact them before sharing.
3. Check the profile applicable to the actual build and filesystem. The
   [ADR-0127 role distinction](../reference/cli/native-filesystem-metadata.md#macos-parent-and-file-attribute-profiles--adr-0127)
   permits a bounded parent MACL as unchanged evidence; it does not authorize
   transferring that label to a child or editing a file with its own MACL.
   The ADR-0127 correction is implemented and locally accepted (see the
   [acceptance record](../roadmap/phases/phase-2.6-conversational-authoring.md#adr-0127-final-local-source-acceptance-2026-11-15));
   a build older than that correction can still refuse both the observed parent
   MACL and last-used file name, so check which build you run.
4. If the OS denies access, have the owner review the intended access policy.
   If metadata is unsupported or evidence cannot be read/proved, keep the
   target as-is and report the bounded reproduction to the maintainer. The
   absence of a visible ACL or ordinary write mode bits alone does not prove
   that all OS access checks permit the operation.

Changing to auto mode cannot make unsupported metadata safe. Do not clear
attributes, remove quarantine, copy consent labels, disable privacy/security
features, grant broad OS access, run with elevated privileges, or repeatedly
resend the same request as a workaround. A rename-based content write must not
silently discard the original file's security metadata.

An ordinary preparation refusal stops that specific attempt before publication;
earlier calls in the turn may still have effects. A failure after a durable
claim or possible publication is a separate uncertainty case, even if the
caller ultimately reports cancellation. Follow its attention disclosure.

## Report a useful reproduction

Include the actual CLI build/version, OS version/architecture, filesystem type,
mode, operation (create/overwrite/append/edit), and the displayed fixed reason.
State whether a clean scratch case differs from an existing project case and
whether the target exists. Share only necessary, reviewed attribute **names**
and redacted path information; never upload raw MACL/ACL values, tokens, native
error dumps, an entire history database or unrelated file contents.

Contributors validating the implementation use the separate
[macOS verification procedure](verify-macos-write-metadata.md). Those controlled
probes and fixtures are acceptance work, not a user repair for an existing file.
