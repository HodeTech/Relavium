import { CliError } from './cli-error.js';

export type Verbosity = 'quiet' | 'normal' | 'verbose';

export interface DiagnosticPolicy {
  readonly json: boolean;
  readonly verbosity: Verbosity;
}

export type OutputCategory =
  | 'requested'
  | 'safety'
  | 'decoration'
  | 'notice'
  | 'compatibility'
  | 'detail';

/** Representation and verbosity are independent of TTY/CI. No service or ambient environment access. */
export function resolveDiagnosticPolicy(
  flags: { readonly json?: boolean; readonly quiet?: boolean; readonly verbose?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): DiagnosticPolicy {
  if (flags.quiet === true && flags.verbose === true) {
    throw new CliError('invalid_invocation', '`--verbose` and `--quiet` cannot be combined.');
  }
  return Object.freeze({
    json: flags.json === true,
    verbosity:
      flags.quiet === true
        ? 'quiet'
        : flags.verbose === true || env['RELAVIUM_DEBUG'] === '1'
          ? 'verbose'
          : 'normal',
  });
}

/** Apply at semantic output owners, never as a blanket IO filter or implicit approval. */
export function shouldEmitCategory(policy: DiagnosticPolicy, category: OutputCategory): boolean {
  switch (category) {
    case 'requested':
    case 'safety':
    case 'compatibility':
      return true;
    case 'detail':
      return policy.verbosity === 'verbose';
    case 'decoration':
      return !policy.json && policy.verbosity !== 'quiet';
    case 'notice':
      return policy.verbosity !== 'quiet';
  }
}
