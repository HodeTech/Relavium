# Built-in Tools

- **Status**: Stable
- **Canonical home**: the catalog of tools every local agent can call out of the box
- **Related**: [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [mcp-integration.md](mcp-integration.md), [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md)

Tools are the capabilities an agent can invoke beyond pure text generation. Relavium ships a fixed set of **built-in tools**; an agent or `tool` node opts in by listing tool ids in `tools:` (see [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md) and [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)). Beyond these, agents can call **MCP** tools and user **plugins** — see [mcp-integration.md](mcp-integration.md).

A tool declaration in YAML has a `type` discriminator:

| `type` | Source | Examples |
| --- | --- | --- |
| `builtin` | shipped with `@relavium/core` | the table below |
| `mcp` | a registered MCP server tool | see [mcp-integration.md](mcp-integration.md) |
| `plugin` | a user-supplied npm package | see [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md) |
| `http` | an arbitrary REST endpoint | configured per call |

## The built-in tools

| Tool id | Purpose | Returns (shape) | Notes |
| --- | --- | --- | --- |
| `read_file` | Read text file content as UTF-8. Supports glob for reading multiple files. | `{ content, mimeType, sizeBytes, lastModified }`; **binary/media content returns a durable media handle** (`tool_result.media`, [ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)), never inline base64 | Respects the workflow's FS scope tier. |
| `write_file` | Write or append content to a file. Optionally creates parent directories. | `{ path, bytesWritten }` | Within the allowed scope only. |
| `list_directory` | List directory contents, optional recursive + glob filter. | `{ entries: [{ name, type, sizeBytes, lastModified }] }` | Respects FS scope. |
| `run_command` | Spawn an OS process with **`shell: false`** (no shell interpretation) and return its byte-bounded captured output. | `{ exitCode, stdout, stderr, durationMs }` | **Exact-match allowlist required** — see below. Never runs unlisted commands. |
| `http_request` | Outbound **HTTPS** (GET/POST/PUT/DELETE), custom headers, JSON body, streaming response. | response body / stream | **HTTPS-only**, exact-FQDN `allowedDomains` allowlist (empty/absent ⇒ disabled), private/loopback/link-local/metadata ranges blocked (SSRF) — see below. |
| `web_search` | Web search via the configured provider (e.g. Brave Search / SearXNG). | `{ results: [{ title, url, snippet }] }` | Provider key in the secret store, not the workflow file. |
| `git_status` | Run `git status` / `git log` / `git diff` in the workspace (read-only). | the raw `git` process result | The model picks only the subcommand; any extra flags are **author-pinned via config**, not model-supplied (a model-controlled `--no-index`/`-p --all` would read arbitrary files / dump history). |
| `git_commit` | Create a commit with a message, optionally restricted to given pathspecs (does **not** `git add`/stage). | commit result | **Requires a `human_gate` approval** before executing in automated workflows; pathspecs are `--`-separated so a model cannot smuggle a git option. |
| `read_clipboard` | Read current clipboard text. | `string` | Powers "process what I just copied" triggers. |
| `notify` | Send a native desktop notification (title, body, optional action buttons). | `void` | Lets an agent request attention mid-run without blocking the run. |
| `mcp_call` | Connect to a registered MCP server and invoke one of its tools by name. | the MCP tool result as JSON | Server resolved from config; see [mcp-integration.md](mcp-integration.md). |
| `invoke_agent` | Call another agent node in the same workflow by node id, with explicit input. | that agent's output | The dynamic-dispatch mechanism used by orchestrator agents to delegate. |
| `read_media` | Read a produced/received media asset by its durable `media://sha256-…` handle (**whole handle** — no byte range), so a media-capable model can look at it. | a short **text descriptor** (mime type, byte length, handle) as the `tool_result`; the media itself arrives as a top-level `media` part on a **marked, engine-synthesized `user` message** appended right after it ([ADR-0089](../../decisions/0089-media-correctness-four-boundaries.md) §1) | **Scope-set authz** — the requesting `session`/`workspace` must be in the handle's `allowedScopes` ([ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md) §1); knowing a sha256 is **not** authorization; read-only (bypasses the action gate), secret-free `media_scope_denied`. The tool never touches bytes: it authorizes a handle and describes it, and the chain's egress re-materialization resolves the handle per attempt (ADR-0043 §1), so a failover or a resume re-resolves from the canonical handle. The synthesized message carries a fixed engine-authored preamble naming the tool — it must never present as the user's own words. Because the media rides the ordinary media-INPUT rail it is bounded by it: `read_media` **refuses** a video, a PDF (never inline at any size) or an image/audio handle over `INLINE_MEDIA_CEILING`, with a correctable `invalid_args` naming the limit — so the model picks another handle instead of the next request dying on a schema error after the tool has already run. A response's tool calls may deliver at most `ADMISSION_CEILINGS.mediaAttachmentsPerResponse` attachments, refused by the engine before the seam's own per-message cap. All of a response's attachments arrive on **one** synthesized message appended after the FINAL tool result — after every one of them, never interleaved between two — a tool result must stay contiguous with its siblings or the providers reject the turn. And a model that does not accept image input refuses the turn rather than being handed a descriptor for something it never received. *(The delivery path ships as of `W5`/`CR-50`. The host `MediaReadAccess` delegate and the `session`/`workspace` scope population remain unwired in production — see [deferred-tasks.md](../../roadmap/deferred-tasks.md); absent the delegate the tool fails closed with `tool_unavailable`.)* |

> **Mandatory guardrails (security tightenings — [ADR-0029](../../decisions/0029-tool-policy-hardening.md)):** `run_command` only executes commands that **exactly match** the workflow's `allowedCommands` allowlist (opt-in glob via `allowedCommandGlobs`; defined under `spec.tools.allowedCommands` — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools); empty or absent ⇒ disabled). `http_request` is **HTTPS-only**, matches `allowedDomains` by **exact FQDN** (empty/absent ⇒ disabled), and **blocks private/loopback/link-local/metadata IP ranges** — the same vetted SSRF primitive applied to provider base URLs and MCP server URLs ([security-review.md](../../standards/security-review.md)). And `git_commit` is gated behind human approval in automated workflows. All are enforced by the engine, not by convention. `run_command` is the **only** allowlisted shell-exec built-in — there is no separate `run_javascript` tool (sandboxed JS evaluation is the engine's job for `condition`/`transform` expressions, not a callable tool).

