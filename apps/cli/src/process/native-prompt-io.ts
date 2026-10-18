import { Readable } from 'node:stream';
import { CliError } from './cli-error.js';
import type { CliIo } from './io.js';

/** Bind actual prompt acquisition to the invocation's captured streams, never later process globals. */
export function nativePromptIo(io: CliIo): {
  readonly input: Readable;
  readonly output: NodeJS.WriteStream;
} {
  const input = io.nativeStdin ?? io.stdin;
  if (io.nativeStdout === undefined || !(input instanceof Readable))
    throw new CliError('cli_internal', '');
  return { input, output: io.nativeStdout };
}
