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
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    stdin: process.stdin,
  };
}
