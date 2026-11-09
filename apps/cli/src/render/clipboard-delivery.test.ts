import { afterEach, describe, expect, it } from 'vitest';

import { SessionControlWrites } from '../chat/session-control-writes.js';
import { processIo } from '../process/io.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { OwnedTtyOutput } from '../test-support.js';
import { attemptClipboardWrite, copyToClipboard } from './clipboard.js';

class DelayedOutput extends OwnedTtyOutput {
  complete: ((error?: Error) => void) | undefined;
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : typeof chunk === 'string'
        ? chunk
        : '';
    this.complete = (error) => {
      this.complete = undefined;
      if (error === undefined) this.frames.push(text);
      callback(error);
    };
  }
}

const outputs: DelayedOutput[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) output.destroy();
});

/** Capture a real typed native output exactly as the CLI does, without an unsafe stream cast. */
function fixture() {
  const output = new DelayedOutput();
  outputs.push(output);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  if (descriptor === undefined) throw new Error('stdout descriptor missing');
  let io: ReturnType<typeof processIo>;
  try {
    Object.defineProperty(process, 'stdout', { configurable: true, get: () => output });
    io = processIo();
  } finally {
    Object.defineProperty(process, 'stdout', descriptor);
  }
  const control = invocationFixture();
  const failures: unknown[] = [];
  const writes = new SessionControlWrites({
    invocation: control.invocation,
    write: (text) => io.writeOutAcknowledged(text),
    failure: (cause) => {
      failures.push(cause);
    },
  });
  return { output, writes, failures };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('clipboard local delivery acknowledgement', () => {
  it.each([false, true])(
    'waits for the real native callback and retains its failure observer (failed=%s)',
    async (failed) => {
      const { output, writes, failures } = fixture();
      let settled = false;
      const result = attemptClipboardWrite(
        (text) => copyToClipboard({ writeControl: writes.write, env: {} }, text),
        'text',
      ).then((outcome) => {
        settled = true;
        return outcome;
      });
      await flush();
      expect(output.complete).toBeTypeOf('function');
      expect(settled).toBe(false);
      expect(output.frames).toEqual([]);
      output.complete?.(failed ? new Error('OPAQUE_NATIVE_CLIPBOARD_FAILURE') : undefined);
      const outcome = await result;
      expect(outcome).toEqual(failed ? { kind: 'failed' } : { kind: 'written', characters: 4 });
      if (failed) {
        expect(failures).toMatchObject([{ code: 'output_unavailable', exitCode: 9 }]);
        expect(output.frames).toEqual([]);
        expect(JSON.stringify(outcome)).not.toContain('OPAQUE');
      } else {
        expect(failures).toEqual([]);
        expect(output.frames).toHaveLength(1);
        expect(output.frames[0]).toContain(']52;c;');
      }
      await writes.close();
    },
  );
});
