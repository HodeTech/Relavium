import { CliError } from '../process/errors.js';
import { Readable } from 'node:stream';

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
  lifecycle?: { readonly signal: AbortSignal; readonly onFailure: (cause: unknown) => void },
): Promise<string> {
  lifecycle?.signal.throwIfAborted();
  let input: StdinSecretSource;
  let isTTY: boolean | undefined;
  try {
    input = source ?? process.stdin;
    isTTY = input.isTTY;
  } catch (cause) {
    throw readFailure(cause);
  }
  if (isTTY === true) throw new CliError('invalid_invocation', context.pipeHint);

  let iterator: AsyncIterator<unknown> | undefined;
  let finished = false;
  const native = input instanceof Readable ? input : undefined;
  const cancelled = new Error('Secret input stopped.');
  let acknowledgeClose: () => void = () => undefined;
  // Iterator return can settle before _destroy acknowledges close, or fail before its cleanup starts.
  // Reserve the actual native-close obligation BEFORE iterator construction/first next.
  const closing =
    native === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          acknowledgeClose = resolve;
        });
  const onClose = (): void => acknowledgeClose();
  // An abort can enter before the iterator installs its own error observer. The iterator still owns
  // read-error classification; this guard only prevents an unobserved cancellation during acquisition.
  const onNativeError = (): void => {};
  let destroyEntered = false;
  let cleanupFailed = false;
  const cleanupFailure = (cause: unknown): void => {
    cleanupFailed = true;
    lifecycle?.onFailure(new CliError('cli_internal', '', { cause }));
  };
  const requestClose = (reason?: Error): void => {
    if (native === undefined || destroyEntered) return;
    destroyEntered = true;
    try {
      native.destroy(reason);
    } catch (cause) {
      cleanupFailure(cause);
    }
  };
  const stop = (): void => requestClose(cancelled);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    try {
      native?.on('error', onNativeError);
      native?.once('close', onClose);
      // Socket.closed can become true BEFORE its actual close delivery. An unobserved preclosed
      // source supplies no receipt; retain uncertainty rather than inventing already-complete ACK.
      if (native?.closed === true) throw new CliError('cli_internal', '');
    } catch (cause) {
      // Destruction is independently attempted in finally even if close-observer acquisition failed.
      cleanupFailure(cause);
      throw readFailure(cause);
    }
    lifecycle?.signal.addEventListener('abort', stop, { once: true });
    if (lifecycle?.signal.aborted === true) stop();
    try {
      lifecycle?.signal.throwIfAborted();
      iterator = input[Symbol.asyncIterator]();
    } catch (cause) {
      if (lifecycle?.signal.aborted === true && cause === lifecycle.signal.reason) throw cause;
      throw readFailure(cause);
    }
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
        if (cause === cancelled) lifecycle?.signal.throwIfAborted();
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
    // Enter native cancellation before awaiting any iterator cleanup; a partial or foreign iterator
    // must not prevent the independent finite destruction request for the consumed pipe.
    requestClose();
    if (!finished && iterator !== undefined) {
      try {
        await iterator.return?.();
      } catch {
        // Best-effort release must not replace the primary refusal with foreign cleanup text.
      }
    }
    // A consumed non-TTY source is never reused as interactive authority. Closing it also covers
    // partial iterator acquisition and early cap refusal, independently of iterator.return's result.
    lifecycle?.signal.removeEventListener('abort', stop);
    await closing;
    for (const [event, callback] of [
      ['close', onClose],
      ['error', onNativeError],
    ] as const) {
      try {
        native?.removeListener(event, callback);
      } catch (cause) {
        cleanupFailure(cause);
      }
    }
    // A failed cleanup step cannot acknowledge retirement. The original invocation's finite exit
    // still bounds the process; neither an iterator return nor a destroy request invents close ACK.
    if (cleanupFailed) await new Promise<never>(() => {});
  }
  lifecycle?.signal.throwIfAborted();
  // Decode once to preserve code points split across Buffer chunks; only callers may trim values.
  const payload = Buffer.concat(chunks, totalBytes).toString('utf8');
  if (payload.trim() === '') throw new CliError('invalid_invocation', context.emptyMessage);
  return payload;
}
