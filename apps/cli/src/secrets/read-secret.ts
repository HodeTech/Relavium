import { CliError } from '../process/errors.js';

/**
 * Read a secret (an API key) from **stdin** for `relavium provider set-key` (2.C). The key is deliberately
 * NOT a CLI argument — argv leaks into the process list (`ps`), shell history, and CI logs. Piping keeps it
 * off all of those: `echo "$KEY" | relavium provider set-key anthropic` (or a heredoc).
 *
 * The guard is on **`process.stdin.isTTY`** (the only thing that decides whether the user would type the
 * secret into an echoing terminal) — NOT stdout, so `set-key ... > out.txt` (stdin still a TTY) still errors
 * rather than reading + echoing a typed key. A hidden interactive prompt is a later enhancement (it rides
 * the `@clack/prompts` wizard infra arriving with 2.E).
 */
export async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new CliError(
      'invalid_invocation',
      'pipe the API key on stdin — e.g. `echo "$KEY" | relavium provider set-key <name>` (a key is never passed as an argument).',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    // Narrow without an unsafe cast: an un-encoded stdin stream yields Buffer chunks; a string only if an
    // encoding was set (it never is here). Any other shape is ignored rather than coerced.
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    }
  }
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (key === '') {
    throw new CliError('invalid_invocation', 'no API key was read from stdin (empty input).');
  }
  return key;
}
