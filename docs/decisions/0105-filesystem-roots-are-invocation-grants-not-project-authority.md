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