> **Return shapes.** The *Returns* column is the **logical** shape. Until a provider-specific normalizer lands, `http_request` / `web_search` / `mcp_call` / `git_status` dispatch the **raw host response** (`EgressResponse` / the MCP tool result / the `git` `ProcessResult`); a downstream `transform` node shapes it. The file tools (`read_file` / `write_file` / `list_directory`) and `run_command` already return the documented shape.

## Tool input/output mapping

A `tool` node (direct tool execution without an LLM) and an agent's tool call both use `input_mapping` / `output_mapping` to wire workflow state into the tool and the result back out. Tool credentials are referenced by id from the secret store and are **never** inlined into the workflow JSON or echoed into event payloads (`agent:tool_call.toolInput` is sanitized; see [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md)).

## Config-only parameters

A built-in tool's parameters split into two tiers. **LLM-visible** parameters form the JSON Schema the `ToolNormalizer` lowers to each provider's wire shape — the only parameters a model may supply. **Config-only** parameters take their **values from the node's `tool_config` / `agent_config` block** ([node-types.md](node-types.md) — `parameters`), are merged at dispatch (config wins), and **never** appear in the LLM-facing schema: a model-supplied argument can never override one. This keeps prompts small and pins safety-relevant values (a root path, a base URL, a timeout) out of the model's reach. The `ToolDef` field shape and the dispatch-time merge are canonical in [tool-registry.md](tool-registry.md); the decision is [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md).

## Tool result bounding

The result a tool hands **back to the model** (which re-enters the next request) is size-bounded — distinct from the `agent:tool_result.outputSummary` *event* field, which is truncated separately for display ([sse-event-schema.md](../contracts/sse-event-schema.md)). The bound is **model-facing only**: `output_mapping` writes the **full** result into workflow state, so a downstream node still gets the real value; only the model-facing copy is replaced by a **bounded preview** (honoring **both** the byte and the line ceiling), an explicit **truncation marker**, and the **path** to the full output spilled to the host's run-scoped **output store** (reclaimed at the run's terminal event). This closes the model-facing context-window cost/DoS surface the pre-egress budget governor ([ADR-0028](../../decisions/0028-workflow-resource-governance.md)) cannot see — an oversized `read_file` / `http_request` / MCP result blows the *next* request's window. *v1.0 caveat:* the bound is over the **in-memory** result the dispatch returns; the stream-and-spill-at-the-source guarantee (the engine never holding the full bytes) is a **host-capability obligation** that lands with the first genuinely-streamed large source (see [tool-registry.md §Result bounding](tool-registry.md#result-bounding-and-spill-to-file)). The output store is its own host capability, so bounding works even on a host with no filesystem (`web_search` / MCP).

