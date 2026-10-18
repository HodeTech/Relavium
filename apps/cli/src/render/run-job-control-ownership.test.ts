import { describe, expect, it, vi } from 'vitest';
import { InvocationRegistry } from '../process/invocation-registry.js';
import { WorkflowTerminal } from '../commands/workflow-terminal.js';
import { captureIo } from '../test-support.js';
import { wireRunJobControl, type RunJobControl } from './run-job-control.js';

function fixture() {
  const registry = new InvocationRegistry({ now: () => 0, schedule: () => () => undefined });
  const terminal = new WorkflowTerminal(registry, captureIo().io, () => undefined, vi.fn());
  return { registry, terminal };
}

describe('job-control acquisition and actual native removal custody', () => {
  it.each(['write', 'detach'] as const)(
    'does not self-suspend after reentrant disposal inside %s',
    async (boundary) => {
      let suspend: () => void = () => undefined;
      const suspendSelf = vi.fn();
      const removed = vi.fn();
      const control = wireRunJobControl({
        write: () => {
          if (boundary === 'write') control.dispose();
        },
        lifecycle: {
          supported: true,
          onSuspend: (callback) => {
            suspend = callback;
            return () => {
              removed();
              if (boundary === 'detach') control.dispose();
            };
          },
          onContinue: () => () => undefined,
          suspendSelf,
        },
      });
      suspend();
      expect(suspendSelf, 'WORKFLOW_JOB_REENTRY_STOP').not.toHaveBeenCalled();
      await control.released;
      expect(removed).toHaveBeenCalled();
    },
  );
  it('pre-adopts before registration and never retires during reentrant stop inside registration', async () => {
    const f = fixture();
    let control: RunJobControl | undefined;
    let released = false;
    let suspend: () => void = () => undefined;
    const remove = vi.fn();
    const continueRegistration = vi.fn(() => () => undefined);
    f.terminal.createJobControl((adopt) =>
      wireRunJobControl({
        write: vi.fn(),
        adopt: (owner) => {
          control = owner;
          adopt(owner);
          void owner.released?.then(() => {
            released = true;
          });
        },
        lifecycle: {
          supported: true,
          onSuspend: (listener) => {
            suspend = listener;
            expect(control).toBeDefined();
            f.terminal.seal();
            expect(released).toBe(false);
            expect(f.registry.activeOwners).toBe(1);
            return remove;
          },
          onContinue: continueRegistration,
          suspendSelf: vi.fn(),
        },
      }),
    );
    await f.terminal.finish();
    expect(remove).toHaveBeenCalledOnce();
    expect(continueRegistration).not.toHaveBeenCalled();
    expect(released).toBe(true);
    expect(f.registry.activeOwners).toBe(0);
    suspend();
    expect(remove).toHaveBeenCalledOnce();
  });
  it('retains unknown acquisition after a throwing native registration while still removing the known sibling', async () => {
    const f = fixture();
    const remove = vi.fn();
    expect(() =>
      f.terminal.createJobControl((adopt) =>
        wireRunJobControl({
          write: vi.fn(),
          adopt,
          lifecycle: {
            supported: true,
            onSuspend: () => remove,
            onContinue: () => {
              throw new Error('PRIVATE_NATIVE_REGISTRATION');
            },
            suspendSelf: vi.fn(),
          },
        }),
      ),
    ).toThrow('PRIVATE_NATIVE_REGISTRATION');
    expect(remove).toHaveBeenCalledOnce();
    let finished = false;
    void f.terminal.finish().then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(f.registry.activeOwners).toBe(1);
    expect(remove).toHaveBeenCalledOnce();
  });
});
