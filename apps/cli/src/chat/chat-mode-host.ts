import { resolve } from 'node:path';

import type { AgentSession, ToolApprovalRequest, ToolDef, ToolLiveObserver } from '@relavium/core';

import { isProtectedPolicyPath } from '../engine/tool-host/fs.js';
import type { FsPathPolicy } from '../engine/tool-host/fs-policy.js';
import type { DisplayPathRoots } from '../render/notation.js';
import {
  bindStartingModePolicy,
  type ChatModeSelection,
  type StartingModeAuthority,
} from './starting-mode.js';
import {
  ApprovalCache,
  buildTurnPolicy,
  governedToolIds,
  type ApprovalPrompt,
  type CommandGrantsPort,
  type ChatMode,
} from './chat-mode.js';

/**
 * The host glue between the pure {@link buildTurnPolicy} policy (chat-mode.ts) and a live {@link AgentSession}
 * (2.5.E Step 4b, [ADR-0057](../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)). It
 * holds the SESSION-SCOPED consent machinery — the once/always {@link ApprovalCache}, the governed hide-set
 * (derived once from the session's tool defs), and the protected-path predicate (bound to the workspace) —
 * and applies a mode by pushing the mapped `SessionTurnPolicy` to `session.setTurnPolicy`. The REPL owns the
 * `mode` UI state (footer + Shift+Tab) + the interactive `prompt`; this module owns the mapping so both the
 * fresh and resumed session paths apply modes identically. Creating it does NOT itself change any policy —
 * the caller applies the resolved starting mode via {@link applyChatMode}, so nothing here has a live effect until
 * the REPL wires it (keeping the pre-wire state safe).
 */

/** The session-scoped environment a mode is applied against — built once per session. */
export interface ChatModeEnv {
  readonly interactive: boolean;
  readonly startingModeAuthority?: StartingModeAuthority;
  readonly onToolLiveEvent?: ToolLiveObserver;
  /** The live session the mapped turn policy is pushed to. */
  readonly session: Pick<AgentSession, 'setTurnPolicy'>;
  /** Governed tool ids (the plan advertise hide-set) — derived once from the session's granted defs. */
  readonly governed: ReadonlySet<string>;
  /** The session once/always memory (shared across mode changes — an "always" persists until the session ends). */
  readonly cache: ApprovalCache;
  /** The REPL's interactive approval card (accept-edits, and auto's protected-path fallback): `Ctrl+Y` allow, `Ctrl+G` allow for
   * the session, `Ctrl+N` deny, `Ctrl+R` deny with a reason (a reject carrying WHY), `Esc`/`Ctrl+C` reject and stop the turn. */
  readonly prompt: ApprovalPrompt;
  /** Whether an approval REQUEST targets a protected path — `auto` then falls back to a prompt (ADR-0057). */
  readonly isProtectedTarget: (request: ToolApprovalRequest) => boolean;
  /** The remembered command grants of this project root (ADR-0118 §2): a command they cover is pre-approved, which is what lets
   *  `auto` run it without a card. Absent ⇒ nothing is remembered. */
  readonly commandGrants?: CommandGrantsPort;
  /** Whether a command's card offers "this exact command for the session" and "remember it" (see {@link TurnPolicyDeps.commandSessionGrants}). */
  readonly commandSessionGrants?: boolean;
  /** The directory a command runs in (the session workspace), shown on its card and the anchor of its protected-path check. */
  readonly commandCwd: string;
  /** What the card shortens that directory against (the project and the home); absent ⇒ the card draws it as it is. */
  readonly commandPaths?: DisplayPathRoots;
  /** Where a note for the person goes (a Remember that could not be written). */
  readonly notify?: (message: string) => void;
}

export interface MakeChatModeEnvOptions {
  readonly interactive?: boolean;
  readonly startingModeAuthority?: StartingModeAuthority;
  readonly onToolLiveEvent?: ToolLiveObserver;
  readonly session: Pick<AgentSession, 'setTurnPolicy'>;
  /** The session's granted tool defs (built-ins + discovered MCP) — the governed hide-set is derived from these. */
  readonly tools: readonly ToolDef[];
  /** The session working dir — the anchor a relative preview path is resolved against for the protected check. */
  readonly workspaceDir: string;
  /** What a command's card shortens the workspace directory against (the project and the home). */
  readonly commandPaths?: DisplayPathRoots;
  readonly fsPolicy?: FsPathPolicy;
  /** The REPL's interactive approval prompt. */
  readonly prompt: ApprovalPrompt;
  /** The remembered command grants of this project root (ADR-0118 §2). */
  readonly commandGrants?: CommandGrantsPort;
  /** Whether a command's card offers "this exact command for the session" and "remember it". */
  readonly commandSessionGrants?: boolean;
  /** Where a note for the person goes (a Remember that could not be written). */
  readonly notify?: (message: string) => void;
}

