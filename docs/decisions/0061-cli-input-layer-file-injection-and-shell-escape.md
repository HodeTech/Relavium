# ADR-0061: CLI chat input-layer file-injection (`@`-mention) and shell-escape (`!`-shell) security model

- **Status**: Proposed
- **Date**: 2026-07-03
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.D), [chat-session.md](../reference/cli/chat-session.md), [home.md](../reference/cli/home.md), [config-spec.md](../reference/contracts/config-spec.md), [built-in-tools.md](../reference/shared-core/built-in-tools.md), [tool-registry.md](../reference/shared-core/tool-registry.md), [security-review.md](../standards/security-review.md)

> **Proposed (2.5.D, the two security-bearing input features).** This ADR is drafted **before** implementation to
> pin the security model of the two input-layer surfaces 2.5.D adds; the pure-ergonomics half of 2.5.D
> (`Ctrl+J` multiline, cursor / word motions, `↑/↓` history, `Ctrl+R` reverse-search) is **out of scope** — it
> changes no security boundary and needs only the [chat-session.md](../reference/cli/chat-session.md) /
> [home.md](../reference/cli/home.md) keymap update. It flips to **Accepted** once the two features land and the
> **mandatory adversarial security review** (below) passes — the same gate ADR-0057 used.

## Context

Phase 2.5.D ([phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) §2.5.D) upgrades
the chat prompt with two affordances that are **not** keystroke ergonomics — they move data across a trust
boundary from the terminal input line:

- **`@`-mention** — the user types `@path` and the file's bytes are injected into the user message as explicit
  context, so the model sees the file without a tool round-trip. This is a **read that egresses to the
  provider** (and into the durable `history.db` transcript, [ADR-0050](0050-cli-history-db-at-rest-posture.md)) —
  the exact sink the `read_file` host reader guards with its jail + a sensitive-path confidentiality floor
  ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [built-in-tools.md](../reference/shared-core/built-in-tools.md)).
- **`!`-shell** — the user types `!command` and a shell command runs. This is **command execution**, the exact
  side-effect the `run_command` tool guards with the `allowedCommands` allowlist + the hardened process arm
  ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md)) + the mode-aware `confirmAction`
  approval floor ([ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)).

The structural risk is that **both features are `apps/cli` input-layer preprocessors that run *outside*
`ToolRegistry.dispatch`** — the one place where [ADR-0029](0029-tool-policy-hardening.md)'s guardrails,
ADR-0055's host jail, and ADR-0057's approval floor are physically enforced. `@`-mention never enters
`dispatch` at all; `!`-shell *could* be given its own execution path in `apps/cli`. If either re-implements or
sidesteps those boundaries, the CLI grows a **second** command sandbox / a **second** file-read path that can
diverge from the audited one. Two concrete attacks frame the stakes:

1. **Confused-deputy-via-human exfiltration.** A model, or a file already injected from the workspace or the
   web, can socially-engineer the user into typing `@~/.ssh/id_rsa` or `@.env`. If `@`-mention reads with raw
   `node:fs`, it egresses a secret to the provider and the transcript, bypassing the `read_file` confidentiality
   floor the same user's tools obey.
2. **Allowlist / approval fork.** If `!`-shell checks the allowlist or the mode in `apps/cli` — or runs the
   approval prompt *before* the allowlist check — a bug (or `auto` mode) can run a command that the one audited
   boundary would have refused.

The phase doc's 2.5.D acceptance line reads *"REPL-only; no engine/seam change."* That is the right instinct
for the ergonomics half, but it is in genuine tension with implementing `!`-shell **correctly**: the CLI has no
way to dispatch a single tool outside a model turn, so the only safe vehicle reuses engine machinery. This ADR
resolves that tension explicitly rather than letting it drive an unsafe `apps/cli`-side re-implementation.

## Decision

