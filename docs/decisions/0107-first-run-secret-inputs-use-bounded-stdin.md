# ADR-0107: First-run secret inputs use bounded stdin

- **Status**: Accepted
- **Date**: 2026-10-12
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)

## Context

Wave 2 #25 requires rejecting a declared secret passed through `run --input`.
The current CLI treats it as a string, exposing credentials through argv, shell
history and CI command logs. This is not a claim that declared secret-input values
are written into `history.db`: engine admission already replaces their durable input
slots with masked references under ADR-0083. Authored literals in unrelated snapshot
fields remain the separately documented #30 risk.
Refusal alone would leave required-secret workflows without a first-run CLI path.
ADR-0083 already has stdin-only resupply on gate resume and specifies caller-supplied
workflow secrets, not automatic provider-keychain lookup. The roadmap's keychain
hint is therefore stale. The shared stdin reader also lacks an aggregate byte cap.

This proposal adds a CLI surface, requires approval before implementation, and
preserves engine admission, masked durable inputs and provider key custody.

## Decision

We will add `relavium run --secret-inputs-stdin` and reject every explicitly supplied
secret-typed ordinary `--input`, including an empty value, before provider/key,
history or MCP work. Malformed argv diagnostics must not echo argument values.
Omitted optional secrets remain absent; required secrets must be supplied.

The boolean flag reads a non-TTY stdin once. A TTY stdin is refused with a fixed,
payload-free pipe hint before reading or starting key/provider/history/MCP work;
redirecting stdout does not bypass this stdin check. Reuse one CLI-local line parser with
`gate --secret-stdin`: first `=`, trimmed name, verbatim value, CRLF handling, ignored
blank lines, and duplicate/unknown/non-secret names refused. Empty/whitespace-only
secret values refuse. Merge into a fresh prototype-safe input map and retain core's
final typed validation. Gate's established flag/name stays unchanged.

Apply a 64 KiB aggregate UTF-8 byte ceiling to the common reader before accumulating
or concatenating chunks, including a single oversized chunk. Assemble split Unicode
Buffer chunks faithfully; preserve payload whitespace. Provider set-key owns its
existing trimming policy; gate/run line parsers preserve values. Reader errors are
fixed and payload-free and release the iterator on refusal.

Once stdin is consumed, gate prompts and MCP consent use existing noninteractive
policy; they cannot reread the secret pipe as user confirmation. A later unresolved
workflow gate exits with the existing pending-gate status. Existing explicit stdio
consent flags remain the operator path; this flag grants no tool/transport authority.

This adds no environment-secret transport, secret-valued flag, inferred keychain
lookup, durable raw input, unredacted diagnostic or new runtime dependency. Process
memory necessarily contains supplied values while the run uses them; it is not a
promise to prevent an operator's shell from logging how it produced stdin.

Rejected argv-plus-warning (exposure already happened), keychain-name guessing
(wrong namespace and no author contract), and rejection without a replacement path
(strands required-secret workflows). A hidden interactive entry UI remains outside
this increment; bounded stdin works consistently in scripts/headless hosts.

On acceptance update [CLI commands](../reference/cli/commands.md),
[workflow inputs](../reference/contracts/workflow-yaml-spec.md),
[keychain/secrets](../reference/desktop/keychain-and-secrets.md) and a dated note in
ADR-0083. The workflow reference owns input provenance; the command reference owns
flag/output behavior. Do not redact the faithful admitted workflow snapshot.

## Acceptance obligations

1. Actual Commander/dispatch forwarding reaches run admission, with normal and JSON
   output. Invalid argv/stdin causes zero key/provider/history/MCP effects and echoes
   no planted opaque value, including verbose diagnostics.
2. For `run --secret-inputs-stdin`, TTY stdin, including redirected stdout, refuses
   without reading stdin or starting key/provider/history/MCP work; non-TTY delivery
   is a positive control. Provider/gate consumers retain the shared reader's TTY
   refusal. Exact-cap/+1, Buffer/string/multi-chunk/Unicode, whitespace and early
   iterator cleanup controls exercise the shared reader and provider/gate/run consumers.
3. Duplicate, unknown, non-secret, missing required, optional omitted and prototype-like
   names exercise real workflow admission; ordinary typed inputs remain unchanged.
4. Successful first run persists masked slots only; resume still needs resupply.
   Noninteractive later-gate and MCP-consent controls prove stdin is never reused.
5. Causal removal controls pin the argv refusal, reader bound, flag forwarding and
   persistence masking. Required gates and the secrets-input security sitting pass.

## Consequences

### Positive

- Required-secret workflows have a first-run path without credential-valued argv.
- First-run and resume share parsing, bounds and value-preservation behavior.

### Negative

- Secret stdin opts out of interactive approval; document pending-gate/resume and
  explicit MCP consent so callers can choose the right invocation.
- A finite input cap can reject existing oversized pipes; report the byte limit
  without reflecting contents and document the compatibility tightening.

### Maintainer acceptance — 2026-10-12

The maintainer approved the revised decision and the eight-step Wave 2 execution
plan after the ten-comment intake and two fresh independent cumulative proposal
reviews. Dependent implementation is authorised on `development`; acceptance of
this decision does not certify unimplemented mechanisms or close the wave.
