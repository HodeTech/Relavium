import type { CliIo } from './process/io.js';

/**
 * Test-only IO capture: a {@link CliIo} whose `writeOut`/`writeErr` accumulate into arrays, so a test
 * can assert on the exact stdout (NDJSON / human lines) and stderr (diagnostics) a command produced.
 * Shared by the command tests and the 2.K regression harness so the capture shape never diverges.
 */
export function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    writeOut: (text) => {
      outChunks.push(text);
    },
    writeErr: (text) => {
      errChunks.push(text);
    },
    env: {},
    stdoutIsTty: false,
  };
  return { io, out: () => outChunks.join(''), err: () => errChunks.join('') };
}