**We will bind both input-layer features to the *existing* audited boundaries — reusing, never forking, the
`read_file` file-read jail and the `run_command` command-execution boundary — and treat the one small engine
addition `!`-shell requires as a bounded, pure, documented exception to 2.5.D's "no engine change" line, not a
license to relax it.**

### `@`-mention reads through the `read_file` jail + confidentiality floor

An `@`-mention read goes through the **same** host `fs` capability the `read_file` tool uses — the
`realpath` + common-path jail, the `isSensitiveReadPath` confidentiality floor (refusing `.ssh` / `.aws` /
`.relavium` / credential-shaped paths), the `O_NOFOLLOW` single-fd read that rejects directories / FIFOs /
devices, and the same size cap — **never a raw `node:fs` read**, and **never a scope wider than `read_file`'s
workspace-clamped tier** ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md)). The **only**
difference from a model `read_file` call is that the human typing `@path` **replaces the `confirmAction`
prompt** — a person naming a path at their own prompt is a stronger, more specific consent signal than
answering `[y]` to a model-chosen path. Consent replaces the *prompt*; it **never** relaxes the confidentiality
floor, the binary fail-close, or the size cap — that is what closes attack (1). Further:

- **Injected bytes are USER-position, untrusted content.** The snapshot is spliced into the user message at
  compose time, never the system / instruction position; a `secret`-typed value is still never interpolated
  ([ADR-0029](0029-tool-policy-hardening.md)), and any `--json` / observability field passes
  `redactSecretShapedText` ([ADR-0029](0029-tool-policy-hardening.md)(c), the one redaction primitive).
- **First-class, directory-navigable completion.** Typing `@` opens a Tab-completion overlay that lists **both
  directories** (navigable — selecting one descends into it) and **files** (selecting one injects it), so the
  affordance matches and exceeds the competitor `@`-mention UX. `.gitignore` / `.relavium` honoring is
  **advisory** — it only trims noise (`node_modules`, dot-dirs) from the **candidate list**, enforced with an
  **in-house, ReDoS-safe** matcher (no new `ignore` dependency, per [CLAUDE.md](../../CLAUDE.md) #2). It is
  **not** the security boundary: the confidentiality floor above refuses a sensitive path *regardless* of
  whether an ignore rule happens to cover it, so a non-ignored `.env` cannot leak on the theory that "ignore
  would have caught it." (Directory / glob **expansion** — `@src/`, `@**/*.ts` injecting many files — is a
  deferred follow-up, [deferred-tasks.md](../roadmap/deferred-tasks.md); 2.5.D ships single-file injection with
  full directory *navigation* in the picker.)
- **Binary fail-close + a byte-heuristic token warning.** A NUL-probe refuses binary content (media input, D12,
  is a separate security-reviewed follow-up — [chat-session.md](../reference/cli/chat-session.md)); the
  token-limit warning is a **byte heuristic** (`utf8ByteLength`, ~4 bytes/token), **no tokenizer and no new
  dependency**.

*Considered:* a raw `node:fs` read for speed (rejected — reopens attack (1), bypasses the floor); a friendlier
dedicated "user-context" scope broader than the fs tier (rejected — relaxes the confidentiality floor the whole
point is to keep); making `.gitignore` the boundary (rejected — ignore is UX, not security; a non-ignored
secret would leak).

### `!`-shell routes through the one `run_command` boundary via an additive `AgentSession` method

