import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';

/**
 * Read a secret (an API key) from **stdin** for `relavium provider set-key` (2.C). The key is deliberately
 * NOT a CLI argument — argv leaks into the process list (`ps`), shell history, and CI logs. Piping keeps it
 * off all of those: `echo "$KEY" | relavium provider set-key anthropic` (or a heredoc).
 *
 * On a bare TTY (no pipe) it errors with that hint rather than echoing a typed secret; a hidden interactive
 * prompt is a later enhancement (it rides the `@clack/prompts` wizard infra arriving with 2.E).
 */
export async function readSecretFromStdin(io: CliIo): Promise<string> {
  if (io.stdoutIsTty && process.stdin.isTTY) {
    throw new CliError(
      'invalid_invocation',
      'pipe the API key on stdin — e.g. `echo "$KEY" | relavium provider set-key <name>` (a key is never passed as an argument).',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (key === '') {
    throw new CliError('invalid_invocation', 'no API key was read from stdin (empty input).');
  }
  return key;
}
