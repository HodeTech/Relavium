import { dirname, join, resolve } from 'node:path';

import { serializeWorkflow, sessionToWorkflow, type WorkflowDefinition } from '@relavium/core';
import type { SessionStore } from '@relavium/db';
import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import {
  mkdirForStorage,
  writeFileForStorage,
  storageBoundaryError,
} from '../process/owned-storage.js';
import { sourceLabel } from '../process/source-label.js';
import { takenWorkflowIds } from '../workflows/catalog.js';

/**
 * Session → workflow export (2.P / [ADR-0026](../../../../docs/decisions/0026-session-export-to-workflow.md)) —
 * the shared core driving both the `relavium chat-export <sessionId>` command and the in-REPL `/export` slash
 * command. It loads a persisted session, maps it to a `.relavium.yaml` **scaffold** (a linear chain of `agent`
 * nodes + the full transcript under `metadata.relaviumExport`) via the engine's `sessionToWorkflow` (1.Z) +
 * deterministic `serializeWorkflow`, and writes the file. It is **pure of side effects beyond the file write**:
 * it does NOT mark the session row (that is a caller policy — the command marks it `exported`; the live
 * `/export` does not, since a subsequent turn's persist would clobber the marker). Provider credentials are
 * not resolved for this export. The persisted transcript and frozen `agentSnapshot` can still contain
 * sensitive user/assistant text, `@`-attached files, `!`-shell output and authored literals; those strings
 * are retained for the author to review before commit. Strict session loading refuses legacy raw model-tool
 * payloads and provider signatures. This scaffold does not reproduce conversational memory: compaction
 * summaries, trimming and omitted context may not transfer into its executable nodes.
 */

/** Fixed, value-free successful-export notice: interactive transcript or plain/JSON stderr. */
export const SESSION_EXPORT_REVIEW_NOTICE =
  'note: exported workflow is a scaffold; conversation context is not reproduced. Compaction summaries, trimming and omitted context may not transfer. Review retained user/assistant text, @-attached files, !-shell output and authored agent literals before committing. Historical agent snapshots may require edits to pass current validation before running.\n';

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
  const loaded = loadSession(opts.store, opts.sessionId);
  const definition = sessionToWorkflow(loaded.session, loaded.messages);

  // Default the filename to the UNIQUE session id (collision-free), not `workflow.id` (the title-slug, which
  // two untitled sessions share) — the in-file `workflow.id` stays the human-renameable title-slug.
  const path =
    opts.outPath === undefined
      ? join(opts.cwd, `${opts.sessionId}.relavium.yaml`)
      : resolve(opts.cwd, opts.outPath);
  const label = sourceLabel(opts.cwd, path);
  if (writeScaffold(path, serializeWorkflow(definition), opts.force, label) === 'exists') {
    throw new CliError('invalid_invocation', `${label} already exists — pass --force to overwrite`);
  }
  return exportResult(path, definition, loaded);
}

export interface ExportToProjectOptions {
  readonly store: SessionStore;
  readonly sessionId: string;
  /** The launch cwd — the base for display labels, and for `.relavium/` when there is no project. */
  readonly cwd: string;
  /** The discovered `.relavium/` directory; absent ⇒ `<cwd>/.relavium`, created by the write. */
  readonly projectConfigDir: string | undefined;
  /**
   * This session's own earlier export from the same REPL. When it names this session, the export rewrites that
   * file in place and keeps its id, so a second `/export` updates the scaffold rather than adding `-2`.
   */
  readonly previous?: ExportResult;
}

/** How many `-N` ids are tried before the export refuses rather than search on. */
const MAX_EXPORT_ID_ATTEMPTS = 100;

/**
 * The kebab grammar of `workflow.id`. Restated rather than imported because `@relavium/shared` keeps its schema
 * primitives internal; here it is a file-name guard, so a mismatch can only refuse, never widen.
 */
const WORKFLOW_ID_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The in-REPL `/export` (MVP-A3): write the scaffold where workflows live,
 * `<project>/.relavium/workflows/<id>.relavium.yaml`, with the session title's slug as the id, so
 * `relavium run <id>` finds it — never a UUID-named file in the working directory.
 *
 * It never overwrites another workflow. The id is the first of `<slug>`, `<slug>-2`, … that no catalog entry or
 * file stem already holds ({@link takenWorkflowIds}), and the file is created with `wx`, so a file that appears
 * in between is skipped too. The chosen id is written INTO the file as `workflow.id`, keeping the file name and
 * the id one thing. The one overwrite is `previous`: this session's own export from this REPL.
 */
