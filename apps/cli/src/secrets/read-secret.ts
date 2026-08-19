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
/**
 * What this stdin read is FOR, so the two refusals name the command the user actually ran.
 *
 * `relavium gate --secret-stdin` reuses this reader, and a review measured what a `gate` user was told when
 * they forgot the pipe: "…e.g. `echo \"$KEY\" | relavium provider set-key <name>`" — an unrelated command,
 * for a flag whose own sibling messages are specific. A caller supplies its own two sentences.
 */
export interface StdinSecretContext {
  /** Shown when stdin is a TTY: what to pipe, with a copyable example of THIS command. */
  readonly pipeHint: string;
  /** Shown when stdin was piped but empty. */
  readonly emptyMessage: string;
}

const API_KEY: StdinSecretContext = {
  pipeHint:
    'pipe the API key on stdin — e.g. `echo "$KEY" | relavium provider set-key <name>` (a key is never passed as an argument).',
  emptyMessage: 'no API key was read from stdin (empty input).',
};

export async function readSecretFromStdin(context: StdinSecretContext = API_KEY): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new CliError('invalid_invocation', context.pipeHint);
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
    throw new CliError('invalid_invocation', context.emptyMessage);
  }
  return key;
}
