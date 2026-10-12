import type { GlobalOptions } from '../../process/options.js';
import { CliError } from '../../process/errors.js';
import {
  admitInvocationFsGrants,
  selectInvocationFsPolicy,
  type InvocationFsGrants,
  type FsPathPolicy,
} from './fs-policy.js';

/** Direct command embeddings use the same pre-composition admission as the argv boundary. */
export function admitFsInvocation(global: GlobalOptions): InvocationFsGrants {
  try {
    return global.fsGrants ?? admitInvocationFsGrants(global.allowFsRoots ?? []);
  } catch {
    throw new CliError(
      'invalid_invocation',
      'Filesystem root grants must name existing absolute directories that can be admitted.',
    );
  }
}

/** A committed selector can narrow authority; it cannot create a grant in any tier. */
export function admitChatFsPolicy(
  grants: InvocationFsGrants,
  workspace: string,
  selectors: readonly string[] | undefined,
): FsPathPolicy {
  try {
    return selectInvocationFsPolicy(grants, workspace, selectors);
  } catch {
    throw new CliError(
      'config_error',
      'Chat filesystem roots must select accessible directories within this invocation’s --allow-fs-root grants.',
    );
  }
}
