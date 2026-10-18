import { describe, expect, it, vi } from 'vitest';
import { CliError } from './cli-error.js';
import { invocationFixture } from './invocation.test-support.js';
import { withSynchronousResource } from './synchronous-resource.js';

const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('transient synchronous resource custody', () => {
  it('keeps the acquired close capability when a caller changes the returned container', async () => {
    const f = invocationFixture();
    const close = vi.fn();
    const foreign = vi.fn();
    const resource = { close };
    withSynchronousResource(
      f.invocation,
      () => resource,
      (opened) => {
        Object.defineProperty(opened, 'close', { value: foreign });
      },
    );
    expect(close).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
  });
  it('registers before acquisition and closes synchronously before the next resource opens', async () => {
    const f = invocationFixture();
    const order: string[] = [];
    const result = withSynchronousResource(
      f.invocation,
      () => {
        expect(f.registry.activeOwners).toBe(1);
        order.push('open');
        return {
          close: () => {
            order.push('close');
          },
          value: 42,
        };
      },
      ({ value }) => {
        order.push('read');
        return value;
      },
    );
    order.push('next-open');
    expect(result).toBe(42);
    expect(order).toEqual(['open', 'read', 'close', 'next-open']);
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('retains a throwing native close and its exact capability without retry or false retirement', async () => {
    const f = invocationFixture();
    const close = vi.fn(() => {
      throw new Error('PRIVATE_TRANSIENT_CLOSE');
    });
    expect(() =>
      withSynchronousResource(
        f.invocation,
        () => ({ close }),
        () => 42,
      ),
    ).toThrow(CliError);
    await reactions();
    expect(f.registry.activeOwners, 'TRANSIENT_CLOSE_THROW_IS_NOT_RETIREMENT').toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(close).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(1);
  });

  it('preserves the primary refusal while a failed release adds stronger infrastructure uncertainty', async () => {
    const f = invocationFixture();
    const refusal = new CliError('invalid_invocation', 'known refusal');
    expect(() =>
      withSynchronousResource(
        f.invocation,
        () => ({
          close: () => {
            throw new Error('close');
          },
        }),
        () => {
          throw refusal;
        },
      ),
    ).toThrow(refusal);
    await reactions();
    expect(f.registry.observations.exitCode()).toBe(9);
    expect(f.registry.activeOwners).toBe(1);
  });

  it('cannot reentrantly close an active synchronous query', async () => {
    const f = invocationFixture();
    const close = vi.fn();
    expect(
      withSynchronousResource(
        f.invocation,
        () => ({ close }),
        () => {
          f.invocation.finiteExit.fail('cli_internal');
          expect(close).not.toHaveBeenCalled();
          return 'query completed';
        },
      ),
    ).toBe('query completed');
    expect(close).toHaveBeenCalledOnce();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('distinguishes a trusted cleaned-up refusal from unknown partial acquisition', async () => {
    for (const unknown of [false, true]) {
      const f = invocationFixture();
      const cause = unknown
        ? new Error('PRIVATE_ACQUIRE')
        : new CliError('storage_unavailable', '');
      const use = vi.fn(() => undefined);
      expect(() =>
        withSynchronousResource(
          f.invocation,
          () => {
            throw cause;
          },
          use,
        ),
      ).toThrow(cause);
      await reactions();
      expect(use).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(unknown ? 1 : 0);
      expect(f.registry.observations.hasInfrastructureFailure()).toBe(unknown);
    }
  });
});
