#!/usr/bin/env node
import { escalateExitCode, installBackgroundFailureNet } from './process/background-failure.js';
import { EXIT_CODES } from './process/exit-codes.js';
import { processIo } from './process/io.js';
import { createCliInvocation } from './process/invocation.js';

// Pure bootstrap owners exist before any runtime import can fail. Native adapters land in Step 8.
const io = processIo();
const invocation = createCliInvocation();
const net = installBackgroundFailureNet(io);

try {
  const { run } = await import('./run.js');
  process.exitCode = await run(process.argv, io, undefined, invocation);
} catch {
  // Import/evaluation failures must reach a fixed early sink even when runtime classification cannot load.
  io.writeErr('relavium: a fatal internal error occurred.\n');
  process.exitCode = EXIT_CODES.workflowFailed;
}

if (net.occurred()) escalateExitCode();
