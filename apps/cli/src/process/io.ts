import { CliError } from './errors.js';

/**
 * The CLI's IO seam — injected so the command and process logic is testable with no real
 * TTY, stdout, or environment. The `bin` entry wires this to `process`; tests pass a capture.
 */
export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  /** Acknowledge delivery to the same sink as writeErr; rejection never contains the stream's error text. */
  writeErrAcknowledged(text: string): Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a TTY (`process.stdout.isTTY`). */
  readonly stdoutIsTty: boolean;
  /** Whether stdin is a TTY (`process.stdin.isTTY`) — an interactive prompt (the `create` wizard) needs it to
   *  read keystrokes; a non-TTY stdin (a pipe/redirect) makes `@clack/prompts` fail, so callers guard on it. */
  readonly stdinIsTty: boolean;
  /** Input stream for line-reading surfaces (the plain `chat` loop). Always provided — {@link processIo} wires
   *  `process.stdin`, and `captureIo` supplies an empty stub; `drivePlain` reads it directly with no fallback,
   *  so a miswired test cannot silently read the real `process.stdin`. */
  readonly stdin: NodeJS.ReadableStream;
}

/** The real-process IO seam used by the `bin` entry. */
export function processIo(): CliIo {
  const { stdout, stderr, stdin } = process;
  return {
    writeOut: (text) => {
      stdout.write(text);
    },
    writeErr: (text) => {
      stderr.write(text);
    },
    writeErrAcknowledged: (text) => acknowledgeWrite(stderr, text),
    env: process.env,
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    stdin,
  };
}

const STDERR_FAILED = 'The diagnostic output could not be acknowledged.';

function canWrite(stream: NodeJS.WriteStream): boolean {
  return (
    stream.writable &&
    !stream.destroyed &&
    !stream.writableEnded &&
    !stream.writableFinished &&
    stream.errored === null
  );
}

/** Native write callbacks acknowledge delivery; returning from write() only acknowledges enqueueing. */
function acknowledgeWrite(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let pending = true;
    const release = (): void => {
      stream.removeListener('error', failed);
      stream.removeListener('close', failed);
      stream.removeListener('error', release);
      stream.removeListener('close', release);
    };
    const finish = (success: boolean): void => {
      if (!pending) return;
      pending = false;
      // A native failed write invokes its callback before destruction finishes (a file descriptor can
      // close asynchronously). Keep this owned error sink until error/close; already-finished
      // destruction can still have queued events, which run before the next immediate.
      if (stream.destroyed && !stream.closed) {
        stream.once('error', release);
        stream.once('close', release);
      } else setImmediate(release);
      if (success) resolve();
      else reject(new CliError('internal', STDERR_FAILED));
    };
    const failed = (): void => finish(false);
    stream.on('error', failed);
    stream.on('close', failed);
    if (!canWrite(stream)) {
      finish(false);
      return;
    }
    try {
      stream.write(text, (error) =>
        finish(error === undefined || error === null ? canWrite(stream) : false),
      );
    } catch {
      finish(false);
    }
  });
}
