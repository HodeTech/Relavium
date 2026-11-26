import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  MAX_SOURCE_CHARS,
  readSessionExportMarker,
  serializeWorkflow,
  sessionToWorkflow,
  type WorkflowDefinition,
} from '@relavium/core';
import type { SessionStore } from '@relavium/db';
import type { AgentSessionRecord, SessionMessage } from '@relavium/shared';

import { confineToProjectConfig, isWindowsDeviceName } from '../authoring/authoring.js';
import { CliError } from '../process/errors.js';
import { assertProjectArtifactPath, resolveProjectDirectory } from '../config/project-directory.js';
import {
  mkdirForStorage,
  replaceFileForStorage,
  StorageTargetChangedError,
  storageFileIdentity,
  type StorageFileIdentity,
  writeFileForStorage,
  storageBoundaryError,
} from '../process/owned-storage.js';
import { pinnedDirectoryGuard, type DirectoryGuard } from '../process/forced-write.js';
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

/** What every export says the scaffold is and what to review before committing it: written once, for the notice and the popup. */
const SESSION_EXPORT_REVIEW =
  'exported workflow is a scaffold; conversation context is not reproduced. Compaction summaries, trimming and omitted context may not transfer. Review retained user/assistant text, @-attached files, !-shell output and authored agent literals before committing. Historical agent snapshots may require edits to pass current validation before running.';

/** Fixed, value-free successful-export notice: interactive transcript or plain/JSON stderr. */
export const SESSION_EXPORT_REVIEW_NOTICE = `note: ${SESSION_EXPORT_REVIEW}\n`;

/** The same words as a sentence of their own, as the in-chat `/export` popup shows them above its answer (ADR-0148 §10). */
export const SESSION_EXPORT_REVIEW_SENTENCE = `${SESSION_EXPORT_REVIEW.charAt(0).toUpperCase()}${SESSION_EXPORT_REVIEW.slice(1)}`;

