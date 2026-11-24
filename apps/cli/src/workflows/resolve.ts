import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { MAX_SOURCE_CHARS } from '@relavium/core';

import { CliError } from '../process/errors.js';
import { sourceLabel } from '../process/source-label.js';
import { assertProjectArtifactPath } from '../config/project-directory.js';

/** UTF-8 uses at most four bytes per source character. Match the sibling catalog precheck;
 *  the pure parser remains authoritative for the character ceiling after decoding. */
const MAX_YAML_SOURCE_BYTES = MAX_SOURCE_CHARS * 4;

/** The refusal of a bare id from a surface that holds no operator home: a fixed sentence, no path. */
export const BARE_ID_WITHOUT_HOME =
  'A bare id cannot be resolved without the operator home; name the file.';

export interface WorkflowSource {
  /** The absolute path the YAML was read from (also the parse-error label, made cwd-relative). */
  readonly path: string;
  readonly yaml: string;
}

/**
 * Resolve the `<workflow>` argument to its YAML source: an explicit `.relavium.yaml` path, or a
 * workflow id/slug discovered under the project `<projectConfigDir>/workflows/`. The file is read
 * here (the host owns IO); `parseWorkflow` stays pure. A miss is a clean exit-2 invocation error
 * listing where it looked.
 */
export function resolveWorkflowSource(
  workflowArg: string,
  opts: {
    readonly cwd: string;
    readonly projectConfigDir: string | undefined;
    readonly homeDir: string;
  },
): WorkflowSource {
  return resolveYamlSource(workflowArg, {
    cwd: opts.cwd,
    kind: 'workflow',
    subdir: 'workflows',
    projectConfigDir: opts.projectConfigDir,
    idSuffixes: ['.relavium.yaml', '.yaml'],
    homeDir: opts.homeDir,
  });
}

/**
 * The shared resolver for a bare-id-or-path YAML argument (workflow `<ref>`, agent `--agent <ref>`):
 * a path-like arg (absolute, slash-bearing, or ending in `.yaml`/`.yml` — which subsumes `.agent.yaml`)
 * reads exactly that file;
 * a bare id/slug discovers `<projectConfigDir>/<subdir>/<id><suffix>` for each `idSuffixes` entry. The
 * host owns IO; the pure parser runs on the returned `yaml`. A miss is a clean exit-2 listing where it
 * looked, keyed on `kind` so the message names the right artifact.
 */
export function resolveYamlSource(
  arg: string,
  opts: {
    readonly cwd: string;
    readonly kind: string;
    readonly subdir: string;
    readonly projectConfigDir: string | undefined;
    readonly idSuffixes: readonly string[];
    /**
     * The operator home a bare id is admitted against. The key is required and never defaulted: a caller states the home it
     * already resolved, or `undefined` when it holds none (a hermetic embedding), in which case a bare id is refused rather than
     * judged by the process's real home. An explicit file path is never admitted against the home, so it reads either way.
     */
    readonly homeDir: string | undefined;
  },
): WorkflowSource {
  const candidates = candidatePaths(arg, opts);
  for (const candidate of candidates) {
    if (!explicitYamlPath(arg)) {
      if (opts.homeDir === undefined) throw new CliError('internal', BARE_ID_WITHOUT_HOME);
      assertProjectArtifactPath(candidate, opts.homeDir);
    }
    const yaml = tryRead(candidate, opts.kind, opts.cwd);
    if (yaml !== undefined) {
      return { path: candidate, yaml };
    }
  }
  const where =
    candidates.length > 0
      ? candidates.map((path) => sourceLabel(opts.cwd, path)).join(', ')
      : '(no project .relavium/ found)';
  throw new CliError(
    'invalid_invocation',
    `${opts.kind} '${sourceLabel(opts.cwd, resolve(opts.cwd, arg))}' not found — looked for: ${where}.`,
  );
}

