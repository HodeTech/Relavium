import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { CliError } from '../process/errors.js';

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

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Not found / unreadable → this candidate does not exist; try the next (a real miss is reported above).
    return undefined;
  }
}