export function exportSessionToProject(opts: ExportToProjectOptions): ExportResult {
  const loaded = loadSession(opts.store, opts.sessionId);
  const scaffold = sessionToWorkflow(loaded.session, loaded.messages);
  const previous = opts.previous?.record.id === opts.sessionId ? opts.previous : undefined;
  if (previous !== undefined) {
    const definition = withWorkflowId(scaffold, previous.workflowId);
    const label = sourceLabel(opts.cwd, previous.path);
    writeScaffold(previous.path, serializeWorkflow(definition), true, label);
    return exportResult(previous.path, definition, loaded);
  }
  const root = opts.projectConfigDir ?? join(opts.cwd, '.relavium');
  const dir = join(root, 'workflows');
  const taken =
    opts.projectConfigDir === undefined
      ? new Set<string>()
      : takenWorkflowIds(opts.projectConfigDir, opts.cwd);
  const base = scaffold.workflow.id;
  for (let attempt = 1; attempt <= MAX_EXPORT_ID_ATTEMPTS; attempt += 1) {
    const id = attempt === 1 ? base : `${base}-${String(attempt)}`;
    if (taken.has(id)) continue;
    // The id becomes a file name: refuse anything that is not a kebab id, whatever the scaffold produced.
    if (!WORKFLOW_ID_GRAMMAR.test(id)) {
      throw new CliError('cli_internal', 'the export produced an unusable workflow id');
    }
    const path = join(dir, `${id}.relavium.yaml`);
    const definition = withWorkflowId(scaffold, id);
    const label = sourceLabel(opts.cwd, path);
    if (writeScaffold(path, serializeWorkflow(definition), false, label) === 'written') {
      return exportResult(path, definition, loaded);
    }
  }
  throw new CliError(
    'invalid_invocation',
    `no free workflow id near '${base}' in the project's workflows/ — export with \`relavium chat-export <sessionId> --out <path>\``,
  );
}

function loadSession(
  store: SessionStore,
  sessionId: string,
): { readonly session: AgentSessionRecord; readonly messages: readonly SessionMessage[] } {
  const loaded = store.loadFull(sessionId);
  if (loaded === undefined) {
    throw new CliError('invalid_invocation', `no session found with id ${sessionId}`);
  }
  return loaded;
}

function withWorkflowId(definition: WorkflowDefinition, id: string): WorkflowDefinition {
  return { ...definition, workflow: { ...definition.workflow, id } };
}

function exportResult(
  path: string,
  definition: WorkflowDefinition,
  loaded: { readonly session: AgentSessionRecord; readonly messages: readonly SessionMessage[] },
): ExportResult {
  // The session is append-only; the next event/seq is one past the durable MAX (a fold, not a spread).
  const sequenceNumber =
    loaded.messages.reduce((max, m) => Math.max(max, m.sequenceNumber), -1) + 1;
  return { path, workflowId: definition.workflow.id, sequenceNumber, record: loaded.session };
}

/**
 * Create the parent directory and write the scaffold. Returns `'exists'` when the target is already there and
 * `force` is off — the caller decides whether that is a refusal or a reason to try the next id. The two steps keep
 * separate catches: a parent that is a file makes `mkdir` fail with `EEXIST` too, and reading that as "the target
 * exists" would send the project export through every candidate id to a misleading refusal.
 */
function writeScaffold(
  path: string,
  yaml: string,
  force: boolean,
  label: string,
): 'written' | 'exists' {
  try {
    // Create the parent directory (so `--out exports/wf.yaml` just works) before writing the scaffold.
    mkdirForStorage(dirname(path));
  } catch (err) {
    const code = exportTargetCode(err);
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new CliError(
        'invalid_invocation',
        `cannot write ${label}: a parent of the target path is not a directory`,
        { cause: err },
      );
    }
    throw storageBoundaryError(err);
  }
  try {
    // Atomic create: `wx` fails with EEXIST if the target already exists — no TOCTOU window between a
    // separate existence check and the write; `w` truncates/overwrites under `force`.
    writeFileForStorage(path, yaml, force);
    return 'written';
  } catch (err) {
    const code = exportTargetCode(err);
    if (code === 'EEXIST') return 'exists';
    // A structurally-invalid target (a directory → EISDIR; a file used as a dir → ENOTDIR) is an INVOCATION
    // fault (exit 2). Other native write faults retain their cause behind a fixed safe diagnostic.
    if (code === 'EISDIR' || code === 'ENOTDIR') {
      throw new CliError(
        'invalid_invocation',
        `cannot write ${label}: the target path is not a file`,
        { cause: err },
      );
    }
    throw storageBoundaryError(err);
  }
}

/** Target-shape refusals are admitted only from the export's actual mkdir/write catch. */
function exportTargetCode(error: unknown): unknown {
  try {
    if (typeof error === 'object' && error !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (descriptor !== undefined && 'value' in descriptor) return descriptor.value;
    }
  } catch {
    // An accessor/proxy is not evidence of a native target refusal.
  }
  return undefined;
}
