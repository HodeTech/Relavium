# ADR-0112: Chat network grants and onboarding state are operator-owned

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

Wave 3 pulls G30 forward: chat can advertise `http_request`, but its policy has no
configuration path for `allowedDomains`, so dispatch always denies. Simply copying
a project-owned allowlist would turn a cloned artifact into network authority.
ADR-0105 makes this distinction explicit for filesystem grants; this proposal makes
a separate decision for chat egress rather than pretending that ADR already governs it.

Onboarding also treats a missing key and an unavailable keychain as the same reason
to repeat full setup. It can announce success after model-default persistence fails.
The global config writer silently replaces intentional symlinks. These changes share
one trust boundary: operator-owned non-secret configuration, mutated only by explicit
user actions through a typed writer.

Approval is required before the new shared config fields or keychain/config paths
change. Exact keys, precedence and validation belong in the
[config specification](../reference/contracts/config-spec.md), not a second schema here.

## Decision

We will use operator-owned global policy for chat HTTP grants and explicit,
non-authoritative preferences for onboarding acknowledgements.

### Chat HTTP authority

Add a global-only `[chat_egress].allowed_domains` setting, read from the normal
global config or the file explicitly selected as global by `--config`. A project,
workspace, agent definition, persisted session, model output or environment variable
cannot add or replace this authority. Loading a project must not promote its file
to global configuration. Selecting an explicit global file is the operator's choice.

An absent/empty list remains deny-all. Limit it to 128 entries, each at most 253
characters, canonical ASCII DNS names; IDNs use explicit punycode spelling.
Reject URLs, credentials, paths, query strings, ports, wildcards, literal IPs and
single-label/local host forms. Normalize case and any accepted terminal root-dot
form through the same host comparison used by dispatch; do not add a second URL
parser or silently introduce suffix/subdomain permission. Deduplicate canonical names.
Exact host authority retains the existing HTTPS-port semantics; it does not mean
port 443 only. DNS/range checks remain necessary even for an allowed hostname.

Resolve an owned policy on every fresh/resumed/reseated/cleared host build, including
Home chat and `agent run`. A prior persisted policy cannot revive a removed grant.
An already-built host owns its immutable snapshot until it is rebuilt; this is not
a live revocation watcher. Original-workspace resume discovery remains ADR-0105's
filesystem rule and cannot replace the current operator global egress setting.

Forward only the approved domain list to the existing engine tool policy. Preserve
exact-host checking before dispatch, per-tool modes/approval, HTTPS-only SSRF/DNS
validation, pinned connection, no redirects and response size/time bounds. `auto`
does not bypass missing domain permission. Loading policy performs no request and
attaches no provider key. This does not activate search credentials, live provider
headers, workflow-run egress or a new tool. Workflow-authored policy remains its
separate execution contract. Advertise filtering is helpful but dispatch is authoritative.

### Onboarding and mutation

Add a typed global-only `keychain_unavailable_acknowledged` preference. Set it only
after a genuine typed unavailable-keychain outcome and an explicit user choice to
use a short reminder next time. Cancel, missing key, auth failure or unrelated DB
failure must not set it. Store only a boolean, never a key, hint, error text or
backend/path identity. Use the existing strict, atomic, secret-incapable writer;
no new generic key-value store or automatic startup write is authorized.

Every Home startup still checks actual current key resolvability. A working env or
keychain key suppresses setup as today. Otherwise an acknowledged backend problem
shows a short keyless reminder with an explicit retry-setup action instead of
automatically repeating full setup/provider validation. The acknowledgement neither
claims permanent lock nor conceals the current missing-key state. A failed preference
write is visible and recoverable and cannot be reported saved.

After a key is stored but model/provider defaults fail to persist, preserve the key
and offer Retry or an honest incomplete-setup continuation. The next chat must choose
a compatible model explicitly or use an explicitly chosen ephemeral model/provider;
never announce a persisted default that failed. Higher-precedence project defaults
are not overwritten implicitly. Thread the resolved color choice to actual prompts
without process-global environment mutation.

Refuse a pre-existing symlink at the global preference write target, preserving its
link and referent. Do not follow it into a different authority or warn only after
replacing it. Regular-file writes retain schema round-trip, owner-only temp file,
atomic rename and existing durability guarantees. A malicious same-user process
swapping a target between checks and rename is outside the existing owner-controlled
filesystem assumption; a preflight lstat must not be described as an atomic no-follow
replace primitive. The fixed diagnostic explains how to edit the intentional link
manually without echoing its path or content.

Considered project-granted domains: rejected because imported config would confer
machine authority. Considered another invocation flag plus project selectors:
viable, but larger than G30 needs; the operator global setting supports project-less
chat without implementing a durable permission store. Considered allowing every
domain once a user approves a tool: rejected because approval and network policy
are independent gates. Considered treating acknowledgement as credential state or
silently writing through config links: rejected because either hides current truth
or changes write authority.

### Acceptance and landing

1. Strict schema/resolver tests cover global/explicit-file authority, project and
   workspace attempts to widen it, canonical hostname validation and empty deny-all.
   Invalid policy causes no session creation, provider/key access or MCP connection
   beyond the explicitly necessary existing-history read for resume.
2. Actual session-host-to-tool dispatch controls cover all chat surfaces, rebuilds,
   revoked-on-rebuild grants, allowed requests, no-domain denial, approval refusal
   and unchanged workflow/search/MCP separation. Native SSRF controls prove the
   existing DNS/connect/redirect floor still applies. No paid/live provider test is needed.
3. First-chat integration proves chosen non-default provider/model binding, failed
   config-write recovery and precedence. Current keyless state, explicit acknowledgement,
   retry, cancellation and write-failure tests prove no false setup/credential claim.
4. Native symlink tests preserve link/referent bytes on refusal; regular-file
   positive controls keep atomicity, permissions and error confidentiality. Real
   prompt output respects color-off. Separate config-trust/egress and keychain-path
   security review sittings plus two fresh cumulative rounds are required.
5. Update canonical config, chat, Home, CLI and built-in tool references, append
   dated refinements to related Accepted ADRs, and register actual acceptance in
   Wave 3. This proposal itself establishes no permission, saved setting or completion.

## Consequences

### Positive

- An existing chat tool becomes usable under explicit operator authority without
  weakening default deny, approvals or SSRF controls.
- Setup tells the truth about key availability and persisted defaults, while an
  intentional config symlink is preserved.

### Negative

- New strict global keys require a new enough binary; older binaries reject them
  under ADR-0033. Document rollback/removal of these non-secret keys.
- Domain changes take effect at host rebuild, not instantaneously. An operator
  needing immediate revocation cancels the active turn and rebuilds the host.
