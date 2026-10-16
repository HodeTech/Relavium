import { describe, expect, it, vi } from 'vitest';

import { createFileCatalogSeed } from './file-catalog-seed.js';

describe('invocation-owned file catalog seed (ADR-0111)', () => {
  it('does no work at construction and shares completion across concurrent and later callers', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(() => pending);
    const seed = createFileCatalogSeed(load);
    expect(load).not.toHaveBeenCalled();

    const first = seed();
    const concurrent = seed();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    let completed = false;
    void concurrent.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await first;
    expect(completed).toBe(true);
    expect(seed()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('latches before a loader synchronously reenters the same owner', async () => {
    let reentered: Promise<void> | undefined;
    const load = vi.fn(() => {
      reentered = seed();
    });
    const seed = createFileCatalogSeed(load);
    const first = seed();
    await first;
    expect(reentered).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'reject'] as const)('a %s is total and remains attempted', async (failure) => {
    const load = vi.fn(() => {
      if (failure === 'throw') throw new Error('optional cache unavailable');
      return Promise.reject(new Error('optional cache import unavailable'));
    });
    const seed = createFileCatalogSeed(load);
    const first = seed();
    await expect(first).resolves.toBeUndefined();
    await expect(seed()).resolves.toBeUndefined();
    expect(seed()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('independent invocation owners each attempt the same loader once', async () => {
    const load = vi.fn(() => undefined);
    const first = createFileCatalogSeed(load);
    const second = createFileCatalogSeed(load);
    await Promise.all([first(), first(), second(), second()]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('createCliInvocation binds one lazy loader and registry per invocation', async () => {
    vi.resetModules();
    const load = vi.fn(() => undefined);
    const imported = vi.fn(() => ({ seedFileCatalog: load }));
    vi.doMock('../engine/catalog-seed.js', imported);
    try {
      const { createCliInvocation } = await import('./invocation.js');
      const first = createCliInvocation();
      const second = createCliInvocation();
      expect(first.registry).not.toBe(second.registry);
      expect(imported).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      const firstAttempt = first.seedFileCatalogOnce();
      expect(first.seedFileCatalogOnce()).toBe(firstAttempt);
      await firstAttempt;
      await first.seedFileCatalogOnce();
      expect(imported).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      await second.seedFileCatalogOnce();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('../engine/catalog-seed.js');
      vi.resetModules();
    }
  });
});
