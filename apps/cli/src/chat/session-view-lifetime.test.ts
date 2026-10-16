import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionWorkOwner } from './session-work-owner.js';
import { SessionViewLifetime } from './session-view-lifetime.js';

function fixture() {
  const f = invocationFixture();
  const cleanup = vi.fn(() => Promise.resolve());
  const owner = new SessionWorkOwner(f.invocation, 'home', { cancel: () => undefined, cleanup });
  return { ...f, owner, cleanup, view: new SessionViewLifetime(owner) };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('actual Home view retirement', () => {
  it('refuses construction after stop without transferring an unreachable empty lifetime', async () => {
    const f = fixture();
    f.owner.stop();
    expect(() => new SessionViewLifetime(f.owner)).toThrow('Session operation stopped.');
    await f.owner.close();
    expect(f.registry.activeOwners).toBe(0);
    expect(f.registry.observations.exitCode()).toBe(0);
  });
  it('releases each native view before the host database/persister tail can enter', async () => {
    const f = fixture();
    const source = new EventEmitter();
    const callback = vi.fn();
    f.view.acquire(() => {
      source.on('frame', callback);
      return () => {
        source.off('frame', callback);
      };
    });
    expect(source.listenerCount('frame')).toBe(1);
    await f.owner.close();
    expect(source.listenerCount('frame')).toBe(0);
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });

  it('joins registration reentry and removes a callback installed after stop was requested', async () => {
    const f = fixture();
    const source = new EventEmitter();
    const callback = vi.fn();
    source.once('newListener', () => f.owner.stop());
    expect(() =>
      f.view.acquire(() => {
        source.on('frame', callback);
        return () => {
          source.off('frame', callback);
        };
      }),
    ).toThrow('Session operation stopped.');
    await f.owner.close();
    expect(source.listenerCount('frame'), 'HOME_VIEW_REGISTRATION_REENTRY_JOIN').toBe(0);
    expect(f.registry.observations.exitCode()).toBe(0);
  });

  it('attempts sibling releases while a failed removal keeps the original owner unretired', async () => {
    const f = fixture();
    const cause = new Error('PRIVATE_VIEW_RELEASE');
    const sibling = vi.fn();
    f.view.acquire(() => () => {
      throw cause;
    });
    f.view.acquire(() => sibling);
    let retired = false;
    void f.owner.close().then(() => {
      retired = true;
    });
    await turn();
    expect(sibling).toHaveBeenCalledOnce();
    expect(retired).toBe(false);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    f.advance(3000);
    await turn();
    expect(f.exit).toHaveBeenCalledWith(9);
  });

  it('never treats a throwing subscription factory as proof of no allocation', async () => {
    const f = fixture();
    const source = new EventEmitter();
    expect(() =>
      f.view.acquire(() => {
        source.on('frame', vi.fn());
        throw new Error('PRIVATE_PARTIAL_SUBSCRIBE');
      }),
    ).toThrow('PRIVATE_PARTIAL_SUBSCRIBE');
    let released = false;
    void f.view.done.then(() => {
      released = true;
    });
    await turn();
    expect(released).toBe(false);
    expect(source.listenerCount('frame')).toBe(1);
    expect(f.registry.observations.exitCode()).toBe(9);
    source.removeAllListeners();
  });
});
