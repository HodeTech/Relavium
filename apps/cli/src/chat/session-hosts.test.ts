import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../config/resolve.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { buildChatSession } from './session-host.js';
import { SessionHosts } from './session-hosts.js';
import { SessionSurfaceLifetime } from './session-surface-lifetime.js';
import { scriptedResolver, textTurn } from './test-support.js';

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const reactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const f = invocationFixture();
  const surface = new SessionSurfaceLifetime(f.invocation, 'home', () => () => undefined);
  return { ...f, surface, hosts: new SessionHosts(surface, 'home') };
}

const options = () => ({
  chat: resolveConfig({}).chat,
  agentRef: undefined,
  cwd: '/tmp',
  projectConfigDir: undefined,
  now: () => 0,
  uuid: () => 'equal-session-id',
  disableMcp: true,
  providers: scriptedResolver([textTurn('synthetic')]),
});

describe('actual host instance collection, independent of UI selection', () => {
  it('registers before construction and joins both equal-id hosts without retaining completed history', async () => {
    const f = fixture();
    const closes: ReturnType<typeof vi.fn>[] = [];
    const built = [];
    for (let index = 0; index < 2; index++) {
      const close = vi.fn(async () => {});
      closes.push(close);
      built.push(
        await f.hosts.construct((owner) => {
          expect(f.registry.activeOwners).toBe(index + 2);
          return owner.build(async (workOwner) => ({
            ...(await buildChatSession({ ...options(), workOwner })),
            closeMcp: close,
          }));
        }),
      );
    }
    expect(built[0]?.sessionId).toBe(built[1]?.sessionId);
    expect(built[0]?.hostOwner).not.toBe(built[1]?.hostOwner);
    await built[0]?.hostOwner?.work.close();
    await reactions();
    expect(f.registry.activeOwners).toBe(2);
    const closing = f.hosts.close();
    expect(f.hosts.close()).toBe(closing);
    await closing;
    await f.surface.work.close();
    await reactions();
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1]);
    expect(f.registry.activeOwners).toBe(0);
    expect(f.exit).not.toHaveBeenCalled();
  });

  it('holds superseded builders and every late MCP cleanup until actual acknowledgement', async () => {
    const f = fixture();
    const construction = [gate(), gate()];
    const cleanup = [gate(), gate()];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const opening = construction.map((ready, index) =>
      f.hosts
        .construct((owner) =>
          owner.build(async (workOwner) => {
            const built = await buildChatSession({ ...options(), workOwner });
            const close = vi.fn(
              () => cleanup[index]?.promise ?? Promise.reject(new Error('missing fixture gate')),
            );
            closes.push(close);
            await ready.promise;
            return { ...built, closeMcp: close };
          }),
        )
        .catch((cause: unknown) => cause),
    );
    let acknowledged = false;
    const closing = f.hosts.close();
    void closing.then(() => {
      acknowledged = true;
    });
    for (const ready of construction) ready.release();
    await reactions();
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1]);
    expect(f.registry.activeOwners, 'SESSION_ALL_LATE_INSTANCES_RETAIN_NATIVE_CLOSE').toBe(3);
    expect(acknowledged).toBe(false);
    cleanup[0]?.release();
    await reactions();
    expect(acknowledged).toBe(false);
    cleanup[1]?.release();
    await closing;
    const results = await Promise.all(opening);
    expect(results.every((result) => result instanceof Error)).toBe(true);
    await f.surface.work.close();
    await reactions();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.registry.observations.exitCode()).toBe(0);
  });

  it('reports post-build setup failure before held cleanup rather than waiting on its own root', async () => {
    const f = fixture();
    const cleanup = gate();
    const close = vi.fn(() => cleanup.promise);
    const cause = new Error('PRIVATE_POST_BUILD_FAILURE');
    const opening = f.hosts
      .construct(async (owner) => {
        await owner.build(async (workOwner) => ({
          ...(await buildChatSession({ ...options(), workOwner })),
          closeMcp: close,
        }));
        throw cause;
      })
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(f.registry.observations.exitCode()).toBe(9);
      expect(f.registry.budget.deadline(), 'SESSION_POST_BUILD_FAILURE_PRECEDES_CLEANUP_JOIN').toBe(
        3000,
      );
      expect(f.registry.activeOwners).toBe(1);
    } finally {
      cleanup.release();
    }
    expect(await opening).toBe(cause);
    await f.hosts.close();
    f.advance(3000);
    await reactions();
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(9);
    expect(f.registry.activeOwners).toBe(0);
  });

  it('refuses future construction after closing without entering its factory', async () => {
    const f = fixture();
    await f.hosts.close();
    const factory = vi.fn(() => Promise.resolve());
    await expect(f.hosts.construct(factory)).rejects.toMatchObject({ code: 'cli_internal' });
    expect(factory).not.toHaveBeenCalled();
    await f.surface.work.close();
  });
});
