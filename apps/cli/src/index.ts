import { escalateExitCode, installBackgroundFailureNet } from './process/background-failure.js';
import { EXIT_CODES } from './process/exit-codes.js';
import { processIo } from './process/io.js';
import { run } from './run.js';

// The `bin` entry: wire the real-process IO seam, install the background-failure net, run, and set the
// deterministic exit code.
const io = processIo();

// #228 — installed BEFORE `run()`, so a rejection during startup is caught too. The module doc explains why
// the process survives one rather than dying on it, and why the net is bounded and sanitized.
const net = installBackgroundFailureNet(io);

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

// The mirror of the in-handler upgrade, for a rejection that fired BEFORE `run()` assigned the code and would
// otherwise have been overwritten by it. Same rule: only a clean `0` is escalated.
if (net.occurred()) {
  escalateExitCode();
}
