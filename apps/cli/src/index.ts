import { EXIT_CODES } from './process/exit-codes.js';
import { processIo } from './process/io.js';
import { run } from './run.js';

// The `bin` entry: wire the real-process IO seam, run, and set the deterministic exit code.
const io = processIo();
try {
  process.exitCode = await run(process.argv, io);
} catch (err) {
  // `run()` is designed never to reject; this is a last-resort guard that fails loudly
  // without leaking a stack as primary output. Set `RELAVIUM_DEBUG` to see the stack.
  io.writeErr('relavium: a fatal internal error occurred.\n');
  if (io.env['RELAVIUM_DEBUG'] !== undefined && err instanceof Error && err.stack !== undefined) {
    io.writeErr(`${err.stack}\n`);
  }
  process.exitCode = EXIT_CODES.workflowFailed;
}
