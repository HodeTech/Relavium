/**
 * The CLI's IO seam — injected so the command and process logic is testable with no real
 * TTY, stdout, or environment. The `bin` entry wires this to `process`; tests pass a capture.
 */
export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a TTY (`process.stdout.isTTY`). */
  readonly stdoutIsTty: boolean;
  /** Input stream for line-reading surfaces (the plain `chat` loop). In production this is always `process.stdin`
   *  (set by {@link processIo}); the `?? process.stdin` fallback in `drivePlain` exists only for tests, which
   *  leave it `undefined` (via `captureIo`) and inject a `PassThrough`. */
  readonly stdin?: NodeJS.ReadableStream;
}

/** The real-process IO seam used by the `bin` entry. */
export function processIo(): CliIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    stdoutIsTty: process.stdout.isTTY === true,
    stdin: process.stdin,
  };
}
