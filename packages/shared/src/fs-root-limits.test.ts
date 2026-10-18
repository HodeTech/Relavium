import { describe, expect, it } from 'vitest';

import { FS_ROOT_LIMITS as compatibilityLimits, ProjectConfigSchema } from './config.js';
import { FS_ROOT_LIMITS } from './fs-root-limits.js';

describe('pure filesystem limit leaf compatibility', () => {
  it('preserves the exact frozen config re-export identity', () => {
    expect(compatibilityLimits).toBe(FS_ROOT_LIMITS);
    expect(Object.isFrozen(FS_ROOT_LIMITS)).toBe(true);
  });

  it('preserves existing selector admission at the real schema boundary', () => {
    const selectors = Array.from({ length: 16 }, (_, index) => `root-${index}`);
    expect(
      ProjectConfigSchema.parse({ chat: { extra_roots: selectors } }).chat?.extra_roots,
    ).toEqual(selectors);
    expect(
      ProjectConfigSchema.safeParse({ chat: { extra_roots: [...selectors, 'overflow'] } }).success,
    ).toBe(false);
    expect(
      ProjectConfigSchema.safeParse({ chat: { extra_roots: ['x'.repeat(4096)] } }).success,
    ).toBe(true);
    expect(
      ProjectConfigSchema.safeParse({ chat: { extra_roots: ['x'.repeat(4097)] } }).success,
    ).toBe(false);
  });
});