`!command` is dispatched as a **user-initiated `run_command`** through the **exact** boundary a model tool call
uses — `enforcePolicy(allowedCommands)` (exact-match, enforced **before** the approval floor) → the mode-aware
`confirmAction` gate → the hardened process arm (`shell:false`, ambient-PATH resolution, the declared-env
denylist, a workspace-jailed cwd, bounded output buffers, process-group `SIGKILL`)
([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)).
The execution vehicle is a **new, additive `AgentSession.runUserCommand()`** that **reuses `#runTurn`'s
dispatch-context construction verbatim** — the approval regime (`confirmAction`), the `toolPolicy`, the
`fsScope`, and `gateApproved: false` — **never a dispatch context re-assembled in `apps/cli`**. This is the
bounded engine exception named in Context; it is **pure** (no platform-specific import, no vendor type across
the `@relavium/llm` seam — [CLAUDE.md](../../CLAUDE.md) #4/#5 hold) and runs identically on every surface.

- **Mode-aware, allowlist-floored.** Denied in `ask` / `plan`; `[y]`/`[a]`/`[n]`-gated in `accept-edits`;
  auto-approved in `auto` — but `enforcePolicy` runs **before** `confirmAction`, so **even `auto` can never run
  a command absent from `allowedCommands`.** The allowlist is the mode-independent floor; the mode only decides
  whether an *allowed* command still prompts.
- **A curated safe default `[chat].allowed_commands`, still allowlist-floored.** Today the `[chat]` block *"does
  not define its own command allowlist"* — it inherits the workflow `allowedCommands`, empty ⇒ `run_command`
  disabled ([config-spec.md](../reference/contracts/config-spec.md)). This ADR adds an explicit
  **`[chat].allowed_commands`** field whose **default is a curated, read-only, non-destructive set** (`git
  status` / `git log` / `git diff` / `git show`, `ls`, `pwd`, `cat`, `grep`, `which`, …) so `!git status` /
  `!ls` work **out-of-the-box** — first-class parity for the common inspection case — while a destructive or
  arbitrary command (`rm`, `npm`, a test / build runner) requires an **explicit, exact-match opt-in** the user
  adds to `[chat].allowed_commands`. The floor is unchanged: `enforcePolicy` matches the allowlist **before**
  `confirmAction`, so no mode (`auto` included) runs a command outside it. Editing chat `allowedCommands` is a
  [security-review.md](../standards/security-review.md) trigger; the curated default set is itself part of the
  reviewed surface and lands under that trigger.
- **Output is injected as untrusted, pending context.** `!cmd` stdout/stderr is buffered as **pending context
  that rides the next `sendMessage`** (not an immediate model turn — no per-`!` token cost). It carries the
  **same untrusted brand** `run_command` output already carries (byte-capped by the bounded buffer, never a
  trusted instruction), and is redacted on any observability field. The user sees the output immediately; the
  model sees it on the next turn.
- **Non-TTY contract.** With no interactive approver (plain / `--json`), `!`-shell runs only what `auto`-mode
  policy + the allowlist already permit and never blocks on a prompt; the [ADR-0049](0049-cli-machine-output-contract.md)
  machine-output contract is untouched (`@` / `!` are TTY ergonomics). The `!cmd` + its output persist to the
  transcript so a `chat-resume` stays coherent.

*Considered:* an `apps/cli`-side re-implementation of the allowlist + approval (rejected — forks the one
command boundary; a divergence or an approval-before-allowlist ordering bug is a security regression, exactly
attack (2)); a separate `!`-shell execution path outside `run_command` (rejected — a second command sandbox);
**full competitor parity — relaxing the `enforcePolicy`-before-`confirmAction` ordering so *any* command is
runtime-approvable in `accept-edits` / `auto`, matching the surveyed CLIs' arbitrary `!`-shell** (rejected —
it dissolves the `allowedCommands` floor that is a stated secure-by-default differentiator
([ADR-0029](0029-tool-policy-hardening.md)) and would let the user's input line run commands the model's own
`run_command` cannot; the curated default set below gives out-of-the-box usefulness without that relaxation);
a **strictly empty default** allowlist (weighed — most secure, but `!` is inert out-of-the-box, contradicting
the parity goal, so refined to the curated read-only default); user-only output display (rejected — inconsistent
with the `@`-mention sibling and reduces `!` to "a worse terminal", losing its purpose); **holding the "no
engine change" line strictly and deferring `!`-shell execution** (weighed as the honest fallback — steps 1–4
still ship a full editor + history + `@`-mention — but rejected as the default because the additive method
preserves the *real* invariants and leaves no half-built feature; recorded in
[deferred-tasks.md](../roadmap/deferred-tasks.md) only if the maintainer later reverses).