| Knob | v1.0 default | Note |
| --- | --- | --- |
| Byte ceiling | 50 KB | over ⇒ spill + preview (model-facing only) |
| Line ceiling | 2000 lines | over ⇒ spill + preview (model-facing only) |
| Preview | head + tail slice within the ceiling | the marker names the omitted span |
| Spill | the host's run-scoped output store; reclaimed at the terminal event | the path is handed to the model; readable via the FS-scope-tiered tools |

The ceiling is a **byte/line** bound — no token count, which would need a provider-specific tokenizer and break engine purity. These defaults are tunable and revisited if real workflows hit them (the [deferred-tasks.md](../../roadmap/deferred-tasks.md) tool-output-gate framing). The dispatch lifecycle that applies them is in [tool-registry.md](tool-registry.md#result-bounding-and-spill-to-file).

## Subprocess environment

A tool that spawns a process (`run_command`, `git_*`) runs with **`shell: false`** under an **explicitly-constructed environment** — **never** a blanket copy of the host environment, which would hand every subprocess the host's secrets and hijack vectors (`PATH`, `NODE_OPTIONS`, …). Because the engine is platform-free it cannot build a platform base env or resolve an executable on `PATH`, so the split is: the **engine** supplies the policy (the allowlist-checked command) plus the declared extra variables; the **host** resolves the executable, supplies the platform-minimal base env, and merges only the declared variables under an audited allowlist. The seam is in [tool-registry.md](tool-registry.md#the-toolhost-capability-seam).

## Filesystem permission tiers

File scope is host-enforced. The desktop uses its scoped filesystem layer and Tauri v2 capabilities ([tauri-plugins.md](../desktop/tauri-plugins.md)); its native permission-dialog/capability-grant mechanism is surface-specific. The Node CLI uses the host-owned policy below ([ADR-0105](../../decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md)). A committed path declaration alone never authorizes CLI access.

| CLI tier/surface | Effective roots |
| --- | --- |
| Sandboxed chat | workspace only |
| Project chat | workspace plus invocation-authorized selected roots |
| Full chat | clamped to project |
| Workflow full | retains author-trusted full-tier behavior |

A valid host-issued scratch descriptor conditionally adds only its exact subtree in sandboxed/project tiers. Exact [argv grants](../cli/commands.md#global-options) and [TOML selectors](../contracts/config-spec.md#chat-filesystem-root-selectors) have their own canonical homes. Workflow `run` does not consume chat roots.

### CLI authority and floors

The CLI owns an immutable, process-local policy with pinned lexical/canonical directory identities, rechecked at each capability operation. Read/list/glob, mention/completion, discovery and write boundaries check lexical provenance and canonical targets; recursive enumeration prunes denied directories **before descent**. An ordinary extra-root grant never overrides confidentiality or protected-write floors, including full tier and auto mode.

Synchronous root admission uses native canonical resolution, matching asynchronous file operations. Windows short-name and long-name spellings must resolve to the same canonical authority; lexical spellings remain separately pinned for provenance and confidentiality checks. Native path membership alone cannot equate two unresolved aliases.

Raw UNC tool paths refuse before asynchronous path resolution, enumeration or byte I/O,
including literal and wildcard globs before separator normalization. On Windows the
equivalent forward-slash and mixed-separator UNC prefixes also refuse; this does not
change POSIX double-slash absolute-path semantics. A full tier does not bypass this floor.

The read floor refuses `.ssh/`, `.relavium/`, `.aws/`, `.env/`, `.kube/`, `.azure/`, `.terraform.d/`, `gcloud/` and `legacy_credentials/`; dotenv files `.env`/`.env.*`; `.docker/config.json`; repository `.git/config` / `.git/config.worktree` (including linked worktrees and bare `*.git` repositories) and git's XDG `credentials`; and credential basenames `.gitconfig`, `.git-credentials`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.envrc`, `.dockercfg`, `application_default_credentials.json`, `credentials.tfrc.json`, `.terraformrc` and `terraform.rc`. The write floor inherits the entire sensitive-read credential set above and additionally refuses whole `.git/` directories and shell-startup files; `.relavium/` and `.ssh/` are already included in that inherited set. Components are folded for Windows case, trailing dot/space and alternate-stream aliases. The shared [declared-env predicate](../../../packages/shared/src/declared-env.ts) refuses credential/config redirects for subprocesses; it is not a filesystem grant.

Chat uses the full-capability `chat-read-write` host with writes/egress/os gated by the per-tool approval floor: default ask denies governed actions. Credential/protected-path refusals remain mode-independent. `read_file` still fails closed on binary/media until its durable-handle host path is wired. Existing tool-fs bounded fd reads and hard-link controls remain, including the scoped [pnpm virtual-store read residual](../../roadmap/deferred-tasks.md). That exemption does not apply to CAS.

Permitted extra-root results remain usable as workspace-relative paths retaining necessary `..`, or canonical absolute paths when a relative representation is impossible across Windows drives. Glob reads accept literal paths as well as `*`, `?` and `**` patterns: the parent prefix before the first metacharacter, or the parent directory of a literal path, is admitted under the same roots and floors. Absolute and workspace-relative paths into selected extra roots obey the same authority. Directory entry names are relative to the requested directory; mention/completion consumers do not anchor them twice. Renderers still treat returned text as untrusted.

### Shared ancestor resolution

`deepestExistingReal(startDir, ops)` in `@relavium/shared` is platform-free. Its injected operations are asynchronous `realpath(path)` and `lstat(path)` (returning `isDirectory()`), `dirname(path)`, and `isMissing(error)`. It climbs only when both canonical resolution and lexical inspection prove an entry missing. Permission failures, EACCES/ELOOP/ENOTDIR, non-directories and existing dangling links refuse with a content-free error. The consumer owns containment and permissions.

CLI tool fs and native `save_to` reuse this algorithm without sharing authority: trusted persistence may write `.relavium/runs`, model tools cannot. `save_to` rejects all Windows drive prefixes, including `C:relative`, before I/O, alongside absolute/UNC/traversal paths.

### Host-issued scratch

The host-only `issueHostScratchRoot({ homeDir, rootDir })` factory issues an opaque descriptor for one exact, existing private subtree beneath the trusted home `.relavium` anchor; `createFsPathPolicy({ workspaceDir, extraRoots?, scratch? })` accepts that descriptor. String paths, TOML and tool arguments cannot construct the authority. `assembleToolEnv({ fsPolicy, scratch })` composes the descriptor with an already admitted policy while retaining its original workspace, selected-root and invocation-grant pins. Reattaching the same descriptor is idempotent; forged or conflicting descriptors refuse. At the filesystem-capability factory an opaque `pathPolicy` takes precedence over string `extraRoots`; those strings do not add to its authority. Host construction performs native pinning I/O; the engine remains platform-free.

Both lexical and canonical containment must hold. Anchor/root identities are pinned and rechecked; anchor/root and descendant directories require owner-only POSIX modes and ownership, and symlink descendants refuse. The descriptor exempts only the ancestor `.relavium` component for accesses inside that exact subtree. Home config/history, every project `.relavium`, siblings/prefixes and nested secret/protected components remain denied. Windows retains the owner-controlled profile/ACL assumption; POSIX-bit checks do not verify Windows ACLs.

Synthetic tmp/artifact descriptor tests establish this prerequisite only. Automatic global tmp provisioning is removed without deleting existing directories; ordinary chat has no production allocator. [Phase 2.6.N](../../roadmap/phases/phase-2.6-conversational-authoring.md#26n--child-session-foundation-catalog-spawn-standardized-io-lineage) still owns production provisioning, per-parent isolation, join, cleanup and recovery.

### Physical media storage and limits

The filesystem CAS pins its canonical root on the first admitted operation; reads/GC do not create an unused store, and later absence/replacement/retargeting revokes access. Shards/final descendants cannot be symlinks; files must be regular without extra hard links, with exclusive no-follow temporary ownership, one-fd read identity checks, atomic publication and the same physical containment checked for read, delete and GC. CAS has no pnpm exemption. Handle/port semantics live in the [MediaStore reference](llm-provider-seam.md).

An opened CAS read descriptor may become unlinked when a cooperating publisher atomically republishes the same handle. Reads validate the current root/shard/final-entry floor independently, retain the one opened regular descriptor (at most one remaining link), and verify its bytes against the requested hash before delivery. They do not require the final pathname to retain that descriptor's inode. Temporary ownership and destructive operations retain their stricter identity checks.

CAS deletion is idempotent when a cooperating process has already removed the admitted blob. Only the missing-file unlink outcome qualifies; the pinned root/shard authority is rechecked, and unsafe paths or other I/O failures still refuse. This does not weaken temporary-file cleanup ownership or claim atomic coordination between reference updates and garbage collection.

A pathname stat can itself observe the just-detached regular inode with zero links during concurrent replacement. Non-owning read and publication admission accept that snapshot; temporary ownership, deletion and GC still require one link. On Windows, if native replacement refuses with `EPERM` or `EBUSY`, a publisher performs one independent opened-file/hash verification of the existing winner. Only a valid matching blob satisfies the put; its unpublished owned temp is cleaned up. Missing, corrupt or physically unsafe winners refuse. There is no rename retry or weaker ownership check. A fixture that the OS prevents from replacing an open file proves native refusal, rather than claiming that replacement occurred.

These are owner-controlled storage/cooperating-host controls. Neither pre/post realpath nor final `O_NOFOLLOW` makes parent-directory swaps race-free or supplies a descriptor-relative jail against a hostile same-user process. Windows file-tool reads explicitly refuse an already-planted final symlink before open; Node's ignored Windows `O_NOFOLLOW` supplies no syscall-race guarantee. Native path membership accepts Windows case aliases while refusing sibling and cross-drive escapes. Filesystem grants do not constrain arbitrary subprocess arguments or provide an OS sandbox. Command allowlisting remains independent of file-tool scope.

[ADR-0106](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md) adds independent
store bounds and byte admission. The exact supported format profiles, errors and host API are in the
[media publication contract](llm-provider-seam.md#bounded-verified-media-publication-adr-0106).
`get`, `readRange` and `resolveForEgress` check the actual opened regular fd against the **25 MiB**
object ceiling before allocation and cumulatively during reads, including old-layout blobs and tiny
range requests. Oversized legacy bytes refuse without automatic deletion. `validateMedia` instead
uses an incremental hash/format/count scan without whole-object `get` or base64 materialization.
Both reference stores check range pre-abort and cancellation before delivery; filesystem operations
join their owned fd close and remove listeners. `readRange` still has whole-object backing under
CR-53; this is bounded cancellable delivery, not streaming range delivery. Windows replacement
contention verifies the existing winner through the bounded scanner rather than `get`.

New producers use exclusive owner-private `media-v1.<PID>.<UUID-v4>.tmp` files inside the pinned
root. Automatic `sweepTemporaries({ now? })` has a separate **24-hour** minimum age and requires
the producer PID to be proven absent. A live/reused PID, uncertain/permission-denied probe,
future timestamp, malformed candidate or unsafe entry is retained. An atomic claim preserves
original file identity and producer/claimant nonces. Destructive ownership requires one link;
dead claimant recovery recognizes pre/post-move and post-unlink states without recursive deletion
or stealing live claims. Recovery itself uses an exclusive claimant marker. Producer and offline
maintenance handshakes prevent a new writer from starting inside maintenance. This protocol is
local-device cooperating storage, not a distributed lease or hostile same-user jail.

Marker acquisition retains its captured descriptor identity through joined native close and
post-close ownership admission. A caught acquisition failure removes only its original known
regular one-link marker under the original pinned root; recovery additionally requires the exact
original claim-directory identity. Failed recovery acquisition leaves the claim directory for a
later normal sweep, so claim removal is counted only by successful directory cleanup. Unknown
identity, a replaced entry or revoked root is retained. Secondary cleanup failure cannot replace
the fixed primary acquisition error or expose native diagnostics.

New `media-claim-v2` records encode native bigint device/inode identities as bounded
canonical unsigned 64-bit tokens. Claim creation, post-move admission and final recovery
revalidation compare these exact identities without a Number conversion. Existing v1
claims retain their safe-integer/canonical validation; an ambiguous unsafe historical
token is retained, never promoted to deletion authority. Producer, maintenance and
recovery-marker layouts are unchanged. This targeted identity check supplements the
existing cooperative root/path floor; it does not upgrade that floor to a hostile-parent jail.

`pruneLegacyTemporaries({ legacyOffline: true, force: true })` requires **both** strict boolean
acknowledgements before mutation. It refuses the entire maintenance operation before any legacy
deletion if a new producer is live or uncertain. It admits only the two historical ownerless
grammars: root `stream.<UUID>.tmp` and one two-hex shard containing `<62-lowercase-hex>.<UUID>.tmp`.
Other suffix matches, symlinks and special entries do not acquire authority. An unrecognized
`media-maintenance-` prefix is not an unrelated stray: producer admission refuses it with
`maintenance_active`, offline maintenance refuses it with `owner_unknown`, and normal sweeping
retains it as `malformed`. An unknown owner or future protocol never acquires automatic deletion
authority. The flags acknowledge that old binaries, which have no producer records, are stopped. The
[CLI maintenance command](../cli/commands.md#relavium-media-prune-temporaries) fixes the global CAS
destination; absence reports zero without provisioning it or opening config/history/key services.
Normal temporary sweeping is independent of published-object reference GC and active run filters.

Both maintenance methods return `{ removed, retained, reasons }`, counting a claim plus its blob
as one candidate. For concurrent dead-claim recovery, the successful final claim-directory
removal accounts for that candidate, even when that recovery first retained a live peer's
marker and the peer subsequently removed the blob. After identity-checked removal of its
own marker, a losing recovery treats the peer's directory removal as contention rather than
I/O failure. Earlier marker/identity admission, pinned-root revocation and non-missing I/O
errors retain their refusal semantics. Retained reason counts sum to `retained`. Fixed reasons are `too_young`,
`future_timestamp`, `owner_live`, `owner_unknown`, `claimant_live`, `claimant_unknown`, `malformed`,
`unsafe_entry`, `identity_changed`, `legacy_offline_required`, `io`.
Arbitrary unrelated strays and published blobs are not candidates. `MediaTemporaryMaintenanceError`
has fixed `flags_required`, `producer_active`, `owner_unknown` or `maintenance_active` reasons;
physical root failures remain `MediaStoreFilesystemError`. No path, bytes or native error detail
is added to the public report. Step 6's cumulative review and native-platform gates separately
certify these mechanisms; this description does not infer Windows execution from portable tests.

## Where tools run

Built-in tools execute inside `@relavium/core`. On the desktop the engine and its tool dispatch run in the **WebView's JS runtime** (a Tauri WebView has no backing Node context); privileged side-effects are delegated to the Rust core through explicit Tauri commands — the authenticated LLM HTTPS egress goes through the `llm_stream` command ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), and `run_command` and similar shell executions spawn real OS child processes through the shell plugin under the allowlist. In the CLI and VS Code surfaces the same tools run in the Node.js host process. What is identical across surfaces is the **engine-level tool contract** — the dispatch semantics and the documented result shapes — because the engine is shared. What varies is the **execution location** (above) and **which host capabilities are wired, and their posture** — e.g. the CLI's approval-gated `chat-read-write` `relavium chat` profile (governed actions denied in the default `ask` mode), the `read_file` binary/media fail-close until a media store is wired, and the active fs-scope tier. Those are host- and phase-specific and are governed by their authoritative ADRs (the [CLI-host note](#filesystem-permission-tiers) above, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)), **not** restated as a cross-surface guarantee here: a tool that is *available* behaves and returns identically everywhere, while its *availability* is never promised to be uniform. See [../../architecture/execution-model.md](../../architecture/execution-model.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md).

Because `@relavium/core` has **zero platform-specific imports**, the engine cannot itself touch the filesystem, spawn a process, or open a socket. It owns the tool **policy and dispatch** (registration, exact-match resolution, argument validation, the guardrails below, result bounding, untrusted-data tainting) and performs every side effect through a host-injected **`ToolHost`** capability seam — the same purity seam as the `read_file` interpolation filter ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)'s injected transport, generalized). The seam, the dispatch lifecycle, and the `ToolDef` shape are canonical in [tool-registry.md](tool-registry.md); the decision is [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md).