export interface ExportSessionOptions {
  readonly store: SessionStore;
  readonly sessionId: string;
  /** The base dir a relative `outPath` (or the default `<sessionId>.relavium.yaml`) resolves against — the launch cwd. */
  readonly cwd: string;
  /** The operator home the path rules read, handed in by the caller (the command's resolved one): nothing falls back to the process's own. */
  readonly homeDir: string;
  /**
   * `--out <path>` override (absolute, or relative to {@link cwd}); the default is `<sessionId>.relavium.yaml`
   * in cwd — keyed on the UNIQUE session id, not the (possibly shared/absent) title, so two sessions never
   * collide on one path (which `force` would otherwise silently clobber).
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
  // Default the filename to the UNIQUE session id (collision-free), not `workflow.id` (the title-slug, which
  // two untitled sessions share) — the in-file `workflow.id` stays the human-renameable title-slug.
  const path =
    opts.outPath === undefined
      ? join(opts.cwd, `${opts.sessionId}.relavium.yaml`)
      : resolve(opts.cwd, opts.outPath);
  if (opts.outPath === undefined) {
    assertProjectArtifactPath(opts.cwd, opts.homeDir);
    assertProjectArtifactPath(path, opts.homeDir);
  }
  const loaded = loadSession(opts.store, opts.sessionId);
  const definition = sessionToWorkflow(loaded.session, loaded.messages);
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
  /** The operator home the path rules read, handed in by the caller (the session's resolved one): nothing falls back to the process's own. */
  readonly homeDir: string;
  /** The discovered `.relavium/` directory; absent ⇒ `<cwd>/.relavium`, created by the write. */
  readonly projectConfigDir: string | undefined;
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
 * the id one thing.
 *
 * The one overwrite is this session's OWN earlier export, recognized from the file itself rather than from
 * memory: a candidate file whose `metadata.relaviumExport` names this session ({@link ownExport}). So a second
 * `/export` updates the scaffold in place across a `/models` reseat, a `chat-resume` or a Home reopen, and a file
 * that merely sits at an old export's path — the scaffold renamed away and another workflow put there — is never
 * mistaken for it. The rewrite is atomic, and it replaces only the file it recognized: one changed or replaced
 * after the check is left alone, and the export moves on through the same names, rewriting another of this
 * session's own exports there or else taking the next free id.
 *
 * The write is PINNED to the directory the confinement computed: every file operation names the canonical
 * `workflows` directory (`confineToProjectConfig`), not the project's spelling of it, and a guard refuses the write once that
 * directory stops resolving to itself (a link put in its place after the catalog scan). The pin narrows a swap of the directory's
 * name and, on the rewrite, reports what got through (the file may have gone to another directory); it does not close it, as a true
 * pin needs `openat` and `renameat`, which Node lacks (see `forced-write.ts`). The path the result and the labels name stays the
 * project's own spelling.
 */
export function exportSessionToProject(opts: ExportToProjectOptions): ExportResult {
  const { dir, realDir, scaffold, loaded, candidates, taken, base } = planProjectExport(opts);
  // The guard that holds the writes to the canonical directory.
  const guard = pinnedDirectoryGuard(realDir);
  for (const id of candidates) {
    const path = join(dir, `${id}.relavium.yaml`);
    const real = join(realDir, `${id}.relavium.yaml`);
    const own = ownExport(real, opts.sessionId);
    if (own === undefined) continue;
    const definition = withWorkflowId(scaffold, id);
    assertProjectArtifactPath(path, opts.homeDir);
    try {
      replaceFileForStorage(real, serializeWorkflow(definition), own.mode, own.identity, {
        gid: own.gid,
        guard,
      });
    } catch (err) {
      // Changed since it was recognized: no longer known to be ours, so it stays and the export moves on. Its id
      // is in `taken`, so the next loop never writes there either.
      if (err instanceof StorageTargetChangedError) continue;
      throw storageBoundaryError(err);
    }
    return exportResult(path, definition, loaded);
  }
  for (const id of candidates) {
    if (taken.has(id) || isWindowsDeviceName(id)) continue;
    const path = join(dir, `${id}.relavium.yaml`);
    const definition = withWorkflowId(scaffold, id);
    const label = sourceLabel(opts.cwd, path);
    assertProjectArtifactPath(path, opts.homeDir);
    const real = join(realDir, `${id}.relavium.yaml`);
    if (writeScaffold(real, serializeWorkflow(definition), false, label, guard) === 'written') {
      return exportResult(path, definition, loaded);
    }
  }
  throw noFreeWorkflowId(base);
}

/** The refusal when every id near `base` is taken: the write and its preview say it in the same words. */
function noFreeWorkflowId(base: string): CliError {
  return new CliError(
    'invalid_invocation',
    `no free workflow id near '${base}' in the project's workflows/ — rename or move some of those workflow files, then run /export again`,
  );
}

/** What a project export decides before it writes: where, from which scaffold, and which ids are already taken. */
interface ProjectExportPlan {
  /** The `.relavium/` directory the export goes under (absent ⇒ the working directory's, created by the write). */
  readonly root: string;
  /** `<root>/workflows`, as the project spells it: the path the result and the labels name. */
  readonly dir: string;
  /** The canonical `workflows` directory every file operation names. */
  readonly realDir: string;
  readonly scaffold: WorkflowDefinition;
  readonly loaded: {
    readonly session: AgentSessionRecord;
    readonly messages: readonly SessionMessage[];
  };
  readonly base: string;
  /** `<base>`, `<base>-2`, …, in the order they are tried. */
  readonly candidates: readonly string[];
  /** The ids a catalog entry or a file stem already holds. */
  readonly taken: ReadonlySet<string>;
}

/**
 * Everything {@link exportSessionToProject} works out before it writes, in the same order and with the same refusals: the directories, the
 * session and its scaffold, the ids to try and the ids taken. Shared with {@link prepareSessionExport}, so the preview and the write cannot
 * decide differently from the same disk.
 */
function planProjectExport(opts: ExportToProjectOptions): ProjectExportPlan {
  const root = resolveProjectDirectory(opts.cwd, opts.homeDir, opts.projectConfigDir);
  const dir = join(root, 'workflows');
  assertProjectArtifactPath(dir, opts.homeDir);
  const loaded = loadSession(opts.store, opts.sessionId);
  const scaffold = sessionToWorkflow(loaded.session, loaded.messages);
  const base = scaffold.workflow.id;
  const candidates = Array.from({ length: MAX_EXPORT_ID_ATTEMPTS }, (_, index) =>
    index === 0 ? base : `${base}-${String(index + 1)}`,
  );
  // The id becomes a file name: refuse anything that is not a kebab id, whatever the scaffold produced.
  if (!WORKFLOW_ID_GRAMMAR.test(base)) {
    throw new CliError('cli_internal', 'the export produced an unusable workflow id');
  }
  // The catalog scan comes first: it also refuses a workflows directory that resolves outside the project, which
  // the own-export rewrite must not write into either.
  const taken =
    opts.projectConfigDir === undefined
      ? new Set<string>()
      : takenWorkflowIds(opts.projectConfigDir, opts.cwd, opts.homeDir);
  // The canonical directory the writes go through.
  const realDir = dirname(
    confineToProjectConfig(root, join(dir, `${base}.relavium.yaml`), relative(opts.cwd, dir))
      .writeTarget,
  );
  return { root, dir, realDir, scaffold, loaded, base, candidates, taken };
}

/** What an in-chat `/export` would write, worked out and NOT written ({@link prepareSessionExport}). */
export interface SessionExportPreview {
  /** The file, relative to the project's root (`.relavium/workflows/<id>.relavium.yaml`). */
  readonly target: string;
  /** The workflow id the file would hold. */
  readonly workflowId: string;
  /** Whether the write rewrites this session's own earlier export (the one overwrite `/export` makes), or creates a new file. */
  readonly overwrites: boolean;
}

/** `path` relative to the project's root (the directory that holds `root`, the `.relavium/` directory), with `/` between its parts. */
function projectRelativeOf(root: string, path: string): string {
  return relative(dirname(root), path).split(sep).join('/');
}

/** Whether something already sits at `path` (a file, a link, a directory): the write's `wx` would refuse it and move on to the next id. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // Nothing there, or nothing that can be looked at: the write is tried there and says itself what is wrong.
    return false;
  }
}

/**
 * What {@link exportSessionToProject} would write NOW, without writing anything: the file it would create, or this session's own earlier
 * export that it would rewrite (MVP-11 OD-10, ADR-0148 §10: the in-chat `/export` asks first and names its target). The same plan and the
 * same order of candidates as the write: the first candidate that holds this session's own export is rewritten; otherwise the first id no
 * catalog entry, file stem or file already holds is created. It throws what the write would throw before writing (no project directory, an
 * unknown session, no free id). A preview is evidence of the disk at the moment it was taken, so a caller that writes later asks again.
 */
export function prepareSessionExport(opts: ExportToProjectOptions): SessionExportPreview {
  const { root, dir, realDir, candidates, taken, base } = planProjectExport(opts);
  const preview = (id: string, overwrites: boolean): SessionExportPreview => ({
    target: projectRelativeOf(root, join(dir, `${id}.relavium.yaml`)),
    workflowId: id,
    overwrites,
  });
  for (const id of candidates) {
    if (ownExport(join(realDir, `${id}.relavium.yaml`), opts.sessionId) !== undefined)
      return preview(id, true);
  }
  for (const id of candidates) {
    if (taken.has(id) || isWindowsDeviceName(id)) continue;
    if (!occupied(join(realDir, `${id}.relavium.yaml`))) return preview(id, false);
  }
  throw noFreeWorkflowId(base);
}

/** The file an in-chat `/export` wrote, relative to the project's root: what its popup's Done step names. */
export function exportedTarget(opts: ExportToProjectOptions, result: ExportResult): string {
  return projectRelativeOf(
    resolveProjectDirectory(opts.cwd, opts.homeDir, opts.projectConfigDir),
    result.path,
  );
}

/** This session's own earlier export: its permission bits and group, and its identity for the replace to re-check. */
interface OwnExport {
  readonly mode: number;
  /** The group of the file, which the rewrite carries over (or else keeps only the owner's bits). */
  readonly gid: number;
  readonly identity: StorageFileIdentity;
}

/** Read an admitted descriptor within the existing byte ceiling, even if it grows after fstat. */
function readOwnExportBytes(fd: number): Buffer | undefined {
  const maxBytes = MAX_SOURCE_CHARS * 4;
  const buffer = Buffer.alloc(64 * 1024);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    // One extra byte detects overflow without following a growing file to EOF.
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > maxBytes) return undefined;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
}

