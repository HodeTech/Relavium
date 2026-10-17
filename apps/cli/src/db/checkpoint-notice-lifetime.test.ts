import { WorkflowLifetime } from '../commands/workflow-lifetime.js';
import { captureIo } from '../test-support.js';
import { expect, it } from 'vitest';
import { deliverCheckpointNotice } from './checkpoint-notice.js';
import { invocationFixture } from '../process/invocation.test-support.js';
const tick = () => new Promise<void>((r) => setImmediate(r));
const hold = () => {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
it('seals original admission before direct synchronous sink refusal returns', async () => {
  const f = invocationFixture();
  const cause = new Error('synthetic sync notice sink');
  const raw = deliverCheckpointNotice(
    () => {
      throw cause;
    },
    'fixed notice',
    f.invocation,
  );
  expect(f.registry.termination).toBeDefined();
  expect(() => f.registry.assertAdmitting()).toThrow();
  await Promise.resolve(raw).catch(() => undefined);
  await f.registry.termination;
  expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
  expect(f.registry.activeOwners).toBe(0);
});
it('normal termination waits actual held delivery and retires once after ACK', async () => {
  const f = invocationFixture();
  const h = hold();
  let writes = 0;
  const raw = deliverCheckpointNotice(
    () => {
      writes++;
      return h.promise;
    },
    'fixed notice',
    f.invocation,
  );
  const done = f.registry.terminate({ kind: 'normal' });
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  await tick();
  expect(writes).toBe(1);
  expect(settled).toBe(false);
  expect(f.registry.activeOwners).toBe(1);
  h.release();
  await raw;
  expect(await done).toEqual({ kind: 'settled', unacknowledgedOwners: 0 });
  expect(f.registry.activeOwners).toBe(0);
});
it('reentrant normal stop cannot retire a raw write still on the stack', async () => {
  const f = invocationFixture();
  const h = hold();
  const raw = deliverCheckpointNotice(
    () => {
      void f.registry.terminate({ kind: 'normal' });
      return h.promise;
    },
    'fixed notice',
    f.invocation,
  );
  await tick();
  expect(f.registry.activeOwners).toBe(1);
  h.release();
  await raw;
  await f.registry.termination;
  expect(f.registry.activeOwners).toBe(0);
});
it('fatal deadline is no delivery/native ACK and later raw fulfillment cannot fabricate timely retirement', async () => {
  const f = invocationFixture();
  const h = hold();
  const raw = deliverCheckpointNotice(() => h.promise, 'fixed notice', f.invocation);
  f.invocation.finiteExit.fail('cli_internal');
  f.advance(3000);
  expect(await f.invocation.finiteExit.exited).toBe(9);
  expect(f.registry.activeOwners).toBe(1);
  h.release();
  await raw;
  await tick();
  expect(f.registry.activeOwners).toBe(1);
});
it('asynchronous sink rejection is observed at its actual settlement with no lost raw join', async () => {
  const f = invocationFixture();
  let reject: (cause: Error) => void = () => {};
  const p = new Promise<void>((_r, no) => {
    reject = no;
  });
  const raw = deliverCheckpointNotice(() => p, 'fixed notice', f.invocation);
  expect(f.registry.termination).toBeUndefined();
  reject(new Error('synthetic async sink'));
  await Promise.resolve(raw).catch(() => undefined);
  await f.registry.termination;
  expect(f.registry.observations.infrastructureCode()).toBe('output_unavailable');
  expect(f.registry.activeOwners).toBe(0);
});
it('ownerless compatibility preserves exact Promise and synchronous throwable', async () => {
  const h = hold();
  expect(deliverCheckpointNotice(() => h.promise, 'fixed notice', undefined)).toBe(h.promise);
  h.release();
  await h.promise;
  const cause = new Error('synthetic ownerless failure');
  let observed: unknown;
  try {
    void deliverCheckpointNotice(
      () => {
        throw cause;
      },
      'fixed notice',
      undefined,
    );
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(cause);
});

it.each([8, 7, 5, 6] as const)(
  'published workflow health %s outranks checkpoint output failure',
  async (health) => {
    const f = invocationFixture();
    const lifetime = new WorkflowLifetime(f.invocation, captureIo().io, () => () => {});
    const result = await lifetime.execute(() => {
      lifetime.publish(health, true);
      const raw = deliverCheckpointNotice(
        () => {
          throw new Error('synthetic notice refusal');
        },
        'fixed notice',
        f.invocation,
      );
      void Promise.resolve(raw).catch(() => undefined);
      expect(f.registry.termination).toBeDefined();
      return Promise.resolve(0);
    });
    expect(result).toBe(health);
    expect(f.registry.observations.exitCode()).toBe(health);
    expect(f.registry.activeOwners).toBe(0);
  },
);
it('already stopped invocation creates no writer or retained notice owner', async () => {
  const f = invocationFixture();
  await f.registry.terminate({ kind: 'normal' });
  let writes = 0;
  expect(() =>
    deliverCheckpointNotice(
      () => {
        writes++;
      },
      'fixed notice',
      f.invocation,
    ),
  ).toThrow();
  expect(writes).toBe(0);
  expect(f.registry.activeOwners).toBe(0);
});
