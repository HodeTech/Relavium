import { describe, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { SHOW_CURSOR } from '../render/alt-screen.js';
import { WorkflowTerminal, type RendererCreationOwner } from './workflow-terminal.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(tty = false) {
  const registry = new InvocationRegistry({ now: () => 0, schedule: () => () => undefined });
  const { io, out } = captureIo();
  const fail = vi.fn();
  const terminal = new WorkflowTerminal(
    registry,
    { ...io, stdoutIsTty: tty },
    () => undefined,
    fail,
  );
  return { registry, io, out, fail, terminal };
}

describe('reserved workflow terminal creation and actual restoration', () => {
  it.each([true, false])(
    'refuses sealed view operation entry; mayAcquire=%s',
    async (mayAcquire) => {
      const f = fixture();
      f.terminal.seal();
      const operation = vi.fn(() => Promise.resolve());
      let failure: unknown;
      try {
        void f.terminal.runViewOperation(operation, mayAcquire);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ code: 'cli_internal' });
      expect(operation).not.toHaveBeenCalled();
      await f.terminal.finish();
      expect(f.registry.activeOwners).toBe(0);
    },
  );

  it('retires a native-free preparation without writing cursor codes to NDJSON output', async () => {
    const f = fixture();
    expect(f.registry.activeOwners).toBe(1);
    await f.terminal.finish();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.out()).toBe('');
  });
  it('starts all restoration attempts while the prompt and native view are independently held', async () => {
    const registry = new InvocationRegistry({ now: () => 0, schedule: () => () => undefined });
    const captured = captureIo();
    const writes: string[] = [];
    const acknowledgements: (() => void)[] = [];
    const prompt = deferred<boolean>();
    const input = deferred<void>();
    const release = vi.fn(() => input.promise);
    const terminal = new WorkflowTerminal(
      registry,
      {
        ...captured.io,
        stdoutIsTty: true,
        writeOutAcknowledged: (text) => {
          writes.push(text);
          const ack = deferred<void>();
          acknowledgements.push(() => ack.resolve());
          return ack.promise;
        },
      },
      () => undefined,
      vi.fn(),
    );
    const prompted = terminal.runPrompt(() => prompt.promise);
    const dispose = vi.fn();
    terminal.createJobControl(() => ({ dispose }));
    const seal = vi.fn();
    terminal.createRenderer(() => ({ onEvent: () => undefined, seal, releaseInput: release }));
    let finished = false;
    const done = terminal.finish().then(() => {
      finished = true;
    });
    await turn();
    expect(seal).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(writes).toEqual([SHOW_CURSOR]);
    expect(finished).toBe(false);
    acknowledgements[0]?.();
    prompt.resolve(true);
    await prompted;
    await turn();
    expect(writes).toHaveLength(1); // The held Ink owner can still hide the cursor.
    input.resolve();
    await turn();
    expect(writes).toEqual([SHOW_CURSOR, SHOW_CURSOR]);
    expect(finished).toBe(false);
    expect(registry.activeOwners).toBe(1);
    acknowledgements[1]?.();
    await done;
    expect(registry.activeOwners).toBe(0);
  });
  it('reserves a prompt before synchronous reentry and never treats its rejection as release', async () => {
    const f = fixture();
    const cause = new Error('PRIVATE_PROMPT_CAUSE');
    let finished = false;
    const prompted = f.terminal.runPrompt(() => {
      void f.terminal.finish().then(() => {
        finished = true;
      });
      throw cause;
    });
    await expect(prompted).rejects.toBe(cause);
    await turn();
    expect(finished).toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    expect(f.fail).toHaveBeenCalledWith(cause, true);
  });
  it('adopts late job-control return after a reentrant seal and disposes it before retirement', async () => {
    const f = fixture();
    const dispose = vi.fn(() => f.terminal.seal());
    f.terminal.createJobControl(() => {
      f.terminal.seal();
      return { dispose };
    });
    await f.terminal.finish();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });
  it.each([false, true])(
    'construction throw requires its own native-free declaration (%s)',
    async (declared) => {
      const f = fixture();
      expect(() =>
        f.terminal.createRenderer((creation) => {
          if (declared) creation.acknowledgeNoAcquisition();
          throw new Error('PRIVATE_CONSTRUCTOR_CAUSE');
        }),
      ).toThrow('PRIVATE_CONSTRUCTOR_CAUSE');
      let finished = false;
      void f.terminal.finish().then(() => {
        finished = true;
      });
      await turn();
      expect(finished).toBe(declared);
      expect(f.registry.activeOwners).toBe(declared ? 0 : 1);
    },
  );
  it('pre-adopts actual constructor rollback and waits for its positive input ACK after throwing', async () => {
    const f = fixture();
    const released = deferred<void>();
    const releaseInput = vi.fn(() => released.promise);
    const seal = vi.fn();
    expect(() =>
      f.terminal.createRenderer((creation: RendererCreationOwner) => {
        creation.adopt({ seal, releaseInput });
        throw new Error('construction failed after acquisition');
      }),
    ).toThrow();
    let finished = false;
    const done = f.terminal.finish().then(() => {
      finished = true;
    });
    await turn();
    expect(seal).toHaveBeenCalledOnce();
    expect(releaseInput).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    released.resolve();
    await done;
    expect(f.registry.activeOwners).toBe(0);
  });
  it('permanently refuses new terminal entry after seal', async () => {
    const f = fixture();
    f.terminal.seal();
    const prompt = vi.fn(() => Promise.resolve(true));
    const renderer = vi.fn(() => ({ onEvent: () => undefined }));
    const job = vi.fn(() => ({ dispose: () => undefined }));
    expect(() => f.terminal.runPrompt(prompt)).toThrow();
    expect(() => f.terminal.createRenderer(renderer)).toThrow();
    expect(() => f.terminal.createJobControl(job)).toThrow();
    expect(prompt).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
    expect(job).not.toHaveBeenCalled();
    await f.terminal.finish();
  });

  it('keeps custody of a view with native-free construction and a later input acquisition', async () => {
    const f = fixture(true);
    const input = deferred<void>();
    const releaseInput = vi.fn(() => input.promise);
    const resume = vi.fn(() => undefined);
    const renderer = f.terminal.createRenderer((creation) => {
      creation.acknowledgeNoAcquisition();
      return { onEvent: () => undefined, releaseInput, resume };
    });
    await f.terminal.runViewOperation(() => renderer.resume?.());
    let finished = false;
    const done = f.terminal.finish().then(() => {
      finished = true;
    });
    await turn();
    expect(resume).toHaveBeenCalledOnce();
    expect(releaseInput).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    input.resolve();
    await done;
    expect(finished).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
  });

  it.each(['deferred-entry', 'late-remount'] as const)(
    'does not start restoration helpers after expiry at %s',
    async (boundary) => {
      let now = 0;
      const registry = new InvocationRegistry({ now: () => now, schedule: () => () => undefined });
      const io = captureIo();
      const cursor = vi.fn(() => Promise.resolve());
      const release = vi.fn(() => Promise.resolve());
      const remount = deferred<void>();
      const terminal = new WorkflowTerminal(
        registry,
        { ...io.io, stdoutIsTty: true, writeOutAcknowledged: cursor },
        () => undefined,
        vi.fn(),
      );
      terminal.createRenderer(() => ({ onEvent: () => undefined, releaseInput: release }));
      const entered =
        boundary === 'late-remount' ? terminal.runViewOperation(() => remount.promise) : undefined;
      void registry.terminate({ kind: 'signal', signalNumber: 15, deadline: 100 });
      if (boundary === 'late-remount') {
        await turn();
        expect(release).toHaveBeenCalledOnce();
        expect(cursor).toHaveBeenCalledOnce();
      }
      now = 100;
      let finished = false;
      void terminal.finish().then(() => {
        finished = true;
      });
      remount.resolve();
      await entered;
      await turn();
      expect(release, 'WORKFLOW_RESTORE_EXPIRY').toHaveBeenCalledTimes(
        boundary === 'late-remount' ? 1 : 0,
      );
      expect(cursor).toHaveBeenCalledTimes(boundary === 'late-remount' ? 1 : 0);
      expect(finished).toBe(false);
      expect(registry.activeOwners).toBe(1);
    },
  );
});

it('joins an already-entered asynchronous remount and re-releases its final input before retirement', async () => {
  const f = fixture();
  const remount = deferred<void>();
  const input = deferred<void>();
  let mounted = false;
  const release = vi.fn(() => (mounted ? input.promise : Promise.resolve()));
  f.terminal.createRenderer(() => ({ onEvent: () => undefined, releaseInput: release }));
  const entered = f.terminal.runViewOperation(() =>
    remount.promise.then(() => {
      mounted = true;
    }),
  );
  let finished = false;
  const done = f.terminal.finish().then(() => {
    finished = true;
  });
  await turn();
  expect(release).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  remount.resolve();
  await entered;
  await turn();
  expect(release).toHaveBeenCalledTimes(2);
  expect(finished).toBe(false);
  expect(f.registry.activeOwners).toBe(1);
  input.resolve();
  await done;
  expect(f.registry.activeOwners).toBe(0);
});
