import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { serializeWorkflow, sessionToWorkflow } from '@relavium/core';
import type { SessionStore } from '@relavium/db';
import type { AgentSessionRecord } from '@relavium/shared';

import { CliError } from '../process/errors.js';

/**
 * Session → workflow export (2.P / [ADR-0026](../../../../docs/decisions/0026-session-export-to-workflow.md)) —
 * the shared core driving both the `relavium chat-export <sessionId>` command and the in-REPL `/export` slash
 * command. It loads a persisted session, maps it to a `.relavium.yaml` **scaffold** (a linear chain of `agent`
 * nodes + the full transcript under `metadata.relaviumExport`) via the engine's `sessionToWorkflow` (1.Z) +
 * deterministic `serializeWorkflow`, and writes the file. It is **pure of side effects beyond the file write**:
 * it does NOT mark the session row (that is a caller policy — the command marks it `exported`; the live
 * `/export` does not, since a subsequent turn's persist would clobber the marker). No **Relavium-managed**
 * secret can appear: API keys live in the OS keychain and never enter a `SessionMessage`, and the frozen
 * `agentSnapshot` carries only a `{{secrets.*}}` placeholder, never a resolved key ([ADR-0006](../../../../docs/decisions/0006-os-keychain-for-api-keys.md)/[ADR-0029](../../../../docs/decisions/0029-tool-policy-hardening.md)).
 * The user's own conversational content is preserved **verbatim** (as `prompt_template` text + the full
 * transcript under `metadata.relaviumExport`) — that is the author's data to review before commit, by design.
 */

export interface ExportSessionOptions {
  readonly store: SessionStore;
  readonly sessionId: string;
  /** The base dir a relative `outPath` (or the default `<sessionId>.relavium.yaml`) resolves against — the launch cwd. */
  readonly cwd: string;
  /**
   * `--out <path>` override (absolute, or relative to {@link cwd}); the default is `<sessionId>.relavium.yaml`
   * in cwd — keyed on the UNIQUE session id, not the (possibly shared/absent) title, so two sessions never
   * collide on one path (which the in-REPL `/export`'s `force` would otherwise silently clobber).
   */
  readonly outPath?: string;
  /** Overwrite an existing file at the target path; without it an existing file is a clean exit-2 fault. */
  readonly force: boolean;
}

export interface ExportResult {
  /** The absolute path the scaffold was written to. */
  readonly path: string;
  /** The scaffold workflow id (a deterministic kebab slug of the session title). */
  readonly workflowId: string;
  /** The next session `sequenceNumber` past the transcript — the `session:exported` event's seq. */
  readonly sequenceNumber: number;
  /** The loaded session record, so a caller can mark it `exported` without a second load. */
  readonly record: AgentSessionRecord;
}

/**
 * Load a persisted session and write its `.relavium.yaml` scaffold. An unknown `sessionId` is a clean exit-2
 * invocation fault; an existing target file without `force` is exit 2 (never a silent overwrite). Returns the
 * written path + the loaded record (for an optional row-marking by the caller).
 */
export function exportSession(opts: ExportSessionOptions): ExportResult {
  const loaded = opts.store.loadFull(opts.sessionId);
  if (loaded === undefined) {
    throw new CliError('invalid_invocation', `no session found with id ${opts.sessionId}`);
  }

  const definition = sessionToWorkflow(loaded.session, loaded.messages);
  const yaml = serializeWorkflow(definition);

  // Default the filename to the UNIQUE session id (collision-free), not `workflow.id` (the title-slug, which
  // two untitled sessions share) — the in-file `workflow.id` stays the human-renameable title-slug.
  const path =
    opts.outPath === undefined
      ? join(opts.cwd, `${opts.sessionId}.relavium.yaml`)
      : resolve(opts.cwd, opts.outPath);
  if (!opts.force && existsSync(path)) {
    throw new CliError('invalid_invocation', `${path} already exists — pass --force to overwrite`);
  }
  // Create the parent directory (so `--out exports/wf.yaml` just works) before writing the scaffold.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, 'utf8');

  // The session is append-only; the next event/seq is one past the durable MAX (a fold, not a spread).
  const sequenceNumber =
    loaded.messages.reduce((max, m) => (m.sequenceNumber > max ? m.sequenceNumber : max), -1) + 1;
  return { path, workflowId: definition.workflow.id, sequenceNumber, record: loaded.session };
}