### Relationship to ADR-0055 and ADR-0057 (this is the input-layer sibling)

ADR-0055 is the **host-capability seam** (the `fs` / `process` / `egress` arms); ADR-0057 is the
**registry-dispatch approval floor** (`confirmAction`, the governed classes). Both enforce at
`ToolRegistry.dispatch`. ADR-0061 is a **new mechanism at a different layer** — the `apps/cli` **input line** —
so it is a **sibling ADR, not an amendment** to either (per the [README](README.md) convention: a new mechanism
gets its own ADR). Its whole job is to guarantee that the two input-layer features **re-enter** those audited
boundaries rather than bypass them: `@`-mention reuses ADR-0055's `fs` read jail; `!`-shell reuses ADR-0055's
`process` arm + ADR-0057's `confirmAction` floor via the additive `runUserCommand`. It supersedes nothing.

## Consequences

### Positive

- One file-read jail and one command-execution boundary, shared by the model's tools **and** the user's input
  line — no second sandbox, no divergence surface. The confused-deputy-via-human exfil vector is closed by
  construction (the confidentiality floor holds regardless of consent or ignore rules).
- `!`-shell is `auto`-safe by ordering: `enforcePolicy` before `confirmAction` means no mode can run a
  non-allowlisted command; secure-by-default holds via a **curated read-only default** allowlist (`!git status`
  / `!ls` work out-of-the-box; destructive / arbitrary commands need an explicit exact-match opt-in), so the
  feature is first-class *and* the `allowedCommands` floor — the stated differentiator — survives intact.
- The engine touch is a single additive, pure method reusing existing machinery — the real CLAUDE.md #5
  invariants (platform-free engine, untouched seam, identical on every surface) are preserved even though the
  phase doc's literal "no engine change" line gets a documented exception.
- `@`-injected content and `!`-output are both branded untrusted, keeping the prompt-injection trust model
  consistent with existing tool output.

### Negative

- The 2.5.D "no engine change" acceptance line now carries a **documented exception** (`AgentSession.runUserCommand`).
  Mitigated by scoping it to one additive, pure method that reuses `#runTurn`'s dispatch context verbatim, and by
  the phase-doc / EA-table reconciliation this ADR drives.
- `@`-mention adds a **user-consent path that skips the `confirmAction` prompt** for a file read. Mitigated by
  keeping the confidentiality floor, binary fail-close, and size cap non-negotiable — consent replaces only the
  prompt, never the floor — and by the mandatory security review.
- A new `[chat].allowed_commands` field widens the config surface for command execution, and it ships with a
  **non-empty curated default** (so `!` is useful out-of-the-box). Mitigated by keeping that default strictly
  read-only / non-destructive, exact-match semantics, the `enforcePolicy`-before-approval floor (destructive /
  arbitrary commands need explicit opt-in), and the security review covering the default set itself.
- The input line grows two keyboard-owning submodes (the `@` completion overlay, and — for the ergonomics half —
  `Ctrl+R` search) that must not collide with the `/` palette, a pending approval, or the running-turn gate.
  Mitigated by reusing the palette precedence pattern (render inside the one ink tree, mutually exclusive with
  the palette, always yield to a pending approval) and per-combination reducer tests.
- A mandatory adversarial security review gates Accept (like ADR-0057): the `@`-mention read path (jail +
  floor reuse, binary fail-close, ANSI/OSC injection via a crafted filename or file content, observability
  redaction) and the `!`-shell path (allowlist-before-approval ordering, the reused-not-forked dispatch
  context, the process-arm envelope, untrusted-brand on injected output, default-off).
