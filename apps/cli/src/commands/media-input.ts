import { CliError } from '../process/cli-error.js';
import type { CommandInput } from './input.js';
import type { MediaPruneArgs } from './media.js';

export function buildMediaPruneArgs(input: CommandInput): MediaPruneArgs {
  if (
    input.positionals.length !== 0 ||
    input.options['legacyOffline'] !== true ||
    input.options['force'] !== true
  ) {
    throw new CliError(
      'invalid_invocation',
      'Temporary maintenance requires --legacy-offline and --force.',
    );
  }
  return { legacyOffline: true, force: true };
}
