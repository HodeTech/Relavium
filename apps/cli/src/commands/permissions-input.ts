import { CliError } from '../process/cli-error.js';
import type { CommandInput } from './input.js';
import type { PermissionsRevokeArgs } from './permissions.js';

/** The number `relavium permissions list` prints: a plain decimal from 1, short enough that it cannot be a pasted command. */
const GRANT_NUMBER = /^[1-9][0-9]{0,5}$/u;

/**
 * `permissions revoke <number>` or `permissions revoke --all` — exactly one of them. Validated before any file or keychain is
 * touched (the lazy route calls this first, like the media maintenance builder), and the refusal never echoes what was typed.
 */
export function buildPermissionsRevokeArgs(input: CommandInput): PermissionsRevokeArgs {
  const all = input.options['all'] === true;
  const given = input.positionals[0];
  if (input.positionals.length > 1) {
    throw new CliError('invalid_invocation', 'Give one number from `relavium permissions list`.');
  }
  if (all) {
    if (given !== undefined) {
      throw new CliError('invalid_invocation', 'Give a number or --all, not both.');
    }
    return { all: true };
  }
  if (given === undefined) {
    throw new CliError(
      'invalid_invocation',
      'Give the number of the remembered command to revoke (see `relavium permissions list`), or --all.',
    );
  }
  if (!GRANT_NUMBER.test(given)) {
    throw new CliError(
      'invalid_invocation',
      'The number must be a whole number from 1, as `relavium permissions list` prints it.',
    );
  }
  return { all: false, index: Number(given) };
}