function candidatePaths(
  arg: string,
  opts: {
    readonly cwd: string;
    readonly subdir: string;
    readonly projectConfigDir: string | undefined;
    readonly idSuffixes: readonly string[];
  },
): string[] {
  // A POSIX `/`, the platform separator (`\` on Windows, where `agents\coder` is a relative path), an
  // absolute path, or a `.yaml`/`.yml` suffix all mark an explicit file reference rather than a bare id/slug.
  // NOTE: the `arg.includes(sep)` arm is the Windows-only path — on POSIX `sep === '/'`, so it is a no-op
  // there and cannot be exercised by the POSIX CI (asserting it would require stubbing `path.sep`).
  if (explicitYamlPath(arg)) {
    return [isAbsolute(arg) ? arg : resolve(opts.cwd, arg)];
  }
  // A bare id/slug → discover under the project subdir (none ⇒ no candidates).
  if (opts.projectConfigDir === undefined) {
    return [];
  }
  const dir = join(opts.projectConfigDir, opts.subdir);
  return opts.idSuffixes.map((suffix) => join(dir, `${arg}${suffix}`));
}

function explicitYamlPath(arg: string): boolean {
  return (
    isAbsolute(arg) ||
    arg.includes('/') ||
    arg.includes(sep) ||
    arg.endsWith('.yaml') ||
    arg.endsWith('.yml')
  );
}

/**
 * Read one candidate, in the 2.B config loader's order (load.ts): the path is STATTED FIRST (following a link, as an explicit path always
 * has been), and a genuine miss (`ENOENT`) returns `undefined` so the next candidate is tried (and the caller reports a clean "not
 * found"), but an existing-but-unreadable file (`EACCES`, a non-regular file, or one over the size cap) is a real fault and throws an
 * exit-2 error — never silently mis-reported as "not found". What is not a regular file, or is over the size cap, is refused without being
 * opened. A regular file is opened ONCE (`O_NONBLOCK`, `O_NOCTTY`) and every later question and the read itself are asked of the
 * DESCRIPTOR, never of the path again: a `stat` then a `readFileSync` by path let a same-directory owner rename a FIFO over the file between
 * them (the read then blocks `run` with no deadline) or a larger file (the cap was checked on the old one). The descriptor must name the
 * same file (device and inode) as the `stat`, its size is checked again, and the bytes are read in bounded chunks, so a file that grew is
 * refused as one that was over the cap. `kind` names the artifact in the diagnostic ('workflow' / 'agent').
 */
function tryRead(path: string, kind: string, cwd: string): string | undefined {
  const label = sourceLabel(cwd, path);
  const unreadable = (cause?: unknown): CliError =>
    new CliError('invalid_invocation', `${kind} file '${label}' could not be read.`, {
      ...(cause === undefined ? {} : { cause }),
    });
  const tooLarge = (): CliError =>
    new CliError(
      'invalid_invocation',
      `${kind} file '${label}' exceeds the ${MAX_YAML_SOURCE_BYTES}-byte size limit.`,
    );
  let admitted: BigIntStats;
  try {
    admitted = statSync(path, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return undefined; // this candidate does not exist — try the next
    }
    throw unreadable(err);
  }
  if (!admitted.isFile()) {
    throw new CliError('invalid_invocation', `${kind} path '${label}' is not a regular file.`);
  }
  if (admitted.size > BigInt(MAX_YAML_SOURCE_BYTES)) throw tooLarge();
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0),
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== admitted.dev || opened.ino !== admitted.ino) {
      throw unreadable(); // not the file that was statted: swapped in between, and nothing of it is read
    }
    if (opened.size > BigInt(MAX_YAML_SOURCE_BYTES)) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_YAML_SOURCE_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_YAML_SOURCE_BYTES) throw tooLarge();
      chunks.push(chunk.subarray(0, count));
    }
    bytes = Buffer.concat(chunks, total);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw unreadable(err);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A read-only descriptor that fails to close has nothing left to lose.
      }
    }
  }
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    // A lenient decode turns each malformed sequence into U+FFFD, so the run would start on a prompt that is not the one in the file
    // (review P05-2; the catalog and the authoring read refuse the same bytes).
    throw new CliError('invalid_invocation', `${kind} file '${label}' is not valid UTF-8.`);
  }
}

/** UTF-8 that refuses malformed input instead of repairing it; `ignoreBOM` keeps a leading U+FEFF in the text, as the lenient decode did. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Narrow an unknown thrown value to its `errno` string code (e.g. `'ENOENT'`), if present. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
