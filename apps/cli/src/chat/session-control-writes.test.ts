import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionControlWrites } from './session-control-writes.js';
import { CliError } from '../process/cli-error.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
describe('captured session control delivery', () => {
  it('joins the actual callback independently of enqueue and rejects future writes after close', async () => {
    const f = invocationFixture();
    let deliver: () => void = () => undefined;
    const raw = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const write = vi.fn(() => raw);
    const controls = new SessionControlWrites({
      invocation: f.invocation,
      write,
      failure: vi.fn(),
    });
    expect(controls.write('synthetic control')).toBe(raw);
    let joined = false;
    const joining = controls.joinEntered().then(() => {
      joined = true;
    });
    const closing = controls.close();
    await turn();
    expect(joined, 'SESSION_CONTROL_DELIVERY_NOT_ENQUEUE').toBe(false);
    deliver();
    await joining;
    await closing;
    expect(() => controls.write('late')).toThrow();
    expect(write).toHaveBeenCalledOnce();
  });

  it('a throwing failure observer cannot create an unhandled rejection or lose the finite backstop', async () => {
    const f = invocationFixture();
    const cause = new CliError('output_unavailable', '');
    const controls = new SessionControlWrites({
      invocation: f.invocation,
      write: () => Promise.reject(cause),
      failure: () => {
        throw new Error('synthetic observer failure');
      },
    });
    await expect(controls.write('control')).rejects.toBe(cause);
    await controls.close();
    await turn();
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.budget.deadline()).toBe(3000);
  });
});
