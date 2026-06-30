import type { FsScopeTier, ToolDef, ToolHost } from '@relavium/core';
import type { ToolPolicy } from '@relavium/shared';

import { createNodeEgressCapability } from './egress.js';
import { createNodeFsCapability } from './fs.js';
import { createNodeOsCapability } from './os.js';
import { createNodeProcessCapability } from './process.js';

// Re-export the host-arm error vocabulary from the factory so a consumer narrowing on a denial/transient failure
// has ONE import site — the seam's public entry point — rather than reaching past it into each arm module. The
// shared bases let a caller catch the whole class (`HostDeniedError` = every fatal `tool_denied`) or a specific
// arm (`FsScopeDeniedError`). `export…from` keeps these pure pass-throughs (no local binding).
export {
  EgressCapabilityError,
  EgressDeniedError,
  HostCapabilityError,
  HostDeniedError,
  OsCapabilityError,
} from './errors.js';
export { FsCapabilityError, FsScopeDeniedError } from './fs.js';
export { ProcessCapabilityError, ProcessDeniedError } from './process.js';

/**
 * The shared CLI **tool-environment factory** ([ADR-0055](../../../../../docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md),
 * 2.5.A) — the single place both the chat path (`chat/session-host.ts`) and the workflow-run path
 * (`engine/build-engine.ts`) assemble their `ToolHost` capability arms + the chat-default `ToolPolicy`, so the
 * two paths can never drift (the prior bug was two divergent inline host expressions, one of which *replaced*
 * rather than *merged* the MCP arm). It keeps the three tool-dispatch concepts in three channels: the
 * {@link ToolHost} capability arms (here), the {@link ToolPolicy} allowlists (here for chat; the run path uses
 * the workflow's resolved policy per node), and the per-dispatch `fsScope` (carried on the dispatch context).
 *
 * **Phased wiring:** three profiles. `chat-read-only` (2.5.A) is `fs` read+list + `process` serving the
 * pre-approved `git_status`. `workflow-read-write` is the author-trusted read+write run host (`fs`-write +
 * `process`, full tier). `chat-read-write` ([ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md),
 * 2.5.E) is the **full-capability** chat host — `fs`-write + `process` + the `egress` and `os` arms (the
 * 2.5.A deferral, closed here) — that the per-tool **approval floor** makes safe: the host is full-capability
 * for the session and the *mode* (advertise-filter + the fail-closed `confirmAction` regime) gates it, never
 * capability absence (ADR-0057 §Decision). The chat tiers (read-only AND read-write) clamp `full` → `project`
 * (an unjailed READ exfiltrates `~/.ssh`); `full` stays only for the author-trusted workflow profile. The
 * caller merges any inbound-MCP arm onto `host` with a conditional spread (a true merge, never a replace).
 */

/** The three host profiles: read-only chat, the full-capability (approval-gated) chat host, and the run host. */
export type ToolEnvProfile = 'chat-read-only' | 'chat-read-write' | 'workflow-read-write';

export interface AssembleToolEnvOptions {
  readonly profile: ToolEnvProfile;
  /** The active filesystem scope tier (chat: `[chat].fs_scope` ?? sandboxed; run: the workflow's `fs_scope`). */
  readonly fsScopeTier: FsScopeTier;
  /** The session/run working directory (absolute) — the fs jail anchor and the process spawn cwd. */
  readonly workspaceDir: string;
  /** An optional extra sandboxed fs root (e.g. `~/.relavium/tmp/`); absent ⇒ workspace-only. */
  readonly tmpDir?: string;
  /**
   * Resolve a `web_search` / `http_request` `credentialRef` to its secret VALUE host-side (the keychain) for
   * the `egress` arm — never logged, never returned to the engine ([ADR-0006](../../../../../docs/decisions/0006-os-keychain-for-api-keys.md)).
   * Consulted ONLY by the `chat-read-write` profile (the one that wires `egress`); absent ⇒ an egress request
   * proceeds with no credential (a provider that needs one returns 401, surfaced to the model — never a crash).
   */
  readonly egressCredentialResolver?: (ref: string) => Promise<string | undefined>;
}

export interface AssembledToolEnv {
  /**
   * The capability arms: `fs` + `process` always; the `chat-read-write` profile additionally wires `egress` +
   * `os`. The caller merges the MCP arm on top.
   */
  readonly host: ToolHost;
  /** The chat-default policy (empty allowlists). The run path overrides per node with the workflow policy. */
  readonly policy: ToolPolicy;
}

/**
 * The EFFECTIVE fs-scope tier for a chat session (read-only OR the approval-gated read-write): `full` clamps to
 * `project` (workspace-only). SECURITY — neither read-only NOR the approval floor neutralizes `full` for the
 * lowest-trust surface: an unjailed READ can exfiltrate `~/.ssh` / `~/.aws/credentials` back to the
 * model/provider regardless of write-gating, so BOTH chat tiers clamp. `full` stays for the author-trusted
 * `workflow-read-write` profile. Exported so the caller can stamp the SAME effective tier on the
 * `SessionContext.fsScope` it persists — keeping the dispatch-context tier and the host jail consistent
 * (ADR-0055's "three channels").
 */
export function clampChatTier(tier: FsScopeTier): FsScopeTier {
  return tier === 'full' ? 'project' : tier;
}

