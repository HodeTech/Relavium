import { expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { captureIo } from '../test-support.js';
import { CliError } from './cli-error.js';
import { invocationFixture } from './invocation.test-support.js';
import { ownNotification } from './owned-notification.js';

it('keeps exact arguments and seals before the actual owner reenters during failure cancellation', async () => {
  const f = invocationFixture();
  let notify: (model: string, amount: number, modalities?: readonly string[]) => void = () => {};
  const owner = new SessionWorkOwner(f.invocation, 'chat', {
    cancel: () => notify('must not enter after original sink failed', 1),
    cleanup: () => Promise.resolve(),
  });
  const modalities = Object.freeze(['audio']);
  const cause = new TypeError('PRIVATE_NOTIFICATION_FORMATTER_FAULT');
  const consume = vi.fn((model: string, amount: number, supplied?: readonly string[]) => {
    expect(model).toBe('synthetic');
    expect(amount).toBe(0);
    expect(supplied).toBe(modalities);
    throw cause;
  });
  notify = ownNotification(owner, consume);
  try {
    expect(() => notify('synthetic', 0, modalities)).not.toThrow();
    notify('must not enter late', 2);
    expect(consume).toHaveBeenCalledOnce();
    expect(owner.firstFailure?.cause).toBe(cause);
    expect(f.registry.observations.exitCode()).toBe(9);
  } finally {
    await owner.close();
  }
  expect(f.registry.activeOwners).toBe(0);
});

it.each([8, 7, 5, 6] as const)(
  'observed workflow health %s survives a passively recovered notification failure',
  async (health) => {
    const f = invocationFixture();
    const lifetime = new WorkflowLifetime(f.invocation, captureIo().io, () => () => {});
    const cause = new CliError('output_unavailable', '');
    const consume = vi.fn(() => {
      throw cause;
    });
    const notify = lifetime.notification(consume);
    const result = await lifetime.execute(() => {
      lifetime.publish(health, true);
      notify();
      notify();
      return Promise.resolve(0);
    });
    expect(result).toBe(health);
    expect(consume).toHaveBeenCalledOnce();
    expect(f.registry.observations.exitCode()).toBe(health);
    expect(f.registry.termination).toBeDefined();
    expect(f.registry.activeOwners).toBe(0);
  },
);
