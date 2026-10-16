import type { GlobalOptions } from '../../process/options.js';
import { CliError } from '../../process/cli-error.js';
import { admitInvocationFsGrants, type InvocationFsGrants } from './fs-policy.js';

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