/** Assemble the `ToolHost` + chat-default `ToolPolicy` for a profile. Pure construction — no I/O here. */
export function assembleToolEnv(opts: AssembleToolEnvOptions): AssembledToolEnv {
  const readOnly = opts.profile === 'chat-read-only';
  const isChat = opts.profile === 'chat-read-only' || opts.profile === 'chat-read-write';
  // Both chat tiers clamp `full`→`project` (see clampChatTier); only the author-trusted workflow keeps `full`.
  const tier: FsScopeTier = isChat ? clampChatTier(opts.fsScopeTier) : opts.fsScopeTier;
  // The full-capability chat host (ADR-0057): `egress` + `os` ride on top of fs-write + process, made safe by
  // the per-tool approval floor (the regime + advertise-filter the session-host activates), NOT by absence.
  const wireEgressOs = opts.profile === 'chat-read-write';
  const host: ToolHost = {
    // NOTE: the factory does not yet pass `extraRoots`, so the `project` tier behaves as workspace-only (it can
    // only NARROW the jail — never a hole); until the `project` path-allowlist lands, `project` ==
    // `sandboxed`-minus-tmp. The `chat-read-write` profile sets `readOnly:false` — its writes are gated by the
    // ADR-0057 approval floor (and the always-on protected-paths refusal in fs.ts), never by capability absence.
    fs: createNodeFsCapability({
      tier,
      workspaceDir: opts.workspaceDir,
      readOnly,
      ...(opts.tmpDir === undefined ? {} : { tmpDir: opts.tmpDir }),
    }),
    // The process arm itself has no read-only notion — chat-safety rests ENTIRELY on the policy layer above:
    // the empty `allowedCommands` default denies `run_command`, and `git_status` exposes no model-controlled
    // command. Loosening the chat `allowedCommands` in a future profile is therefore a security-review trigger.
    process: createNodeProcessCapability({ workspaceDir: opts.workspaceDir }),
    // egress + os: wired ONLY for the full-capability `chat-read-write` profile (ADR-0057 closes the 2.5.A
    // deferral). `egress` rides the fail-closed approval floor (a governed class); `os` (clipboard/notify) is
    // non-governed and gated only by the mode's advertise-filter. The read-only chat + workflow profiles wire
    // neither: a read-only chat must not reach the network, and the workflow run path's egress/os is a separate
    // (author-trusted) concern, not part of the chat approval story.
    ...(wireEgressOs
      ? {
          egress: createNodeEgressCapability(
            opts.egressCredentialResolver === undefined
              ? {}
              : { resolveCredential: opts.egressCredentialResolver },
          ),
          os: createNodeOsCapability(),
        }
      : {}),
  };
  // Chat default: empty allowedCommands ⇒ `run_command` denied; `git_status` is pre-approved and exposes no
  // model-controlled command, so an empty allowlist never blocks it (ADR-0055). NOTE: this is inert today —
  // the chat path relies on the `AgentSession` default `{}` and the run path uses the workflow's per-node
  // policy; the `{ host, policy }` shape is the ADR-0055 seam that 2.5.E/ADR-0057 populates with per-mode
  // allowlists. Pinned by the factory test so the chat default can't silently drift.
  const policy: ToolPolicy = {};
  return { host, policy };
}

/**
 * The **advertise-filter** (ADR-0055, 2.5.A): the subset of `grantedIds` whose required `ToolHost` capability
 * arm is actually wired in `host`, so an unwired tool is **never offered** to the model and the agent's
 * "say so plainly when a tool is unavailable" path applies. It is the best-effort complement to the
 * fail-closed dispatch backstop (`tool_unavailable`, EA1) — never a substitute for it. A granted id with no
 * matching `ToolDef` (a dynamically-registered tool resolved elsewhere) is kept; the registry still gates it.
 */
export function wiredToolIds(
  grantedIds: Iterable<string>,
  host: ToolHost,
  defs: readonly ToolDef[],
): string[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: string[] = [];
  for (const id of grantedIds) {
    const def = byId.get(id);
    if (def === undefined || requiredArmPresent(def, host)) out.push(id);
  }
  return out;
}

/**
 * Whether the `ToolHost` arm a tool needs is wired. The arm is the tool's TRANSPORT, which is not always its
 * `policy.egress` *kind*: a discovered MCP tool and the `mcp_call` built-in both route via `host.mcp` (the
 * `mcp` egress kind is a guardrail label, not the arm), while `http`/`search` egress route via `host.egress`.
 * An armless tool (os/delegate) is kept and left to the dispatch `tool_unavailable` backstop (EA1).
 */
function requiredArmPresent(def: ToolDef, host: ToolHost): boolean {
  if (def.source === 'mcp') return host.mcp !== undefined; // discovered MCP tools route via host.mcp
  if (def.policy.fsScoped) return host.fs !== undefined;
  if (def.policy.spawnsProcess) return host.process !== undefined;
  if (def.policy.egress === 'mcp') return host.mcp !== undefined; // the `mcp_call` built-in also uses host.mcp
  if (def.policy.egress !== undefined) return host.egress !== undefined; // `http` / `search` → host.egress
  // `os` (read_clipboard/notify → host.os) + delegate-backed tools (read_media → ctx.mediaRead, invoke_agent →
  // ctx.invokeAgent) carry no policy-class arm here: keep them and let the dispatch `tool_unavailable` backstop
  // (EA1) handle an absent arm/delegate — the filter is a best-effort complement, not a substitute.
  return true;
}
