# ADR-0105: Filesystem roots are invocation grants, not project authority

- **Status**: Accepted
- **Date**: 2026-10-12
- **Related**: [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0054](0054-cli-bare-invocation-interactive-home.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md), [ADR-0063](0063-cli-config-write-contract.md), [ADR-0083](0083-input-admission-and-a-resume-that-verifies-its-own-identity.md), [ADR-0084](0084-consent-before-a-local-mcp-spawn.md)

## Context

The [joint remediation Wave 2 status](../roadmap/current.md#next-work--wave-2--shut-the-doors)
links its detailed implementation queue, which pulls the
filesystem prerequisites of Phase 2.6.M/N forward. The host already implements a
project-tier `extraRoots` option, but strict config and the factory never supply it.
Both project and workspace TOML are git-committable. Passing their paths straight to
the host would authorize outside-workspace reads without the operator's consent;
read tools do not use the write-approval prompt. ADR-0084 already distinguishes
artifact declarations from machine authority for the analogous MCP boundary.

The same change touches the blanket `.relavium` floor, an unused globally created
`tmp` directory, two copies of the ancestor resolver, and omitted cloud credential
paths/environment overrides. A native preflight also reproduced a CAS write through
a symlinked shard into a sibling directory. Content-addressed names establish byte
identity, not physical containment.

This proposal requires maintainer approval before dependent code. It adds no runtime
dependency, filesystem API to core, durable permission database, or child-agent port.

## Decision

We will separate operator grants from project requests, and enforce one contextual
filesystem floor at every model-facing read, discovery and write boundary.

### Invocation authority

The CLI accepts repeatable `--allow-fs-root <absolute-directory>` on bare Home,
`chat`, `chat-resume` and `agent run`. Up to 16 existing directory roots, each with a
maximum 4096-character argument, are admitted before provider/key/history/MCP work.
The trusted host canonicalizes and pins their identity; malformed, missing,
non-directory or unresolvable grants refuse the invocation without echoing paths.
No environment variable, project file, persisted session or model output grants a
root. Workflow `run` does not inherit a chat flag or chat config block.

`[chat].extra_roots` is an optional, bounded selector, with project-over-workspace
precedence. Relative selectors resolve against the session's working directory.
Absent selects the invocation grants; `[]` selects none. Each selected canonical
directory must be equal to or inside an invocation grant; an unmatched request
refuses rather than being dropped. A project may replace workspace requests only
within that independently authorized ceiling. The selector never changes the tier:
sandboxed remains workspace-only; project includes effective extra roots; the
existing chat clamp from full to project remains. Invalid configured requests are
reported even when the active tier would not use them.

Grants survive `/clear` and model reseating only within the same canonical workspace
and process. Admission is staged: validate invocation grants before dispatcher
history/provider composition. A fresh session then validates its selectors before
history creation. Resume may initialize/open/read existing history to recover the
original working directory; only then discover current project/workspace config at
that directory and validate its selectors, before creating/advancing a session or
turn, constructing providers, accessing keys or connecting MCP. Historical TOML bytes
are not persisted. The current invocation's explicit global `--config` remains its
global preference override; it cannot grant filesystem roots or replace discovery
at the original workspace. Resume requires new invocation grants. Root
aliases or directory identities changing later revoke access; re-canonicalization
may not silently grant a replacement. The host owns an immutable policy snapshot.
Paths returned for permitted extra-root entries remain usable: represent them
relative to the workspace, retaining necessary `..` components instead of collapsing
them to ambiguous basenames. Where a relative representation is impossible (Windows
cross-drive roots), return the authorized canonical absolute path. Directory-entry
names remain relative to the requested directory; do not prepend their anchor twice
in mention/completion consumers. Renderers keep their untrusted-text boundary.

### Confidentiality and scratch

Credential and protected-write floors apply in every tier and mode, including full
and auto. Expand the existing shared declared-env predicate and host path policy for
Kubernetes, Azure, gcloud and Terraform credentials; do not recreate a second env
list. Check lexical provenance and canonical targets, and prune refused directories
before recursive descent. An ordinary extra-root grant never overrides a floor.

The trusted host may issue a descriptor for one exact private scratch subtree under
its home configuration anchor. Only that descriptor can exempt the ancestor
`.relavium` component. Home `config.toml`/`history.db`, every project's `.relavium`,
sibling-prefix paths and nested protected/credential components remain refused.
Validate both lexical and canonical containment, root identity, owner-only POSIX
permissions and no symlink descendants. A descriptor cannot be made by TOML or by a
tool argument. The same mechanism supports future `tmp` and artifact roots; it is
not a basename exception. A valid host-issued scratch root is available in both
sandboxed and project tiers without changing their other grants.

Wave 2 removes unused automatic global `tmp/` provisioning (G21). It implements and
tests the contextual descriptor/factory prerequisite; it does not allocate scratch
for ordinary chats or claim that Phase 2.6.N's child lifecycle/cleanup port exists.
The planned consumer is the CLI host implementation of
[Phase 2.6.N's artifact-store port](../roadmap/phases/phase-2.6-conversational-authoring.md#26n--child-session-foundation-catalog-spawn-standardized-io-lineage).
That workstream owns production provisioning, per-parent-session isolation and
join/cleanup/recovery; Wave 2 supplies only its explicitly pulled-forward floor
prerequisite. Removing dead automatic provisioning does not authorize a replacement
allocator or imply that this descriptor has a shipping producer.
Windows permissions follow the existing owner-controlled profile/ACL assumption;
POSIX mode bits are not represented as Windows ACL verification.

### Shared mechanism and physical containment

Extract `deepestExistingReal` into `packages/shared` (`@relavium/shared`) as one
platform-free algorithm with injected host operations, consumed by the CLI tool
host and DB `save_to` implementation. Its canonical host/tool contract belongs in
[built-in tools](../reference/shared-core/built-in-tools.md); Node operations stay
in the host packages. Only proven missing descendants permit climbing; EACCES, ELOOP,
ENOTDIR and dangling symbolic links refuse. Both tool fs and `save_to` use it while
retaining different authorities: host persistence may write `.relavium/runs`, which
model tools may not.

CAS operations pin a canonical root and refuse symlinked descendants/final files,
use exclusive/no-follow temporary files, validate regular-file identity, and verify
containment for publication, read, deletion and GC. Introduce missing bounded fd CAS
reads under ADR-0106. Preserve tool-fs fd reads/hard-link controls and its existing
scoped pnpm exception; that exception does not apply to CAS. Keep atomic publication.
Reject every Windows drive prefix, including `C:relative`, before `save_to` I/O.

These controls cover untrusted artifact/model paths and cooperating host processes
inside owner-controlled storage. Node path checks and final-component O_NOFOLLOW do
not promise a descriptor-relative jail against a hostile same-user process swapping
parent directories between syscalls. Do not describe pre/post realpath as race-free,
or filesystem grants as an OS sandbox for `run_command` arguments. These existing
host assumptions must be explicit in the canonical security/tool contracts.

### Alternatives and landing

Rejected direct project grants (artifact-controlled widening), a new durable grant
store (unnecessary consent/revocation/storage surface for this increment), a
`tmp`-basename exception (would admit unrelated/sibling trees), and moving Node
imports into shared (breaks platform purity). Invocation grants are explicit and
headless-compatible; narrower durable UX can be decided separately if required.

On acceptance, update the existing [config specification](../reference/contracts/config-spec.md),
[CLI commands](../reference/cli/commands.md), [built-in tools](../reference/shared-core/built-in-tools.md)
and [local security architecture](../architecture/local-first-and-security.md),
and add dated forward notes to the related ADRs whose contracts are refined.
The references own exact schema/API details; this ADR records the authority choice.

## Acceptance obligations

1. Native read/list/glob/mention/write tests cover each new credential class and both
   lexical/canonical aliases; a read spy proves no descent into refused directories.
2. Commander-to-dispatch tests exercise all named surfaces, config selector
   precedence, empty/absent selectors and flags without config. Invalid invocation
   grants cause zero history/key/provider/MCP effects; invalid resumed selectors
   permit only the documented existing-history prerequisite, with no new session/
   turn or key/provider/MCP effects. Workflow isolation is a positive control.
3. Fresh/resumed/reseated sessions use the same owned policy; retargeted roots and
   launch-directory substitutions cannot widen it. Real extra-root results can be
   supplied to a subsequent read without ambiguity.
4. Scratch tests cover tmp/artifact descriptors, unrelated descriptors, home secrets,
   project metadata, sibling prefixes, nested floors and symlink replacement. No
   production scratch lifecycle is claimed from synthetic descriptor tests.
5. Shared-helper causal controls reach actual tool fs and native `save_to`; CAS native
   controls cover get/readRange/put/putStream/delete/GC and prove no sibling I/O for
   planted links. Native Windows gates supplement portable lexical vectors.
6. Removing each admission/floor/containment mechanism must break its corresponding
   regression. Full required gates and an independent fs/path-jail sitting pass.

## Consequences

### Positive

- Committed configuration can narrow explicit authority without creating it.
- Tool fs, save_to and CAS share the ancestor mechanism without sharing permissions.
- Future scratch can use a reviewed general floor rather than another exception.

### Negative

- Extra roots must be reauthorized on each invocation/resume; clear flag help and
  actionable, value-free refusal messages make this deliberate friction visible.
- Canonical identity checks add host I/O. Keep policy snapshots small and test actual
  native paths rather than assuming lexical containment proves physical safety.
- Same-user parent replacement and arbitrary subprocess file access remain outside
  this host mechanism's guarantee; document the limits without claiming OS isolation.

### Maintainer acceptance — 2026-10-12

The maintainer approved the revised decision and the eight-step Wave 2 execution
plan after the ten-comment intake and two fresh independent cumulative proposal
reviews. Dependent implementation is authorised on `development`; acceptance of
this decision does not certify unimplemented mechanisms or close the wave.

### Implementation-scope checkpoint — 2026-10-12

Step 2 code and canonical documentation are being reconciled on `development` against this accepted decision. The [owning checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#step-2-implementation-checkpoint--2026-10-12) distinguishes the scratch prerequisite from its future producer and CAS physical containment from Step 6 bounds/cancellation/maintenance. Unified independent implementation review and required gates remain pending; decision acceptance is not implementation acceptance.

### First implementation review and platform correction — 2026-10-12

The first cumulative round reproduced valid CAS readers failing during cooperative
same-hash atomic publication. Read-only descriptor validation now tolerates that
replacement while retaining current physical-floor checks and verifying the
descriptor's bytes against the requested hash; destructive and temporary ownership
checks remain strict. Published platform checks also exposed Windows path-case and
no-follow assumptions, and a Linux inode-reuse test fixture. The
[implementation checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#step-2-implementation-checkpoint--2026-10-12)
records their corrections and pending independent acceptance. Chat admission also
refuses a credential/secret-store workspace before canonical persistence can erase
its lexical floor. This is restrictive admission under the existing floor, not a
durable grant/provenance store or a canonical registry of machine credential roots.

### Native cooperative-publication correction — 2026-10-12

Published Windows and Node-floor execution exposed two further cooperative-storage
cases after the first correction. Windows can refuse replacement of an open file;
Linux pathname stat can observe the just-detached regular inode with zero links.
Non-owning final-entry admission now distinguishes that snapshot from temporary or
destructive authority. Windows replacement contention is resolved only by independent
verification of an existing matching content address, with owned-temp cleanup and no
rename retry. The [canonical CAS contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns the exact behaviour. Native fault/cooperation controls and new independent
reviews are required; the preceding clean macOS slices do not certify these changes.

### Windows canonical-root correction — 2026-10-12

Independent later Windows checks exposed a root-representation mismatch: the legacy
synchronous resolver retained a short-name spelling while asynchronous operations
used its native long name. Native canonical resolution now joins root admission,
session-anchor validation and catalog containment, retaining original lexical pins.
The [canonical filesystem contract](../reference/shared-core/built-in-tools.md#cli-authority-and-floors)
owns that join. A deterministic real-file control removes native root selection;
new native execution and fresh cumulative reviews still gate implementation acceptance.

### Terraform default credential-file correction — 2026-10-12

The fourth cumulative implementation review reproduced a gap in the named Terraform
credential floor: its standard `.terraformrc` and Windows `terraform.rc` files may
contain API tokens but were absent from the common basename predicate. They now
join that same folded read/write/discovery floor, including canonical aliases;
ordinary Terraform source and similarly named non-credential files remain usable.
The [canonical filesystem contract](../reference/shared-core/built-in-tools.md#cli-authority-and-floors)
owns the file list. Permanent native controls and the existing basename-removal
mechanism require the correction; the finding-bearing review is not a clean round.

### Cooperative deletion correction — 2026-10-12

The sixth cumulative implementation round reproduced an idempotence regression:
two cooperating stores admitted one blob, then the already-completed peer unlink
caused a missing-file refusal in the other. Its host-GC pass stopped before orphan
enumeration. Missing after admitted deletion is an already-reclaimed outcome;
strict root/shard/final admission and other I/O failures remain distinct. The
[canonical CAS contract](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
owns the behaviour. Native barrier and actual caller controls must fail under
removal; fresh independent cumulative reviews follow the correction.

### Shared-helper consumer qualification — 2026-10-12

The positive consequence above overstates the shared ancestor helper's consumers.
Tool filesystem operations and native `save_to` use the injected shared helper;
CAS uses its separate pinned root/shard/final identity checks. They share the
containment obligation, not one ancestor implementation or permission authority.
The Decision and acceptance obligation 5 already distinguish these mechanisms.
Their [canonical filesystem and CAS contracts](../reference/shared-core/built-in-tools.md#physical-media-storage-and-limits)
remain controlling. This documentary correction does not change runtime behaviour.


### Wave 2 implementation landing — 2026-10-13

The applicable Wave 2 implementation is accepted on `development`. The
[closing register](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-closing-register--2026-10-13)
joins the per-item disposition, two NEW clean complete whole-wave review rounds,
security sittings, exact-source gates and preserved limits. Earlier dated pending
checkpoints remain historical. This landing does not claim a merge, future header
activation, full M/N lifecycle or removal of approved residuals.

### Git worktree and identity-selector floor correction — 2026-10-13

The subsequent PR #94 review found equivalent credential/configuration selectors
missing from the existing shared floor. The
[canonical filesystem contract](../reference/shared-core/built-in-tools.md#cli-authority-and-floors)
now includes Git worktree configuration alongside repository configuration, while
the one shared declared-environment predicate includes the additional AWS and Docker
selectors. This restores the accepted credential-selection boundary without widening
invocation authority or refusing unrelated filename prefixes. Permanent native and
folded-path controls distinguish credential targets from ordinary lookalikes; a
dedicated worktree-config removal and the shared environment removal require the
new refusals. Source review and current-head publication remain separate gates.

### Scratch composition and literal glob correction — 2026-10-15

Maintainer review demonstrated that a host-issued scratch descriptor was ignored
when the same factory invocation carried an admitted filesystem policy. Composition
now retains that policy's exact workspace, selected-root and invocation-grant pins
and attaches only the independently owned scratch descriptor. It neither re-pins
canonical strings nor grants subordinate string roots. Forged or conflicting
descriptors refuse, and reattaching the same authority is idempotent.

Literal glob reads now admit their actual parent directory, preserving the same
root, credential and symlink floors as wildcard neighbours. The
[canonical filesystem contract](../reference/shared-core/built-in-tools.md#cli-authority-and-floors)
also states that the existing write floor inherits the entire sensitive-read set.
Permanent factory, revocation, lexical-provenance, glob and floor controls accompany
these existing-contract repairs. Native Windows selections include the new files;
selection is not execution. Independent source rounds and current-head publication
remain separate gates, with no new allocator, public API or permission authority.

### Raw UNC glob admission correction — 2026-10-15

The first cumulative review of scratch/literal-glob repairs identified a lexical
floor interaction: Windows separator normalization erased the raw UNC spelling
before glob-parent admission. Wildcards already had the hole; literal-parent
support made it reachable for literal globs too. Raw pattern admission now precedes
normalization, and the common Windows guard covers equivalent slash/mixed spellings.
POSIX double-slash semantics and ordinary local Windows drive paths are preserved.

Permanent literal/wildcard controls require fixed fatal refusal with no asynchronous
path lookup, enumeration or byte access in project and full tiers. The existing
native Windows cohort selects the equivalent-separator cases; local source/control
proof is not native Windows execution or a network-share fixture. The material fix
requires two NEW clean complete cumulative rounds; prior selected controls at
`eee9ca53` remain historical until corrected-head publication.


### Wave 2 merge landing — 2026-10-15

The applicable Wave 2 implementation and maintainer corrections merged to `main`
as PR #94 (`ab08209e`). The [merge checkpoint](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15)
joins final reviewed source `4cdfe011`, review scopes, execution evidence and preserved
limits. Earlier pending/unmerged notes are historical; this landing adds no decision,
future feature, deferral or claim of merge-commit execution.

## Wave 3 decision acceptance — 2026-10-16

> Amended 2026-10-16: [ADR-0111](0111-cli-meta-operations-use-a-lazy-packaged-runtime.md) is accepted by the maintainer. Meta operations deliberately skip directory existence/link/permission grant admission while retaining pure grammar/count/size checks; no filesystem authority is minted. Execution preserves filesystem admission before the one catalog seed and later model/cost admission. ADR-0112 separately narrows built-in chat HTTP authority without changing filesystem grants. The approved [execution plan](../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#proposed-implementation-increments) owns implementation and review gates; this note does not claim implementation landing.