/**
 * `path` when it holds this session's own earlier export: a regular file — never a link, so a link planted at an
 * export's name is not followed or replaced as if it were ours — within the workflow parser's size bound, whose
 * `metadata.relaviumExport` names `sessionId`. Any doubt (missing, unreadable, swapped between checks, larger than
 * the parser accepts, undecodable) is `undefined`, which only ever means "do not overwrite". The workflow itself is
 * not validated: an export whose stored agent no longer validates is still this session's own.
 */
function ownExport(path: string, sessionId: string): OwnExport | undefined {
  let fd: number | undefined;
  try {
    const linked = lstatSync(path, { bigint: true });
    if (!linked.isFile() || linked.size > BigInt(MAX_SOURCE_CHARS * 4)) return undefined;
    // `O_NOFOLLOW` is absent on Windows; the identity check below is its swap guard there.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino)
      return undefined;
    if (opened.size > BigInt(MAX_SOURCE_CHARS * 4)) return undefined;
    const bytes = readOwnExportBytes(fd);
    if (bytes === undefined) return undefined;
    const text = bytes.toString('utf8');
    // The parser's own bound, in characters, before any YAML is decoded.
    if (text.length > MAX_SOURCE_CHARS) return undefined;
    return readSessionExportMarker(text) === sessionId
      ? {
          mode: Number(opened.mode & 0o777n),
          gid: Number(opened.gid),
          identity: storageFileIdentity(opened, bytes),
        }
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // a close fault changes nothing about the answer
      }
    }
  }
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
  guard?: DirectoryGuard,
): 'written' | 'exists' {
  try {
    guard?.();
    // Create the parent directory (so `--out exports/wf.yaml` just works) before writing the scaffold.
    mkdirForStorage(dirname(path));
    guard?.();
  } catch (err) {
    const code = exportTargetCode(err);
    // ENOENT/ELOOP here mean a dangling or looping link where a directory belongs; `recursive` creates the rest.
    if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'ENOENT' || code === 'ELOOP') {
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
    // separate existence check and the write. Under `force` the target is looked at without being followed and a plain file is replaced
    // through a temporary and a rename (never opened by path with `w`, which follows a link, waits on a FIFO and truncates first); a
    // link, a FIFO or a device is refused in fixed words (review P0-1; the security sitting's M1).
    writeFileForStorage(path, yaml, force, guard);
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
