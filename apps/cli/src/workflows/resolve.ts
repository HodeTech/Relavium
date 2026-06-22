import { readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { CliError } from '../process/errors.js';

/**
 * Pre-read byte cap for a workflow source, mirroring the core parser's `MAX_SOURCE_CHARS` (2 MiB).
 * Bytes ≥ chars, so this is a conservative guard that rejects an oversize file from `stat` BEFORE it
 * is slurped into memory — the parser re-applies the exact char cap. (A multibyte file slightly under
 * this byte cap may still trip the parser's char cap; that's the authoritative check.)
 */
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;

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
  const candidates = workflowCandidatePaths(workflowArg, opts);
  for (const candidate of candidates) {
    const yaml = tryRead(candidate);
    if (yaml !== undefined) {
      return { path: candidate, yaml };
    }
  }
  const where = candidates.length > 0 ? candidates.join(', ') : '(no project .relavium/ found)';
  throw new CliError(
    'invalid_invocation',
    `workflow '${workflowArg}' not found — looked for: ${where}.`,
  );
}

function workflowCandidatePaths(
  workflowArg: string,
  opts: { readonly cwd: string; readonly projectConfigDir: string | undefined },
): string[] {
  const looksLikePath =
    isAbsolute(workflowArg) ||
    workflowArg.includes('/') ||
    workflowArg.endsWith('.yaml') ||
    workflowArg.endsWith('.yml');
  if (looksLikePath) {
    return [isAbsolute(workflowArg) ? workflowArg : resolve(opts.cwd, workflowArg)];
  }
  // A bare id/slug → discover under the project workflows directory (none ⇒ no candidates).
  if (opts.projectConfigDir === undefined) {
    return [];
  }
  const dir = join(opts.projectConfigDir, 'workflows');
  return [join(dir, `${workflowArg}.relavium.yaml`), join(dir, `${workflowArg}.yaml`)];
}

/**
 * Read one candidate, mirroring the 2.B config loader's `statSync`-first discipline (load.ts): a
 * genuine miss (`ENOENT`) returns `undefined` so the next candidate is tried (and the caller reports a
 * clean "not found"), but an existing-but-unreadable file (`EACCES`, a non-regular file, or one over
 * the size cap) is a real fault and throws an exit-2 error — never silently mis-reported as "not
 * found". The size cap is enforced from `stat` before the file is read into memory.
 */
function tryRead(path: string): string | undefined {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return undefined; // this candidate does not exist — try the next
    }
    throw new CliError('invalid_invocation', `workflow file '${path}' could not be read.`, {
      cause: err,
    });
  }
  if (!stats.isFile()) {
    throw new CliError('invalid_invocation', `workflow path '${path}' is not a regular file.`);
  }
  if (stats.size > MAX_WORKFLOW_BYTES) {
    throw new CliError(
      'invalid_invocation',
      `workflow file '${path}' exceeds the ${MAX_WORKFLOW_BYTES}-byte size limit.`,
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError('invalid_invocation', `workflow file '${path}' could not be read.`, {
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
