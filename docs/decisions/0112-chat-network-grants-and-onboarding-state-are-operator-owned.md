# ADR-0112: Chat network grants and onboarding state are operator-owned

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

## Context

G30 exposes a missing chat HTTP policy path. Advertising `http_request` does not
supply its domain authority. Default Home agents do not grant that tool; standalone
agent execution is ask-mode without a confirmer. A successful request is therefore
not a valid acceptance expectation on every current surface.

A global-only policy is an explicit new choice for this capability. It is not a
claim that projects confer no network authority today: approved commands such as
curl, project MCP and workflow tool policy have separate contracts. Nor is any
operator-selected `--config` file necessarily protected from model filesystem
tools; a workspace-local selection may be writable.

Clear/reseat currently reuse startup chat options; Home refreshes model/provider
and can fall back on read error. Those paths cannot provide policy revocation
without new global-only reads and an invocation ceiling. Dispatch also compares
`allowed.includes(parsed.host)` privately, without normalizing the allowlist.
The proposed shared comparison is a correction, not an existing public helper.

Onboarding confuses unavailable keychain with missing key and can announce success
after default persistence fails. The config loader follows intentional links;
the atomic writer replaces their final directory entry. Read permission and write
permission must be stated separately, not justified by a fictitious owner change.

All choices remain Proposed. Exact keys, limits, diagnostics, transition and
rollback rules have one home in
[config-spec.md](../reference/contracts/config-spec.md#proposed-wave-3-chat-policy-and-preferences).

## Decision

### Chat HTTP authority

Use global-only operator configuration for the built-in chat HTTP tool. The
normal global file or an explicitly selected global file is the authority;
projects, agents, sessions and environment overlays cannot supply this field.
Selecting an explicit file is a deliberate trust choice, not proof it is immutable.
The setting's name describes HTTP-tool policy, not all chat egress.

Absent/empty authority denies all. Use bounded canonical ASCII DNS hostnames,
explicit punycode and one pure hostname normalizer/comparator shared by validation
and dispatch. Preserve exact-host permission with no suffix/subdomain grant.
The current `parsed.host` is a hostname, not URL host-with-port; the host transport
allows arbitrary HTTPS ports. State this authority explicitly in the
[tool contract](../reference/shared-core/tool-registry.md#proposed-wave-3-http-authority-and-secret-provenance);
do not silently make it 443-only. DNS/range validation, pinned connection, redirect
refusal and response bounds remain independent. Auto mode is still an authority
to send permitted tool data to a permitted host/port; provider keys are not attached.

Capture an owned invocation ceiling before building the first host. Every host
construction reads **only current global HTTP policy**, intersects it with that
ceiling and the last accepted effective policy, and retains the narrowed result
across Home chats, clear, reseat and resume. No rebuild widens authority; a fresh
CLI invocation is required to add or restore a grant. Never reuse captured startup
chat policy or Home's model-read fallback for this read. Read/schema failure
refuses the new build with a fixed actionable diagnostic; it does not restore
old policy or reset the ceiling. Stop the old turn/host before replacing it.
An active host retains its immutable snapshot until cancellation/rebuild; there
is no live watcher. Persisted session policy never revives authority.

Forward only that list to existing tool dispatch, keeping model tool grants,
approval modes and SSRF as separate gates. Test each surface's actual behaviour:
a custom chat agent granting HTTP can succeed in an allowed approval mode;
default Home and confirmer-less ask paths still deny or do not advertise it.
Do not add a tool grant or confirmer merely to obtain a green positive test.
This does not activate search, provider headers, workflow egress or MCP policy.

### Onboarding and mutation

Keep an explicit, typed, global-only acknowledgement preference for a genuine
unavailable-keychain outcome and deliberate user choice. It is only UX state:
every startup rechecks current key availability; a working key suppresses setup,
and a still-keyless acknowledged failure gets a reminder and explicit retry.
Missing key, cancellation, authentication and unrelated DB errors do not set it.
Persist only a boolean through the secret-incapable writer; failures stay visible.

After storing a key but failing to persist defaults, retain the key and truthfully
offer recoverable retry or explicitly chosen ephemeral defaults. Never say
“Connected”/saved default when persistence failed. Project precedence is not
silently overwritten. Propagate color choice without changing process environment.

Refuse an existing **final-component symlink** for preference writes, with a
fixed path-free `ConfigWriteRefusedError` and `reason: symlink_target`; mark it
non-retryable in the wizard/picker. Keep reads through intentional links.
Preserve link and referent, explain manual edit/regular-file replacement outside
the wizard, and offer honest ephemeral continuation; no endless Retry loop.
Ordinary write failures can still offer Retry. This is an entry-preservation
policy, not a claim that same-owner link targets have a different authority.
Ancestor links remain under the existing owner-controlled-directory assumption;
atomic rename replaces one hardlink entry rather than editing all aliases.
An lstat precheck is not an atomic no-follow replace against a hostile same-user
race. Regular writes keep verified schema round-trip, permissions and durability.
Existing TOML reserialization loses comments/order; document that tradeoff before
writing a hand-edited policy and preserve all policy values, never broaden them.

Considered project domains: rejected for this capability because explicit operator
authority is preferable to implicit imported authority. Considered invocation
flags: viable but unnecessary for project-less G30. Considered stateless keychain
status alone: needed for truth but insufficient for #55's explicit remembered
acknowledgement. Considered same-owner symlink referent writes: rejected because
it changes the existing atomic entry-replacement protocol and recovery boundary;
manual editing preserves intentional links without introducing that writer.
These choices do not establish a universal no-project-egress guarantee.

### Acceptance and landing

1. Strict global schema/resolver controls verify exact hostname grammar, actual
   global/project merge precedence, no project authority and empty deny-all.
   Loader failures are fixed, actionable and value/path-free. Test actual merge
   bypass attempts, not only unknown-key rejection.
2. Native actual host/dispatch controls exercise permitted custom chat, default
   Home non-advertisement, agent ask denial, approval refusal and SSRF/ports.
   Clear/reseat/resume/repeated Home builds reread global policy: remove, re-add,
   attempted widen, malformed/unreadable file and startup fallback all exercise
   the persistent invocation ceiling. No live/paid provider is required.
3. First-chat tests verify model/provider selection, retained key, truthful
   write failure, typed acknowledgement, current keyless reminder and retry/cancel.
   New strict keys have concrete old-binary removal/exit instructions.
4. Native symlink controls preserve link/referent and prove no Retry/success lie;
   ancestor-link/hardlink controls state the actual scope. Regular writes retain
   atomicity, mode, policy values and confidentiality; prompts respect color-off.
5. Separate config/egress and keychain-path security sittings and two fresh
   cumulative clean rounds precede acceptance. At ADR acceptance add forward
   notes to affected Accepted decisions; implementation lands canonical config,
   tool, chat/Home references and actual Wave 3 evidence without claiming other
   egress capabilities were governed.

## Consequences

### Positive

- Existing chat HTTP becomes usable under explicit, bounded operator authority.
- Rebuilds revoke grants monotonically; setup and intentional config links stay honest.

### Negative

- Strict new keys break old-binary config reads until removed, even on unrelated
  commands. The canonical rollback instructions make the recovery explicit.
- Revocation requires cancellation/rebuild and widening requires a new invocation.
  An active snapshot is not instantaneous revocation.
- Symlink writes require manual action or ephemeral continuation. Non-retryable
  diagnostics avoid a wizard loop; comments/order remain a known writer tradeoff.
