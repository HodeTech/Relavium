# ADR-0112: Chat network grants and onboarding state are operator-owned

- **Status**: Proposed
- **Date**: 2026-10-15
- **Related**: [ADR-0006](0006-os-keychain-for-api-keys.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0033](0033-strict-config-files-amends-0023.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0105](0105-filesystem-roots-are-invocation-grants-not-project-authority.md), [ADR-0110](0110-cli-diagnostics-and-discovery-have-explicit-compatibility.md), [Wave 3](../roadmap/current.md#wave-3--clear-the-ground)

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
without new global-only reads and an invocation ceiling. Home is build-first: a
failed replacement preserves the old host. Merely narrowing a new snapshot or
promising stop-before-build therefore cannot revoke its old authority. Dispatch also compares
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

Pin the selected global file identity lexically once per invocation, then capture
an owned initial ceiling before the first host/key/MCP build. One invocation-owned
**live narrowing authority** is shared by old, pending and replacement hosts.
Every fresh/resume/clear/reseat/Home build rereads only global HTTP policy and
synchronously intersects the accepted authority before later asynchronous work.
A validated removal remains effective even when that build fails; build-first
recovery may keep the old host, but cannot keep its broader HTTP authority.
Use the existing post-approval/post-effect-prepare beforeDispatch seam with an
owned immutable admitted PolicyTarget to check the live authority immediately
before HTTP dispatch. Do not decorate all egress or introduce a new model field.

Build generation/selection publication is latest-only; dispose stale hosts and
never restore a previous authority snapshot. A read/schema failure suspends HTTP
admission and refuses the new build with a fixed actionable diagnostic. It does
not silently fall back, reset the ceiling or permanently interpret transient I/O
failure as a validated removal; a subsequent successful refresh still intersects
the last accepted authority. Additions/restoration require a new invocation and
produce a fixed ignored-widening notice. There is no file watcher: changes take
effect at explicit refresh/rebuild. Already admitted requests may complete; the
post-prepare check is the admission linearization point, not network recall.
Persisted session policy never revives authority.

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
Its portability cannot confer access because current key/backend state always
wins. A DB-owned acknowledgement was considered but adds a second mutable store
for UX-only state without replacing that check.

After storing a key but failing to persist defaults, retain the key and truthfully
offer recoverable retry or explicitly chosen ephemeral defaults. Never say
“Connected”/saved default when persistence failed. Project precedence is not
silently overwritten. Keep explicitly chosen ephemeral provider/model selection
in an invocation-owned binding reused by later rebuilds, including clear. Publish
that binding only with the latest successful build; never confuse it with a saved
project/global default. Propagate color choice without changing process environment.

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
race. The shared preference-writer primitive performs this check before loader/read/
chmod side effects; current and future settings callers use it, not picker-only
checks. Regular writes keep verified schema round-trip, permissions and durability.
Existing TOML reserialization loses comments/order; document that tradeoff before
every existing-file preference rewrite, rather than guessing whether the operator
hand-edited it. Preserve all policy values, never broaden them. New-file creation
needs no comment-loss notice. Shared error identities belong to ADR-0110’s one
closed CLI classification authority; Home/wizard arms must actually surface known
actionable refusals rather than discard their classification.

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
   the live invocation ceiling. Include failed Home replacement, overlapping build
   completion, approval/effect-prepare races and transient read recovery; an old
   host must not admit a revoked request. No live/paid provider is required.
3. First-chat tests verify model/provider selection, retained key, truthful
   write failure, typed acknowledgement, current keyless reminder and retry/cancel.
   Ephemeral provider/model survives clear/reseat; stale builds cannot publish it.
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
- Revocation takes effect at explicit refresh/rebuild, including failed replacement;
  in-flight requests are not recalled. Widening requires a new invocation.
- Policy read failure temporarily suspends HTTP even on an otherwise retained host.
  Final-link refusal applies to every preference writer, including future settings.
- Symlink writes require manual action or ephemeral continuation. Non-retryable
  diagnostics avoid a wizard loop; comments/order remain a known writer tradeoff.
