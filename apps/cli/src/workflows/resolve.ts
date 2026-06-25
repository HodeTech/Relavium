import { readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { MAX_SOURCE_CHARS } from '@relavium/core';

import { CliError } from '../process/errors.js';

/**
 * Pre-read byte ceiling for a workflow source — the core parser's authoritative char cap
 * ({@link MAX_SOURCE_CHARS}), reused (not re-declared) so this guard never desyncs from it. UTF-8
 * bytes ≥ chars, so rejecting a file whose `stat` size exceeds the char cap is conservative and lets
 * us bail BEFORE slurping it into memory; the parser then re-applies the exact char cap (a multibyte
 * file slightly under this byte ceiling may still trip there — the authoritative check).
 */
const MAX_WORKFLOW_BYTES = MAX_SOURCE_CHARS;

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
  opts: { readonly cwd: string; readonly projectConfigDir: string | undefined },
): WorkflowSource {
  return resolveYamlSource(workflowArg, {
    cwd: opts.cwd,
    kind: 'workflow',
    subdir: 'workflows',
    projectConfigDir: opts.projectConfigDir,
    idSuffixes: ['.relavium.yaml', '.yaml'],
  });
}

/**
 * The shared resolver for a bare-id-or-path YAML argument (workflow `<ref>`, agent `--agent <ref>`):
 * a path-like arg (absolute, slash-bearing, or `.yaml`/`.yml`/`.agent.yaml`) reads exactly that file;
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
  },
): WorkflowSource {
  const candidates = candidatePaths(arg, opts);
  for (const candidate of candidates) {
    const yaml = tryRead(candidate, opts.kind);
    if (yaml !== undefined) {
      return { path: candidate, yaml };
    }
  }
  const where = candidates.length > 0 ? candidates.join(', ') : '(no project .relavium/ found)';
  throw new CliError(
    'invalid_invocation',
    `${opts.kind} '${arg}' not found — looked for: ${where}.`,
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
  const looksLikePath =
    isAbsolute(arg) || arg.includes('/') || arg.endsWith('.yaml') || arg.endsWith('.yml');
  if (looksLikePath) {
    return [isAbsolute(arg) ? arg : resolve(opts.cwd, arg)];
  }
  // A bare id/slug → discover under the project subdir (none ⇒ no candidates).
  if (opts.projectConfigDir === undefined) {
    return [];
  }
  const dir = join(opts.projectConfigDir, opts.subdir);
  return opts.idSuffixes.map((suffix) => join(dir, `${arg}${suffix}`));
}

/**
 * Read one candidate, mirroring the 2.B config loader's `statSync`-first discipline (load.ts): a
 * genuine miss (`ENOENT`) returns `undefined` so the next candidate is tried (and the caller reports a
 * clean "not found"), but an existing-but-unreadable file (`EACCES`, a non-regular file, or one over
 * the size cap) is a real fault and throws an exit-2 error — never silently mis-reported as "not
 * found". The size cap is enforced from `stat` before the file is read into memory. `kind` names the
 * artifact in the diagnostic ('workflow' / 'agent').
 */
function tryRead(path: string, kind: string): string | undefined {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return undefined; // this candidate does not exist — try the next
    }
    throw new CliError('invalid_invocation', `${kind} file '${path}' could not be read.`, {
      cause: err,
    });
  }
  if (!stats.isFile()) {
    throw new CliError('invalid_invocation', `${kind} path '${path}' is not a regular file.`);
  }
  if (stats.size > MAX_WORKFLOW_BYTES) {
    throw new CliError(
      'invalid_invocation',
      `${kind} file '${path}' exceeds the ${MAX_WORKFLOW_BYTES}-byte size limit.`,
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError('invalid_invocation', `${kind} file '${path}' could not be read.`, {
      cause: err,
    });
  }
}

/** Narrow an unknown thrown value to its `errno` string code (e.g. `'ENOENT'`), if present. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
