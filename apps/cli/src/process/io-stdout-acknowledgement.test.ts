import { describe, expect, it } from 'vitest';
import { captureIo, OwnedTtyOutput } from '../test-support.js';
import { processIo } from './io.js';

class HeldOutput extends OwnedTtyOutput {
  acknowledge: (error?: Error) => void = () => undefined;
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.acknowledge = (error) => {
      if (error === undefined)
        this.frames.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback(error);
    };
  }
}
function capturedOutput(stdout: NodeJS.WriteStream) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  if (descriptor === undefined) throw new Error('Expected stdout descriptor.');
  try {
    Object.defineProperty(process, 'stdout', { configurable: true, get: () => stdout });
    return processIo();
  } finally {
    Object.defineProperty(process, 'stdout', descriptor);
  }
}

describe('actual stdout restoration acknowledgement', () => {
  it('waits for the native callback on the originally captured output', async () => {
    const stdout = new HeldOutput();
    const io = capturedOutput(stdout);
    let acknowledged = false;
    try {
      const done = io.writeOutAcknowledged('restore').then(() => {
        acknowledged = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(stdout.frames).toEqual([]);
      stdout.acknowledge();
      await done;
      expect(stdout.frames).toEqual(['restore']);
    } finally {
      stdout.destroy();
    }
  });
  it('rejects a native callback failure with fixed output classification and no copied cause', async () => {
    const stdout = new HeldOutput();
    try {
      const done = capturedOutput(stdout).writeOutAcknowledged('restore');
      const assertion = expect(done).rejects.toMatchObject({
        code: 'output_unavailable',
        exitCode: 9,
      });
      stdout.acknowledge(new Error('PRIVATE_STDOUT_CAUSE'));
      await assertion;
      expect(stdout.frames).toEqual([]);
    } finally {
      stdout.destroy();
    }
  });
  it('acknowledges the same memory sink in captureIo', async () => {
    const captured = captureIo();
    captured.io.writeOut('before:');
    await captured.io.writeOutAcknowledged('restore');
    expect(captured.out()).toBe('before:restore');
    expect(captured.err()).toBe('');
  });
});
