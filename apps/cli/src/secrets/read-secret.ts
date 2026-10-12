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

/** CLI-local source seam: no Node stream type crosses an engine/shared boundary. */
export interface StdinSecretSource extends AsyncIterable<unknown> {
  readonly isTTY?: boolean;
}

const MAX_SECRET_BYTES = 65_536;

function readFailure(cause: unknown): CliError {
  // Even a source-thrown CliError is foreign: never promote its message or stack.
  return new CliError('invalid_invocation', 'could not read secret input from stdin.', { cause });
}

function limitFailure(): CliError {
  return new CliError(
    'invalid_invocation',
    'secret input from stdin exceeds the 65536-byte limit.',
  );
}

export async function readSecretFromStdin(
  context: StdinSecretContext = API_KEY,
  source?: StdinSecretSource,
): Promise<string> {
  let input: StdinSecretSource;
  let isTTY: boolean | undefined;
  try {
    input = source ?? process.stdin;
    isTTY = input.isTTY;
  } catch (cause) {
    throw readFailure(cause);
  }
  if (isTTY === true) throw new CliError('invalid_invocation', context.pipeHint);

  let iterator: AsyncIterator<unknown>;
  try {
    iterator = input[Symbol.asyncIterator]();
  } catch (cause) {
    throw readFailure(cause);
  }
  let finished = false;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let done: boolean | undefined;
      let chunk: unknown;
      let size = 0;
      try {
        const result = await iterator.next();
        if (typeof result !== 'object' || result === null)
          throw new TypeError('invalid iterator result');
        done = result.done;
        if (!done) {
          chunk = result.value;
          // Inspect foreign chunks inside the source fence, including Buffer/proxy getters.
          if (Buffer.isBuffer(chunk)) {
            // Native TypedArray length cannot be forged by Buffer-owned length/byteLength getters.
            const bytes: unknown = Reflect.get(Uint8Array.prototype, 'byteLength', chunk);
            if (typeof bytes !== 'number') throw new TypeError('invalid Buffer byte length');
            size = bytes;
          } else if (typeof chunk === 'string') size = chunk.length;
        }
      } catch (cause) {
        throw readFailure(cause);
      }
      if (done) {
        finished = true;
        break;
      }
      // UTF-8 bytes are at least the string's UTF-16 units: refuse huge strings before a scan.
      const remaining = MAX_SECRET_BYTES - totalBytes;
      if (size > remaining) throw limitFailure();
      if (typeof chunk === 'string') size = Buffer.byteLength(chunk, 'utf8');
      if (size > remaining) throw limitFailure();
      // Every retained chunk consumes capacity; an unlimited empty stream cannot grow this array.
      if (size === 0) continue;
      let owned: Buffer;
      try {
        if (Buffer.isBuffer(chunk)) {
          owned = Buffer.allocUnsafe(size);
          // Native set reads the Buffer's internal bytes, never its iterator/valueOf/index getters.
          Uint8Array.prototype.set.call(owned, chunk);
        } else if (typeof chunk === 'string') owned = Buffer.from(chunk, 'utf8');
        else continue;
      } catch (cause) {
        throw readFailure(cause);
      }
      chunks.push(owned);
      totalBytes += size;
    }
  } finally {
    if (!finished) {
      try {
        await iterator.return?.();
      } catch {
        // Best-effort release must not replace the primary refusal with foreign cleanup text.
      }
    }
  }
  // Decode once to preserve code points split across Buffer chunks; only callers may trim values.
  const payload = Buffer.concat(chunks, totalBytes).toString('utf8');
  if (payload.trim() === '') throw new CliError('invalid_invocation', context.emptyMessage);
  return payload;
}
