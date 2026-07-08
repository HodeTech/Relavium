import { resolve } from 'node:path';

import type { AgentSession, ToolActionPreview, ToolDef } from '@relavium/core';

import { isProtectedPath } from '../engine/tool-host/fs.js';
import {
  ApprovalCache,
  buildTurnPolicy,
  governedToolIds,
  type ApprovalPrompt,
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
 * the caller applies the initial (ask) mode via {@link applyChatMode}, so nothing here has a live effect until
 * the REPL wires it (keeping the pre-wire state safe).
 */

/** The session-scoped environment a mode is applied against — built once per session. */
export interface ChatModeEnv {
  /** The live session the mapped turn policy is pushed to. */
  readonly session: Pick<AgentSession, 'setTurnPolicy'>;
  /** Governed tool ids (the ask/plan advertise hide-set) — derived once from the session's granted defs. */
  readonly governed: ReadonlySet<string>;
  /** The session once/always memory (shared across mode changes — an "always" persists until the session ends). */
  readonly cache: ApprovalCache;
  /** The REPL's interactive `[y] yes / [a] always / [n] no / [c] reason / [esc] abort` prompt (accept-edits, and
   *  auto's protected-path fallback). `[c]` opens the typed-reason capture (Step 14 — a reject carrying WHY). */
  readonly prompt: ApprovalPrompt;
  /** Whether an approval preview targets a protected path — `auto` then falls back to a prompt (ADR-0057). */
  readonly isProtectedTarget: (preview: ToolActionPreview) => boolean;
}

export interface MakeChatModeEnvOptions {
  readonly session: Pick<AgentSession, 'setTurnPolicy'>;
  /** The session's granted tool defs (built-ins + discovered MCP) — the governed hide-set is derived from these. */
  readonly tools: readonly ToolDef[];
  /** The session working dir — the anchor a relative preview path is resolved against for the protected check. */
  readonly workspaceDir: string;
  /** The REPL's interactive approval prompt. */
  readonly prompt: ApprovalPrompt;
}

/** Build the session-scoped {@link ChatModeEnv} (pure — no policy is applied until {@link applyChatMode}). */
export function makeChatModeEnv(opts: MakeChatModeEnvOptions): ChatModeEnv {
  return {
    session: opts.session,
    governed: governedToolIds(opts.tools),
    cache: new ApprovalCache(),
    prompt: opts.prompt,
    // fs_write is the only preview class with a path; egress/process have none, so they are never "protected"
    // (auto approves them directly). A relative path resolves against the session workspace — the SAME anchor
    // the fs jail uses — so the classification matches what the fs layer would enforce.
    isProtectedTarget: (preview) =>
      preview.path !== undefined && isProtectedPath(resolve(opts.workspaceDir, preview.path)),
  };
}

/**
 * Apply a chat mode to the session — map it to a `SessionTurnPolicy` (advertise-filter + the fail-closed
 * confirm hook) and push it via `setTurnPolicy`. Setting ANY policy activates the interactive-approval regime,
 * so a governed dispatch always requires a `confirm` decision (fail-closed). Idempotent; call it on session
 * start (the initial mode) and on every mode change.
 */
export function applyChatMode(env: ChatModeEnv, mode: ChatMode): void {
  env.session.setTurnPolicy(
    buildTurnPolicy(mode, {
      governed: env.governed,
      prompt: env.prompt,
      cache: env.cache,
      isProtectedTarget: env.isProtectedTarget,
    }),
  );
}
