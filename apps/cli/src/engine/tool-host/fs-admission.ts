import { resolve } from 'node:path';

import { CliError } from '../../process/errors.js';
import {
  selectInvocationFsPolicy,
  fsPolicyFloorPaths,
  fsPolicyWorkspace,
  type InvocationFsGrants,
  type FsPathPolicy,
} from './fs-policy.js';
import { isSensitiveReadPath } from './fs.js';

/** Refuse a secret-store workspace before canonical persistence can erase its lexical floor. */
export function assertChatWorkspaceAdmission(workspace: string, policy?: FsPathPolicy): void {
  const paths = [
    resolve(workspace),
    ...(policy === undefined ? [] : fsPolicyFloorPaths(policy, fsPolicyWorkspace(policy))),
  ];
  if (paths.some(isSensitiveReadPath)) {
    throw new CliError(
      'invalid_invocation',
      'Chat cannot use a credential or secret-store directory as its workspace. Choose another workspace.',
    );
  }
}

export { admitFsInvocation } from './fs-invocation-admission.js';

/** A committed selector can narrow authority; it cannot create a grant in any tier. */
export function admitChatFsPolicy(
  grants: InvocationFsGrants,
  workspace: string,
  selectors: readonly string[] | undefined,
): FsPathPolicy {
  let policy: FsPathPolicy;
  try {
    policy = selectInvocationFsPolicy(grants, workspace, selectors);
  } catch {
    throw new CliError(
      'config_error',
      'Chat filesystem roots must select accessible directories within this invocation’s --allow-fs-root grants.',
    );
  }
  assertChatWorkspaceAdmission(workspace, policy);
  return policy;
}