/** Build the session-scoped {@link ChatModeEnv} (pure — no policy is applied until {@link applyChatMode}). */
export function makeChatModeEnv(opts: MakeChatModeEnvOptions): ChatModeEnv {
  return {
    interactive: opts.interactive ?? true,
    ...(opts.startingModeAuthority === undefined
      ? {}
      : { startingModeAuthority: opts.startingModeAuthority }),
    session: opts.session,
    ...(opts.onToolLiveEvent === undefined ? {} : { onToolLiveEvent: opts.onToolLiveEvent }),
    governed: governedToolIds(opts.tools),
    cache: new ApprovalCache(),
    prompt: opts.prompt,
    ...(opts.commandGrants === undefined ? {} : { commandGrants: opts.commandGrants }),
    ...(opts.commandSessionGrants === undefined
      ? {}
      : { commandSessionGrants: opts.commandSessionGrants }),
    commandCwd: opts.workspaceDir,
    ...(opts.commandPaths === undefined ? {} : { commandPaths: opts.commandPaths }),
    ...(opts.notify === undefined ? {} : { notify: opts.notify }),
    // fs_write is the only action class with a path; egress/process have none, so they are never "protected"
    // (auto approves them directly). A relative path resolves against the session workspace — the SAME anchor
    // the fs jail uses — so the classification matches what the fs layer would enforce.
    //
    // Reads `request.unredactedPreview`, NOT `request.preview` (#91): the preview is redacted for display,
    // and a scrub
    // that collapses `./x/.ssh/authorized_keys` would silently reclassify a protected path as unprotected.
    // Precedence: the REAL target first, the display preview only as a fallback for a hand-built request
    // that carries none (a test fixture / surface stub — the engine always sets `target`). Falling back is
    // safe-by-default here because `previewFor` only ever LOSES information: a scrub can turn a protected
    // path into an unprotected-looking one, never the reverse, so the fallback can under-classify but the
    // fs floor still hard-denies the write — while the primary path cannot under-classify at all.
    isProtectedTarget: (request) => {
      const path = request.unredactedPreview?.path ?? request.preview.path;
      return (
        path !== undefined && isProtectedPolicyPath(resolve(opts.workspaceDir, path), opts.fsPolicy)
      );
    },
  };
}

/**
 * Apply a chat mode to the session — map it to a `SessionTurnPolicy` (advertise-filter + the fail-closed
 * confirm hook) and push it via `setTurnPolicy`. Setting ANY policy activates the interactive-approval regime,
 * so a governed dispatch always requires a `confirm` decision (fail-closed). Idempotent; call it on session
 * start (the initial mode) and on every mode change.
 */
export function applyChatMode(
  env: ChatModeEnv,
  requested: ChatMode,
  initial?: ChatModeSelection,
): void {
  const interactive = env.interactive && (env.startingModeAuthority?.interactive ?? true);
  const mode = interactive ? requested : 'ask';
  const selection =
    interactive && initial !== undefined ? initial : env.startingModeAuthority?.explicit(mode);
  if (
    selection !== undefined &&
    (selection.authority !== env.startingModeAuthority || selection.mode !== mode)
  )
    throw new Error('Chat mode selection does not belong to this host.');
  const policy = buildTurnPolicy(mode, {
    governed: env.governed,
    ...(env.onToolLiveEvent === undefined ? {} : { onToolLiveEvent: env.onToolLiveEvent }),
    prompt: env.prompt,
    cache: env.cache,
    isProtectedTarget: env.isProtectedTarget,
    ...(env.commandGrants === undefined ? {} : { commandGrants: env.commandGrants }),
    ...(env.commandSessionGrants === undefined
      ? {}
      : { commandSessionGrants: env.commandSessionGrants }),
    commandCwd: env.commandCwd,
    ...(env.commandPaths === undefined ? {} : { commandPaths: env.commandPaths }),
    ...(env.notify === undefined ? {} : { notify: env.notify }),
    canAsk: interactive, // no TTY / no approver ⇒ the governed tools are hidden, as in plan
  });
  if (selection !== undefined && policy.confirm !== undefined)
    bindStartingModePolicy(policy.confirm, selection);
  env.session.setTurnPolicy(policy);
}
